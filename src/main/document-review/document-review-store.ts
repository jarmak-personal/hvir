import { randomUUID } from 'node:crypto'

import {
  basenameHostPath,
  dirnameHostPath,
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
  sameReviewWorkspace,
  type StoredReviewFile,
  type StoredReviewWorkspace,
} from './document-review-store-codec'

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

  private constructor(
    private readonly host: ProjectHost,
    private readonly file: ReturnType<typeof hostPath>,
    workspaces: readonly StoredReviewWorkspace[],
    private readonly loadNotice?: DocumentReviewStoreNotice,
  ) {
    for (const workspace of workspaces) {
      this.workspaces.set(reviewWorkspaceKey(workspace.model.workspace), workspace)
    }
  }

  static async load(host: ProjectHost, file: ReturnType<typeof hostPath>) {
    let content: string | undefined
    try {
      const workload = await host.readTextFilePrefix(file, MAX_STORED_FILE_BYTES)
      if (!workload.complete) {
        return this.recover(host, file, 'corrupt')
      }
      content = workload.content
    } catch (reason) {
      if (isMissingFile(reason)) return new DocumentReviewStore(host, file, [])
      return new DocumentReviewStore(host, file, [], {
        kind: 'corrupt',
        writeBlocked: true,
      })
    }

    let value: unknown
    try {
      value = JSON.parse(content)
    } catch {
      return this.recover(host, file, 'corrupt')
    }
    if (isRecord(value) && isFutureReviewVersion(value['version'])) {
      return this.recover(host, file, 'future-version')
    }
    const parsed = parseStoredReviewFile(value)
    return parsed
      ? new DocumentReviewStore(host, file, parsed.workspaces)
      : this.recover(host, file, 'corrupt')
  }

  private static async recover(
    host: ProjectHost,
    file: ReturnType<typeof hostPath>,
    kind: DocumentReviewStoreNotice['kind'],
  ): Promise<DocumentReviewStore> {
    const recoveryFile = recoveryFileName(file)
    const destination = joinHostPath(dirnameHostPath(file), recoveryFile)
    try {
      const transfer = host.fileTransfer
      if (!transfer) throw new Error('Review recovery needs atomic rename support')
      await transfer.renameNoReplace(file, destination)
      return new DocumentReviewStore(host, file, [], {
        kind,
        recoveryFile,
        writeBlocked: false,
      })
    } catch {
      return new DocumentReviewStore(host, file, [], { kind, writeBlocked: true })
    }
  }

  notice(): DocumentReviewStoreNotice | undefined {
    return this.loadNotice
  }

  read(workspace: ReviewWorkspaceIdentity): StoredDocumentReviewWorkspace {
    assertReviewWorkspace(workspace)
    const stored = this.workspaces.get(reviewWorkspaceKey(workspace))
    if (stored && !sameReviewWorkspace(stored.model.workspace, workspace)) {
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
    const current = this.workspaces.get(key)
    if (current && !sameReviewWorkspace(current.model.workspace, parsed.workspace)) {
      throw new Error('Review workspace identity collides with another workspace')
    }
    const revision = current?.revision ?? 0
    if (expectedRevision !== revision) {
      throw new Error('Document review changed in another renderer generation')
    }
    if (!current && this.workspaces.size >= MAX_STORED_REVIEW_WORKSPACES) {
      throw new Error('The stored document-review workspace limit was reached')
    }

    const stored = { revision: revision + 1, model: cloneReviewModel(parsed) }
    this.workspaces.set(key, stored)
    const persisted = this.persist()
    return persisted.then(() => ({
      revision: stored.revision,
      model: cloneReviewModel(stored.model),
    }))
  }

  flush(): Promise<void> {
    return this.pendingWrite
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

  private persist(): Promise<void> {
    const snapshot: StoredReviewFile = {
      version: DOCUMENT_REVIEW_FILE_VERSION,
      workspaces: [...this.workspaces.values()].map((workspace) => ({
        revision: workspace.revision,
        model: cloneReviewModel(workspace.model),
      })),
    }
    const serialized = JSON.stringify(snapshot, null, 2)
    if (Buffer.byteLength(serialized, 'utf8') > MAX_STORED_FILE_BYTES) {
      throw new Error('The document-review store exceeds its bounded envelope')
    }
    const write = this.pendingWrite
      .catch(() => undefined)
      .then(() => {
        this.disposal.signal.throwIfAborted()
        return this.host.writeFile(this.file, serialized, {
          signal: this.disposal.signal,
        })
      })
    this.pendingWrite = write
    return write
  }
}

function recoveryFileName(file: ReturnType<typeof hostPath>): string {
  return `${basenameHostPath(file)}.recovery-${Date.now()}-${randomUUID()}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMissingFile(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    value.code === 'ENOENT'
  )
}
