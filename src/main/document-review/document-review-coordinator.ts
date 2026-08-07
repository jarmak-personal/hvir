import { createHash } from 'node:crypto'

import {
  DOCUMENT_REVIEW_LIMITS,
  type DocumentReviewRevalidateRequest,
  type DocumentReviewRevalidation,
  type DocumentReviewSaveRequest,
  type DocumentReviewWorkspaceSnapshot,
  type DocumentReviewModel,
  type HostPath,
  type ReviewWorkspaceIdentity,
} from '../../shared'
import type { ProjectHost } from '../project-host'
import type {
  RendererOwner,
  RendererResourceLease,
  RendererResourceScopes,
} from '../renderer-resource-scopes'
import type { DocumentReviewStore } from './document-review-store'
import {
  documentReviewWorkspaceEquals,
  isDocumentReviewDocument,
} from './document-review-policy'

interface ActiveReviewWorkspace {
  readonly owner: RendererOwner
  readonly workspace: ReviewWorkspaceIdentity
  readonly generation: number
  readonly host: ProjectHost
  readonly abort: AbortController
  lease?: RendererResourceLease
}

export interface DocumentReviewCoordinatorOptions {
  readonly store: Pick<DocumentReviewStore, 'notice' | 'read' | 'retryLoad' | 'save'>
  readonly resources: RendererResourceScopes
}

export interface DocumentReviewDeliveryWorkspaceSnapshot {
  readonly workspaceGeneration: number
  readonly revision: number
  readonly model: DocumentReviewModel
  readonly host: ProjectHost
}

/** Owns one revocable document-review workspace effect per renderer generation. */
export class DocumentReviewCoordinator {
  private readonly active = new Map<string, ActiveReviewWorkspace>()
  private transitionTail: Promise<void> = Promise.resolve()
  private nextGeneration = 0
  private disposed = false

  constructor(private readonly options: DocumentReviewCoordinatorOptions) {}

  activate(
    owner: RendererOwner,
    workspace: ReviewWorkspaceIdentity,
    host: ProjectHost,
  ): Promise<DocumentReviewWorkspaceSnapshot> {
    return this.serialize(async () => {
      if (this.disposed) throw new Error('Document review coordinator is disposed')
      if (workspace.root.hostId !== host.hostId) {
        throw new Error('Document review workspace host mismatched')
      }
      const key = ownerKey(owner)
      await this.active.get(key)?.lease?.dispose()
      const session: ActiveReviewWorkspace = {
        owner,
        workspace,
        host,
        generation: (this.nextGeneration += 1),
        abort: new AbortController(),
      }
      this.active.set(key, session)
      session.lease = this.options.resources.register(
        owner,
        {
          lifetime: 'workspace',
          type: 'document-review',
          root: workspace.root,
          id: workspace.id,
        },
        () => this.revokeSession(session),
      )
      await this.options.store.retryLoad()
      this.assertCurrent(session)
      const stored = this.options.store.read(workspace)
      return {
        workspaceGeneration: session.generation,
        revision: stored.revision,
        model: stored.model,
        notice: this.options.store.notice(),
      }
    })
  }

  async save(
    owner: RendererOwner,
    request: DocumentReviewSaveRequest,
  ): Promise<DocumentReviewWorkspaceSnapshot> {
    const session = this.requireSession(owner, request)
    if (!documentReviewWorkspaceEquals(session.workspace, request.model.workspace)) {
      throw new Error('Document review model belongs to another workspace identity')
    }
    const stored = await this.options.store.save(request.expectedRevision, request.model)
    this.assertCurrent(session)
    return {
      workspaceGeneration: session.generation,
      revision: stored.revision,
      model: stored.model,
      notice: this.options.store.notice(),
    }
  }

  async revalidate(
    owner: RendererOwner,
    request: DocumentReviewRevalidateRequest,
    canonicalDocument: HostPath,
  ): Promise<DocumentReviewRevalidation> {
    const session = this.requireSession(owner, request)
    if (
      !isDocumentReviewDocument(session.workspace, request.document) ||
      !isDocumentReviewDocument(session.workspace, canonicalDocument)
    ) {
      throw new Error('Document review read escapes its exact workspace')
    }
    if (session.host.connectionState !== 'connected') {
      return stale(request.document, 'host-unavailable')
    }
    try {
      const read = await session.host.readTextFilePrefix(
        canonicalDocument,
        DOCUMENT_REVIEW_LIMITS.revalidationReadBytes,
        { pollingInterest: true, signal: session.abort.signal },
      )
      this.assertCurrent(session)
      if (!read.complete) return stale(request.document, 'incomplete-read')
      if (read.content.includes('\0') || read.validUtf8 === false) {
        return stale(request.document, 'invalid-text')
      }
      return {
        status: 'read',
        document: request.document,
        snapshot: {
          algorithm: 'sha256',
          digest: createHash('sha256').update(read.content, 'utf8').digest('hex'),
          byteLength: read.byteLength,
        },
        content: read.content,
      }
    } catch (reason) {
      if (session.abort.signal.aborted) {
        throw new Error('Document review workspace was revoked', { cause: reason })
      }
      this.assertCurrent(session)
      return stale(
        request.document,
        isMissingFile(reason) ? 'deleted' : 'host-unavailable',
      )
    }
  }

  deliverySnapshot(
    owner: RendererOwner,
    request: {
      readonly workspace: ReviewWorkspaceIdentity
      readonly workspaceGeneration: number
    },
  ): DocumentReviewDeliveryWorkspaceSnapshot {
    const session = this.requireSession(owner, request)
    const stored = this.options.store.read(session.workspace)
    return {
      workspaceGeneration: session.generation,
      revision: stored.revision,
      model: stored.model,
      host: session.host,
    }
  }

  /** Persist the exact post-send lifecycle transition after PTY confirmation. */
  async markSent(
    owner: RendererOwner,
    request: {
      readonly workspace: ReviewWorkspaceIdentity
      readonly workspaceGeneration: number
      readonly expectedRevision: number
      readonly commentIds: readonly string[]
    },
  ): Promise<DocumentReviewWorkspaceSnapshot> {
    const session = this.requireSession(owner, request)
    const ids = new Set(request.commentIds)
    if (
      ids.size === 0 ||
      ids.size !== request.commentIds.length ||
      ids.size > DOCUMENT_REVIEW_LIMITS.batchMembers
    ) {
      throw new Error('Review submission requires unique bounded draft comments')
    }
    const current = this.options.store.read(session.workspace)
    if (current.revision !== request.expectedRevision) {
      throw new Error('The review batch changed during submission')
    }
    for (const id of ids) {
      const comment = current.model.comments.find((candidate) => candidate.id === id)
      if (!comment || comment.lifecycle !== 'draft') {
        throw new Error('Only the exact included drafts can be marked sent')
      }
    }
    const model: DocumentReviewModel = {
      ...current.model,
      comments: current.model.comments.map((comment) =>
        ids.has(comment.id) ? { ...comment, lifecycle: 'sent' as const } : comment,
      ),
      // Existing batch membership is durable review history. Its sent members
      // become ineligible through the shared lifecycle rule; they are not
      // silently deleted by delivery.
      batches: current.model.batches,
    }
    this.assertCurrent(session)
    const stored = await this.options.store.save(current.revision, model)
    this.assertCurrent(session)
    return {
      workspaceGeneration: session.generation,
      revision: stored.revision,
      model: stored.model,
      notice: this.options.store.notice(),
    }
  }

  revoke(owner: RendererOwner): void {
    const session = this.active.get(ownerKey(owner))
    if (session) this.revokeSession(session)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const session of this.active.values()) this.revokeSession(session)
  }

  private requireSession(
    owner: RendererOwner,
    request: {
      readonly workspace: ReviewWorkspaceIdentity
      readonly workspaceGeneration: number
    },
  ): ActiveReviewWorkspace {
    const session = this.active.get(ownerKey(owner))
    if (
      !session ||
      session.generation !== request.workspaceGeneration ||
      !documentReviewWorkspaceEquals(session.workspace, request.workspace)
    ) {
      throw new Error('Document review renderer or workspace generation is stale')
    }
    this.assertCurrent(session)
    return session
  }

  private assertCurrent(session: ActiveReviewWorkspace): void {
    if (
      this.disposed ||
      session.abort.signal.aborted ||
      this.active.get(ownerKey(session.owner)) !== session
    ) {
      throw new Error('Document review workspace was revoked')
    }
  }

  private revokeSession(session: ActiveReviewWorkspace): void {
    if (this.active.get(ownerKey(session.owner)) === session) {
      this.active.delete(ownerKey(session.owner))
    }
    session.abort.abort(new Error('Document review workspace was revoked'))
    session.lease?.release()
    session.lease = undefined
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.transitionTail.then(operation, operation)
    this.transitionTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

function ownerKey(owner: RendererOwner): string {
  return `${owner.id}:${owner.generation}`
}

function stale(
  document: HostPath,
  reason: Extract<DocumentReviewRevalidation, { status: 'stale' }>['reason'],
): DocumentReviewRevalidation {
  return { status: 'stale', document, reason }
}

function isMissingFile(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    value.code === 'ENOENT'
  )
}
