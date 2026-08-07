import {
  hostPathEquals,
  type DocumentReviewRevalidation,
  type DocumentReviewStoreNotice,
  type DocumentReviewWorkspaceSnapshot,
  type HostPath,
  type ReviewWorkspaceIdentity,
  type WatchEvent,
} from '../../../shared'
import {
  applyDocumentReviewAction,
  createDocumentReviewModel,
} from './document-review-model'
import type {
  DocumentReviewAction,
  DocumentReviewActionResult,
  DocumentReviewModel,
} from './document-review-types'
import { reviewWorkspaceEquals } from './document-review-validation'

export interface DocumentReviewWorkspacePort {
  restore(workspace: ReviewWorkspaceIdentity): Promise<DocumentReviewWorkspaceSnapshot>
  save(request: {
    readonly workspace: ReviewWorkspaceIdentity
    readonly workspaceGeneration: number
    readonly expectedRevision: number
    readonly model: DocumentReviewModel
  }): Promise<DocumentReviewWorkspaceSnapshot>
  revalidate(request: {
    readonly workspace: ReviewWorkspaceIdentity
    readonly workspaceGeneration: number
    readonly document: HostPath
  }): Promise<DocumentReviewRevalidation>
}

export interface DocumentReviewWorkspaceState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly localGeneration: number
  readonly workspace?: ReviewWorkspaceIdentity
  readonly workspaceGeneration?: number
  readonly revision: number
  readonly model?: DocumentReviewModel
  readonly notice?: DocumentReviewStoreNotice
  readonly error?: string
}

/** Renderer effect owner for restore, serialized writes, watch reads, and revocation. */
export class DocumentReviewWorkspaceController {
  private state: DocumentReviewWorkspaceState = {
    status: 'idle',
    localGeneration: 0,
    revision: 0,
  }
  private saveTail: Promise<void> = Promise.resolve()
  private readonly saveQueue: Array<() => Promise<void>> = []
  private readonly saveRevisions = new Map<number, number>()
  private readonly readGenerations = new Map<string, number>()
  private closing = false
  private disposed = false

  constructor(
    private readonly port: DocumentReviewWorkspacePort,
    private readonly publish: (state: DocumentReviewWorkspaceState) => void,
  ) {}

  snapshot(): DocumentReviewWorkspaceState {
    return this.state
  }

  activate(workspace: ReviewWorkspaceIdentity): void {
    if (this.disposed || this.closing) return
    const previousGeneration = this.state.localGeneration
    const pendingSaves = this.saveTail
    const localGeneration = this.state.localGeneration + 1
    this.readGenerations.clear()
    const empty = createDocumentReviewModel(workspace)
    if (!empty.ok) {
      this.setState({
        status: 'error',
        localGeneration,
        workspace,
        revision: 0,
        error: empty.error.message,
      })
      return
    }
    this.setState({
      status: 'loading',
      localGeneration,
      workspace,
      revision: 0,
      model: empty.value,
    })
    void pendingSaves
      .then(
        () => this.port.restore(workspace),
        () => this.port.restore(workspace),
      )
      .then(
        (restored) => {
          if (!this.isLocalGeneration(localGeneration, workspace)) return
          if (!reviewWorkspaceEquals(restored.model.workspace, workspace)) {
            this.failRestore(
              localGeneration,
              workspace,
              'Restored review state mismatched',
            )
            return
          }
          this.saveRevisions.set(localGeneration, restored.revision)
          this.setState({
            status: 'ready',
            localGeneration,
            workspace,
            workspaceGeneration: restored.workspaceGeneration,
            revision: restored.revision,
            model: restored.model,
            notice: restored.notice,
          })
        },
        (reason: unknown) =>
          this.failRestore(localGeneration, workspace, errorMessage(reason)),
      )
    void pendingSaves.then(
      () => this.saveRevisions.delete(previousGeneration),
      () => this.saveRevisions.delete(previousGeneration),
    )
  }

  deactivate(): void {
    if (this.disposed || this.state.status === 'idle') return
    this.readGenerations.clear()
    this.setState({
      status: 'idle',
      localGeneration: this.state.localGeneration + 1,
      revision: 0,
    })
  }

  apply(action: DocumentReviewAction): DocumentReviewActionResult {
    const current = this.readyState()
    if (!current) {
      const model = this.state.model ?? emptyModel(action.workspace)
      return {
        ok: false,
        model,
        error: {
          code: 'workspace-mismatch',
          message: 'Document review is still restoring its workspace',
        },
      }
    }
    const result = applyDocumentReviewAction(current.model, action)
    if (result.ok && result.model !== current.model) {
      this.setState({ ...current, model: result.model, error: undefined })
      this.queueSave(current, result.model)
    }
    return result
  }

  handleWatch(event: WatchEvent): void {
    if (event.synthetic === 'refresh') return
    const current = this.readyState()
    if (!current || !reviewedDocument(current.model, event.path)) return
    if (event.type === 'unlink') {
      this.apply({
        type: 'mark-document-stale',
        workspace: current.workspace,
        document: event.path,
        reason: 'deleted',
      })
      return
    }
    this.revalidate(current, event.path)
  }

  flush(): Promise<void> {
    return this.saveTail
  }

  adoptAuthoritative(snapshot: DocumentReviewWorkspaceSnapshot): boolean {
    const current = this.readyState()
    if (
      !current ||
      this.saveQueue.length > 0 ||
      snapshot.workspaceGeneration !== current.workspaceGeneration ||
      snapshot.revision <= current.revision ||
      !reviewWorkspaceEquals(snapshot.model.workspace, current.workspace)
    ) {
      return false
    }
    this.saveRevisions.set(current.localGeneration, snapshot.revision)
    this.setState({
      ...current,
      revision: snapshot.revision,
      model: snapshot.model,
      notice: snapshot.notice,
      error: undefined,
    })
    return true
  }

  dispose(): void {
    if (this.disposed || this.closing) return
    this.closing = true
    this.readGenerations.clear()
    const finish = (): void => {
      this.disposed = true
      this.saveRevisions.clear()
      this.state = {
        status: 'idle',
        localGeneration: this.state.localGeneration + 1,
        revision: 0,
      }
    }
    void this.saveTail.then(finish, finish)
  }

  private revalidate(
    current: ReadyDocumentReviewWorkspaceState,
    document: HostPath,
  ): void {
    const key = pathKey(document)
    const readGeneration = (this.readGenerations.get(key) ?? 0) + 1
    this.readGenerations.set(key, readGeneration)
    void this.port
      .revalidate({
        workspace: current.workspace,
        workspaceGeneration: current.workspaceGeneration,
        document,
      })
      .then(
        (result) => {
          if (!this.isReadCurrent(current, key, readGeneration)) return
          this.apply(
            result.status === 'read'
              ? {
                  type: 'revalidate-document',
                  workspace: current.workspace,
                  document: result.document,
                  snapshot: result.snapshot,
                  content: result.content,
                }
              : {
                  type: 'mark-document-stale',
                  workspace: current.workspace,
                  document: result.document,
                  reason: result.reason,
                },
          )
        },
        () => {
          if (!this.isReadCurrent(current, key, readGeneration)) return
          this.apply({
            type: 'mark-document-stale',
            workspace: current.workspace,
            document,
            reason: 'host-unavailable',
          })
        },
      )
  }

  private queueSave(
    source: ReadyDocumentReviewWorkspaceState,
    model: DocumentReviewModel,
  ): void {
    const localGeneration = source.localGeneration
    const workspace = source.workspace
    const save = async (): Promise<void> => {
      try {
        const expectedRevision =
          this.saveRevisions.get(localGeneration) ?? source.revision
        const stored = await this.port.save({
          workspace,
          workspaceGeneration: source.workspaceGeneration,
          expectedRevision,
          model,
        })
        this.saveRevisions.set(localGeneration, stored.revision)
        const latest = this.readyState()
        if (
          !latest ||
          latest.localGeneration !== localGeneration ||
          stored.workspaceGeneration !== latest.workspaceGeneration
        ) {
          return
        }
        this.setState({
          ...latest,
          revision: stored.revision,
          notice: stored.notice,
          error: undefined,
        })
      } catch (reason) {
        const latest = this.readyState()
        if (latest?.localGeneration === localGeneration && !this.closing) {
          this.setState({ ...latest, error: errorMessage(reason) })
        }
      }
    }
    this.saveQueue.push(save)
    if (this.saveQueue.length === 1) this.saveTail = this.drainSaveQueue()
  }

  private async drainSaveQueue(): Promise<void> {
    while (this.saveQueue[0]) {
      try {
        await this.saveQueue[0]()
      } finally {
        this.saveQueue.shift()
      }
    }
  }

  private isReadCurrent(
    source: ReadyDocumentReviewWorkspaceState,
    key: string,
    readGeneration: number,
  ): boolean {
    const current = this.readyState()
    return Boolean(
      current &&
      current.localGeneration === source.localGeneration &&
      current.workspaceGeneration === source.workspaceGeneration &&
      this.readGenerations.get(key) === readGeneration,
    )
  }

  private readyState(): ReadyDocumentReviewWorkspaceState | undefined {
    return !this.closing &&
      !this.disposed &&
      this.state.status === 'ready' &&
      this.state.workspace &&
      this.state.workspaceGeneration !== undefined &&
      this.state.model
      ? (this.state as ReadyDocumentReviewWorkspaceState)
      : undefined
  }

  private isLocalGeneration(
    generation: number,
    workspace: ReviewWorkspaceIdentity,
  ): boolean {
    return (
      !this.disposed &&
      !this.closing &&
      this.state.localGeneration === generation &&
      Boolean(
        this.state.workspace && reviewWorkspaceEquals(this.state.workspace, workspace),
      )
    )
  }

  private failRestore(
    generation: number,
    workspace: ReviewWorkspaceIdentity,
    error: string,
  ): void {
    if (!this.isLocalGeneration(generation, workspace)) return
    this.setState({ ...this.state, status: 'error', error })
  }

  private setState(state: DocumentReviewWorkspaceState): void {
    this.state = state
    this.publish(state)
  }
}

type ReadyDocumentReviewWorkspaceState = DocumentReviewWorkspaceState & {
  readonly status: 'ready'
  readonly workspace: ReviewWorkspaceIdentity
  readonly workspaceGeneration: number
  readonly model: DocumentReviewModel
}

export function documentReviewPaths(model?: DocumentReviewModel): readonly HostPath[] {
  if (!model) return []
  const documents = new Map<string, HostPath>()
  for (const comment of model.comments) {
    documents.set(pathKey(comment.document), comment.document)
  }
  return [...documents.values()]
}

function reviewedDocument(model: DocumentReviewModel, document: HostPath): boolean {
  return model.comments.some((comment) => hostPathEquals(comment.document, document))
}

function emptyModel(workspace: ReviewWorkspaceIdentity): DocumentReviewModel {
  return { workspace, comments: [], batches: [] }
}

function pathKey(path: HostPath): string {
  return `${path.hostId}:${path.path}`
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
