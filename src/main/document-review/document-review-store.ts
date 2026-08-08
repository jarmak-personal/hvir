import { randomUUID } from 'node:crypto'

import {
  basenameHostPath,
  dirnameHostPath,
  documentReviewWorkspaceEquals,
  hostPath,
  joinHostPath,
  type DocumentReviewModel,
  type DocumentReviewStoreNotice,
  type ReviewWorkspaceIdentity,
} from '../../shared'
import type { ProjectHost } from '../project-host'
import {
  DOCUMENT_REVIEW_FILE_VERSION,
  MAX_STORED_REVIEW_WORKSPACES,
  assertReviewWorkspace,
  cloneReviewModel,
  isFutureReviewVersion,
  parseReviewModel,
  parseStoredReviewFile,
  reviewWorkspaceKey,
  type StoredReviewFile,
  type StoredReviewWorkspace,
} from './document-review-store-codec'
import { isDocumentReviewRecord } from './document-review-policy'
import {
  expireDocumentReviewDrafts,
  reconcileDocumentReviewDraftActivity,
} from './document-review-retention'

const MAX_STORED_FILE_BYTES = 8 * 1024 * 1024
const DEFAULT_DISPOSE_TIMEOUT_MS = 2_000

export interface StoredDocumentReviewWorkspace {
  readonly revision: number
  readonly model: DocumentReviewModel
}

/** Specialized durable owner for user-authored document-review state. */
export class DocumentReviewStore {
  private readonly workspaces = new Map<string, StoredReviewWorkspace>()
  private pendingWrite: Promise<void> = Promise.resolve()
  private readonly disposal = new AbortController()
  private disposeTask?: Promise<void>
  private retryTask?: Promise<void>
  private needsMigration: boolean

  private constructor(
    private readonly host: ProjectHost,
    private readonly file: ReturnType<typeof hostPath>,
    workspaces: readonly StoredReviewWorkspace[],
    private loadNotice?: DocumentReviewStoreNotice,
    needsMigration = false,
    private readonly now: () => number = Date.now,
  ) {
    this.needsMigration = needsMigration
    for (const workspace of workspaces) {
      this.workspaces.set(reviewWorkspaceKey(workspace.model.workspace), workspace)
    }
  }

  static async load(
    host: ProjectHost,
    file: ReturnType<typeof hostPath>,
    now: () => number = Date.now,
  ) {
    let content: string | undefined
    try {
      const workload = await host.readTextFilePrefix(file, MAX_STORED_FILE_BYTES)
      if (!workload.complete) {
        return this.recover(host, file, 'corrupt', now)
      }
      content = workload.content
    } catch (reason) {
      if (isMissingFile(reason))
        return new DocumentReviewStore(host, file, [], undefined, false, now)
      return new DocumentReviewStore(
        host,
        file,
        [],
        {
          kind: 'read-failure',
          writeBlocked: true,
        },
        false,
        now,
      )
    }

    let value: unknown
    try {
      value = JSON.parse(content)
    } catch {
      return this.recover(host, file, 'corrupt', now)
    }
    if (isDocumentReviewRecord(value) && isFutureReviewVersion(value['version'])) {
      return this.recover(host, file, 'future-version', now)
    }
    const parsed = parseStoredReviewFile(value, now())
    if (!parsed) return this.recover(host, file, 'corrupt', now)
    const store = new DocumentReviewStore(
      host,
      file,
      parsed.workspaces,
      undefined,
      parsed.migrated,
      now,
    )
    await store.sweepExpiredDrafts().catch(() => undefined)
    return store
  }

  private static async recover(
    host: ProjectHost,
    file: ReturnType<typeof hostPath>,
    kind: 'corrupt' | 'future-version',
    now: () => number,
  ): Promise<DocumentReviewStore> {
    const recoveryFile = recoveryFileName(file)
    const destination = joinHostPath(dirnameHostPath(file), recoveryFile)
    try {
      const transfer = host.fileTransfer
      if (!transfer) throw new Error('Review recovery needs atomic rename support')
      await transfer.renameNoReplace(file, destination)
      return new DocumentReviewStore(
        host,
        file,
        [],
        {
          kind,
          recoveryFile,
          writeBlocked: false,
        },
        false,
        now,
      )
    } catch {
      return new DocumentReviewStore(
        host,
        file,
        [],
        { kind, writeBlocked: true },
        false,
        now,
      )
    }
  }

  notice(): DocumentReviewStoreNotice | undefined {
    return this.loadNotice
  }

  retryLoad(): Promise<void> {
    if (this.loadNotice?.kind !== 'read-failure') return Promise.resolve()
    this.retryTask ??= this.replaceFromRetry().finally(() => {
      this.retryTask = undefined
    })
    return this.retryTask
  }

  read(workspace: ReviewWorkspaceIdentity): StoredDocumentReviewWorkspace {
    assertReviewWorkspace(workspace)
    const stored = this.workspaces.get(reviewWorkspaceKey(workspace))
    if (stored && !documentReviewWorkspaceEquals(stored.model.workspace, workspace)) {
      throw new Error('Review workspace identity collides with another workspace')
    }
    return stored
      ? { revision: stored.revision, model: cloneReviewModel(stored.model) }
      : { revision: 0, model: { workspace, comments: [], batches: [] } }
  }

  save(
    expectedRevision: number,
    model: DocumentReviewModel,
  ): Promise<StoredDocumentReviewWorkspace> {
    this.assertWritable()
    const parsed = parseReviewModel(model)
    if (!parsed) throw new Error('Invalid bounded document-review model')
    const key = reviewWorkspaceKey(parsed.workspace)
    const operation = this.pendingWrite
      .catch(() => undefined)
      .then(async () => {
        this.assertWritable()
        const current = this.workspaces.get(key)
        if (
          current &&
          !documentReviewWorkspaceEquals(current.model.workspace, parsed.workspace)
        ) {
          throw new Error('Review workspace identity collides with another workspace')
        }
        const revision = current?.revision ?? 0
        if (expectedRevision !== revision) {
          throw new Error('Document review changed in another renderer generation')
        }
        if (!current && this.workspaces.size >= MAX_STORED_REVIEW_WORKSPACES) {
          throw new Error('The stored document-review workspace limit was reached')
        }

        const stored = {
          revision: revision + 1,
          model: cloneReviewModel(parsed),
          draftActivity: reconcileDocumentReviewDraftActivity(
            current,
            parsed,
            this.now(),
          ),
        }
        const serialized = this.serializeCandidate(key, stored)
        this.disposal.signal.throwIfAborted()
        await this.host.writeFile(this.file, serialized, {
          signal: this.disposal.signal,
        })
        this.workspaces.set(key, stored)
        this.needsMigration = false
        return {
          revision: stored.revision,
          model: cloneReviewModel(stored.model),
        }
      })
    this.pendingWrite = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  flush(): Promise<void> {
    return this.pendingWrite
  }

  sweepExpiredDrafts(
    excludedWorkspaces: readonly ReviewWorkspaceIdentity[] = [],
  ): Promise<void> {
    const exclusions = new Map(
      excludedWorkspaces.map((workspace) => {
        assertReviewWorkspace(workspace)
        return [reviewWorkspaceKey(workspace), workspace] as const
      }),
    )
    const operation = this.pendingWrite
      .catch(() => undefined)
      .then(async () => {
        this.assertWritable()
        const now = this.now()
        let changed = this.needsMigration
        const workspaces = new Map<string, StoredReviewWorkspace>()
        for (const [key, workspace] of this.workspaces) {
          const exclusion = exclusions.get(key)
          if (
            exclusion &&
            documentReviewWorkspaceEquals(exclusion, workspace.model.workspace)
          ) {
            workspaces.set(key, workspace)
            continue
          }
          const expired = expireDocumentReviewDrafts(
            workspace.model,
            workspace.draftActivity,
            now,
          )
          changed ||= expired.changed
          workspaces.set(key, {
            revision: workspace.revision + (expired.changed ? 1 : 0),
            model: cloneReviewModel(expired.model),
            draftActivity: expired.draftActivity,
          })
        }
        if (!changed) return
        const serialized = this.serializeWorkspaces(workspaces)
        this.disposal.signal.throwIfAborted()
        await this.host.writeFile(this.file, serialized, {
          signal: this.disposal.signal,
        })
        this.workspaces.clear()
        for (const [key, workspace] of workspaces) this.workspaces.set(key, workspace)
        this.needsMigration = false
      })
    this.pendingWrite = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  dispose(timeoutMs = DEFAULT_DISPOSE_TIMEOUT_MS): Promise<void> {
    this.disposeTask ??= this.disposeWithin(timeoutMs)
    return this.disposeTask
  }

  private async disposeWithin(timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.pendingWrite,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
      this.disposal.abort()
      void this.pendingWrite.catch(() => undefined)
    }
  }

  private assertWritable(): void {
    if (this.disposal.signal.aborted) throw new Error('Document review store is disposed')
    if (this.loadNotice?.writeBlocked) {
      throw new Error('Recover the preserved document-review file before saving')
    }
  }

  private serializeCandidate(key: string, candidate: StoredReviewWorkspace): string {
    const workspaces = new Map(this.workspaces)
    workspaces.set(key, candidate)
    return this.serializeWorkspaces(workspaces)
  }

  private serializeWorkspaces(
    workspaces: ReadonlyMap<string, StoredReviewWorkspace>,
  ): string {
    const snapshot: StoredReviewFile = {
      version: DOCUMENT_REVIEW_FILE_VERSION,
      workspaces: [...workspaces.values()].map((workspace) => ({
        revision: workspace.revision,
        model: cloneReviewModel(workspace.model),
        draftActivity: workspace.draftActivity,
      })),
    }
    const serialized = JSON.stringify(snapshot, null, 2)
    if (Buffer.byteLength(serialized, 'utf8') > MAX_STORED_FILE_BYTES) {
      throw new Error('The document-review store exceeds its bounded envelope')
    }
    return serialized
  }

  private async replaceFromRetry(): Promise<void> {
    const retried = await DocumentReviewStore.load(this.host, this.file, this.now)
    if (retried.loadNotice?.kind === 'read-failure') return
    this.workspaces.clear()
    for (const [key, workspace] of retried.workspaces) {
      this.workspaces.set(key, workspace)
    }
    this.loadNotice = retried.loadNotice
    this.needsMigration = retried.needsMigration
  }
}

function recoveryFileName(file: ReturnType<typeof hostPath>): string {
  return `${basenameHostPath(file)}.recovery-${Date.now()}-${randomUUID()}`
}

function isMissingFile(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    value.code === 'ENOENT'
  )
}
