import { repositoryImageMimeType } from '../../shared'
import { skillagerFileContent } from './skillager-file-content'
import {
  readSkillagerDocument,
  validateSkillagerDocumentAsset,
  validateSkillagerDocumentSelection,
  type SkillagerDocumentAccess,
  type SkillagerDocumentCliPort,
  type SkillagerProjectDocumentAccess,
} from './skillager-document-read'
import type {
  SkillagerContentRequest,
  SkillagerContentFileRequest,
  SkillagerContentSession,
} from '../../shared/skillager-content'
import {
  SKILLAGER_REVIEW_MAX_BYTES,
  SKILLAGER_REVIEW_MAX_FILES,
} from '../../shared/skillager-review'
import type { SkillagerExposureRequest } from '../../shared/skillager-exposure'
import type {
  SkillagerExposureCliPort,
  SkillagerExposureSnapshot,
  SkillagerExposureGrant,
} from './skillager-exposure-port'
import { randomUUID } from 'node:crypto'
import { hostPathEquals, joinHostPath } from '../../shared/host-path'
import type {
  SkillagerReview,
  SkillagerReviewContent,
  SkillagerReviewRequest,
  SkillagerSkillRequest,
} from '../../shared/skillager-review'
import type {
  RendererOwner,
  RendererResourceLease,
  RendererResourceScopes,
} from '../renderer-resource-scopes'
import {
  SkillagerError,
  SKILLAGER_REQUEST_DEADLINE_MS,
  type SkillagerCliSelection,
} from './skillager-port'
import type {
  SkillagerReviewCliPort,
  SkillagerReviewPreviewPort,
  SkillagerReviewSnapshot,
} from './skillager-review-port'

export interface SkillagerReviewGrant {
  readonly selection: SkillagerCliSelection
  readonly assertCurrent: () => void
}
interface Session {
  readonly owner: RendererOwner
  readonly request: SkillagerSkillRequest
  readonly grant: SkillagerReviewGrant
  readonly controller: AbortController
  readonly previews: Map<string, { readonly id: string; readonly url: string }>
  lease?: RendererResourceLease
  snapshot?: SkillagerReviewSnapshot
  update?: SkillagerExposureSnapshot['detail']
  pending?: Promise<unknown>
  consumed: boolean
  disposed: boolean
}

interface DocumentSession {
  readonly owner: RendererOwner
  readonly request: SkillagerContentRequest
  readonly grant: SkillagerReviewGrant
  readonly controller: AbortController
  readonly bytes: Map<string, Uint8Array>
  readonly previews: Map<string, { readonly id: string; readonly url: string }>
  readonly jobs: Set<Promise<unknown>>
  access?: SkillagerDocumentAccess
  lease?: RendererResourceLease
  disposed: boolean
}
/** Owns content leases independently of sidebar searches and metadata refresh. */
export class SkillagerReviewOwner {
  private readonly sessions = new Map<string, Session>()
  private readonly documents = new Map<string, DocumentSession>()
  private readonly histories = new Map<
    AbortController,
    {
      readonly owner: RendererOwner
      readonly requestId: number
      readonly task: Promise<unknown>
    }
  >()
  constructor(
    private readonly cli: SkillagerReviewCliPort,
    private readonly resources: Pick<
      RendererResourceScopes,
      'register' | 'assertCurrent'
    >,
    private readonly previews: SkillagerReviewPreviewPort,
    private readonly updates: Pick<
      SkillagerExposureCliPort,
      'previewExposure' | 'updateSourceHash'
    >,
  ) {}

  async review(
    owner: RendererOwner,
    request: SkillagerSkillRequest,
    grant: SkillagerReviewGrant,
  ): Promise<SkillagerReview> {
    grant.assertCurrent()
    if (
      [...this.sessions.values()].filter((session) => sameOwner(session.owner, owner))
        .length >= 4
    )
      throw new SkillagerError(
        'busy',
        'Close another skill review before opening more content.',
      )
    const id = randomUUID()
    const session: Session = {
      owner,
      request,
      grant,
      controller: new AbortController(),
      consumed: false,
      disposed: false,
      previews: new Map(),
    }
    this.sessions.set(id, session)
    session.lease = this.resources.register(
      owner,
      {
        lifetime: 'workspace',
        type: 'skillager-request',
        root: request.workspaceRoot,
        id: `review:${id}`,
      },
      () => this.release(owner, id),
    )
    const operation = (async () => {
      const signal = session.controller.signal
      const initial = request.update
        ? await this.updates.previewExposure(grant.selection, request.update, signal)
        : undefined
      let fromHash: string | undefined
      try {
        fromHash = initial
          ? await this.updates.updateSourceHash(grant.selection, initial, signal)
          : undefined
      } finally {
        // Retain only target/version evidence for D5; remote preparation must not
        // occupy later preview admission while the independent D4 review is open.
        if (initial?.dispose) await initial.dispose()
      }
      this.current(session)
      const snapshot = await this.cli.review(grant.selection, request.skillId, signal)
      session.snapshot = snapshot
      if (!initial) return snapshot
      if (
        snapshot.detail.hash !== initial.detail.sourceHash ||
        snapshot.detail.canAccept ||
        snapshot.detail.refusal
      )
        throw new SkillagerError(
          'stale-review',
          'The accepted source changed. Refresh and review the update again.',
        )
      const diff = await this.cli
        .diff(grant.selection, snapshot, fromHash, signal)
        .catch((error: unknown) => {
          if (error instanceof SkillagerError && error.reason === 'invalid-request')
            throw new SkillagerError(
              'unavailable',
              'The workspace source version is unavailable in library history. This update cannot be reviewed.',
            )
          throw error
        })
      this.current(session)
      if (diff.fromHash !== fromHash || diff.toHash !== snapshot.detail.hash)
        throw new SkillagerError(
          'stale-review',
          'The exact workspace update diff is unavailable. Review again.',
        )
      // Only a completed exact diff grants update proof. No ExposureOwner session is allocated here.
      session.update = initial.detail
      return {
        ...snapshot,
        detail: { ...snapshot.detail, update: { request: request.update!, diff } },
      }
    })()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      session.controller.abort()
    }, SKILLAGER_REQUEST_DEADLINE_MS)
    session.pending = operation
    try {
      const snapshot = await operation
      session.snapshot = snapshot
      this.current(session)
      return { ...snapshot.detail, reviewId: id }
    } catch (error) {
      session.pending = undefined
      await this.release(owner, id)
      if (timedOut)
        throw new SkillagerError('timeout', 'Skill review took too long. Try again.')
      throw error
    } finally {
      clearTimeout(timer)
      session.pending = undefined
    }
  }

  async openDocument(
    owner: RendererOwner,
    request: SkillagerContentRequest,
    grant: SkillagerReviewGrant,
    cli: SkillagerDocumentCliPort,
    projectAccess: SkillagerProjectDocumentAccess,
  ): Promise<SkillagerContentSession> {
    grant.assertCurrent()
    validateSkillagerDocumentSelection(
      grant.selection,
      request.selection,
      request.workspaceRoot,
    )
    if (
      [...this.documents.values()].filter((item) => sameOwner(item.owner, owner))
        .length >= 4
    )
      throw new SkillagerError(
        'busy',
        'Close another skill document before opening more content.',
      )
    const id = randomUUID()
    const session: DocumentSession = {
      owner,
      request,
      grant,
      controller: new AbortController(),
      bytes: new Map(),
      previews: new Map(),
      jobs: new Set(),
      disposed: false,
    }
    this.documents.set(id, session)
    try {
      session.lease = this.resources.register(
        owner,
        {
          lifetime: 'workspace',
          type: 'skillager-request',
          root: request.workspaceRoot,
          id: `document:${id}`,
        },
        () => this.releaseDocument(owner, id),
      )
    } catch (error) {
      this.documents.delete(id)
      session.controller.abort()
      throw error
    }
    const signal = session.controller.signal
    const timer = setTimeout(
      () => session.controller.abort(),
      SKILLAGER_REQUEST_DEADLINE_MS,
    )
    const job = (async () => {
      session.access =
        request.selection.kind === 'library'
          ? await cli.documentAccess(grant.selection, request.selection, signal)
          : await projectAccess(request.selection.path)
      const bytes = await readSkillagerDocument(
        session.access,
        request.selection.root,
        request.selection.path,
        signal,
        request.selection.kind === 'library',
      )
      await cli.validateDocument(
        grant.selection,
        request.selection,
        request.workspaceRoot,
        bytes,
        signal,
      )
      this.documentCurrent(session)
      session.bytes.set('SKILL.md', bytes)
      return {
        contentId: id,
        selection: request.selection,
        content: skillagerFileContent(
          'SKILL.md',
          request.selection.path,
          bytes,
          false,
          request.workspaceRoot,
          session.previews,
          this.previews,
        ),
      }
    })()
    session.jobs.add(job)
    try {
      return await job
    } catch (error) {
      session.jobs.delete(job)
      await this.releaseDocument(owner, id)
      throw error
    } finally {
      clearTimeout(timer)
      session.jobs.delete(job)
    }
  }

  async documentContent(
    owner: RendererOwner,
    request: SkillagerContentFileRequest,
  ): Promise<SkillagerReviewContent> {
    const session = this.documents.get(request.contentId)
    if (
      !session ||
      !session.access ||
      !sameOwner(owner, session.owner) ||
      session.request.connectionId !== request.connectionId ||
      session.request.agent !== request.agent ||
      !hostPathEquals(session.request.workspaceRoot, request.workspaceRoot)
    )
      throw new SkillagerError(
        'review-expired',
        'The selected skill document is no longer open.',
      )
    this.documentCurrent(session)
    if (
      !request.entry ||
      request.entry.length > 4096 ||
      request.entry
        .split('/')
        .some(
          (part) =>
            !part ||
            part === '.' ||
            part === '..' ||
            part.includes('\\') ||
            part.includes('\0'),
        )
    )
      throw new SkillagerError('invalid-request', 'Select a file inside this skill.')
    if (request.documentEntry !== undefined) {
      if (!repositoryImageMimeType(request.entry))
        throw new SkillagerError(
          'invalid-request',
          'Only image assets may load automatically.',
        )
      if (!session.bytes.has(request.documentEntry))
        throw new SkillagerError('invalid-request', 'The source document is not open.')
      const parent = request.documentEntry.split('/').slice(0, -1).join('/')
      if (parent && !request.entry.startsWith(parent + '/'))
        throw new SkillagerError(
          'invalid-request',
          'Image escapes its document directory.',
        )
    }
    if (session.jobs.size >= 4)
      throw new SkillagerError(
        'busy',
        'Wait for the current skill files to finish loading.',
      )
    const path = joinHostPath(session.request.selection.root, ...request.entry.split('/'))
    const signal = AbortSignal.any([
      session.controller.signal,
      AbortSignal.timeout(SKILLAGER_REQUEST_DEADLINE_MS),
    ])
    const job = (async () => {
      if (request.documentEntry !== undefined)
        await validateSkillagerDocumentAsset(
          session.access!,
          joinHostPath(
            session.request.selection.root,
            ...request.documentEntry.split('/'),
          ),
          path,
          signal,
        )
      let bytes = session.bytes.get(request.entry)
      if (!bytes) {
        bytes = await readSkillagerDocument(
          session.access!,
          session.request.selection.root,
          path,
          signal,
          session.request.selection.kind === 'library',
        )
        this.documentCurrent(session)
        const total = [...session.bytes.values()].reduce(
          (sum, item) => sum + item.byteLength,
          bytes.byteLength,
        )
        if (
          session.bytes.size >= SKILLAGER_REVIEW_MAX_FILES ||
          total > SKILLAGER_REVIEW_MAX_BYTES
        )
          throw new SkillagerError(
            'output-limit',
            'The open skill document exceeds its retained content limit.',
          )
        session.bytes.set(request.entry, bytes)
      }
      this.documentCurrent(session)
      return skillagerFileContent(
        request.entry,
        path,
        bytes,
        request.documentEntry !== undefined,
        request.workspaceRoot,
        session.previews,
        this.previews,
      )
    })()
    session.jobs.add(job)
    try {
      return await job
    } finally {
      session.jobs.delete(job)
    }
  }

  async releaseDocument(owner: RendererOwner, id: string): Promise<void> {
    const session = this.documents.get(id)
    if (!session || !sameOwner(owner, session.owner)) return
    this.documents.delete(id)
    session.disposed = true
    session.controller.abort()
    session.lease?.release()
    await Promise.allSettled(session.jobs)
    for (const preview of session.previews.values()) this.previews.release(preview.id)
    session.previews.clear()
    session.bytes.clear()
  }
  async cancelDocument(owner: RendererOwner, requestId: number): Promise<void> {
    await Promise.all(
      [...this.documents]
        .filter(
          ([, item]) =>
            sameOwner(owner, item.owner) && item.request.requestId === requestId,
        )
        .map(([id]) => this.releaseDocument(owner, id)),
    )
  }
  private documentCurrent(session: DocumentSession): void {
    this.resources.assertCurrent(session.owner)
    session.grant.assertCurrent()
    session.controller.signal.throwIfAborted()
    session.access?.assertCurrent()
    if (session.disposed)
      throw new SkillagerError('review-expired', 'The skill document was closed.')
  }

  updateGrant(
    owner: RendererOwner,
    request: SkillagerExposureRequest,
  ): Pick<SkillagerExposureGrant, 'assertCurrent' | 'validatePreview'> {
    const session = this.get(owner, { ...request, reviewId: request.reviewId ?? '' })
    const proof = session.update
    const previous = proof?.request
    if (
      !proof ||
      !previous ||
      request.action !== 'update' ||
      previous.skillId !== request.skillId ||
      previous.mode !== request.mode ||
      previous.exposure?.id !== request.exposure?.id ||
      !request.exposure ||
      !hostPathEquals(proof.target, request.exposure.target) ||
      previous.destination.projectId !== request.destination.projectId ||
      previous.destination.workspaceId !== request.destination.workspaceId ||
      !hostPathEquals(previous.destination.root, request.destination.root)
    )
      throw new SkillagerError(
        'review-expired',
        'Review this exact workspace update before previewing changes.',
      )
    return {
      assertCurrent: () => this.current(session),
      validatePreview: ({ detail }) => {
        this.current(session)
        if (
          detail.sourceHash !== session.snapshot!.detail.hash ||
          detail.sourceHash !== proof.sourceHash ||
          detail.targetHash !== proof.targetHash ||
          detail.beforeMode !== proof.beforeMode ||
          !hostPathEquals(detail.target, proof.target)
        )
          throw new SkillagerError(
            'stale-review',
            'The source or target changed during review. Refresh and review a new update.',
          )
      },
    }
  }

  async history(
    owner: RendererOwner,
    request: SkillagerSkillRequest,
    grant: SkillagerReviewGrant,
  ) {
    grant.assertCurrent()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SKILLAGER_REQUEST_DEADLINE_MS)
    const lease = this.resources.register(
      owner,
      {
        lifetime: 'workspace',
        type: 'skillager-request',
        root: request.workspaceRoot,
        id: `history:${randomUUID()}`,
      },
      () => controller.abort(),
    )
    const task = this.cli.history(grant.selection, request.skillId, controller.signal)
    this.histories.set(controller, { owner, requestId: request.requestId, task })
    try {
      const result = await task
      grant.assertCurrent()
      controller.signal.throwIfAborted()
      return result
    } finally {
      clearTimeout(timer)
      this.histories.delete(controller)
      lease.release()
    }
  }

  content(
    owner: RendererOwner,
    request: SkillagerReviewRequest & {
      readonly entry: string
      readonly documentEntry?: string
    },
  ): SkillagerReviewContent {
    const session = this.get(owner, request),
      snapshot = session.snapshot!
    const bytes = snapshot.bytes.get(request.entry)
    if (!bytes)
      throw new SkillagerError('invalid-request', 'Select a file in the reviewed tree.')
    if (request.documentEntry !== undefined) {
      if (!snapshot.bytes.has(request.documentEntry))
        throw new SkillagerError(
          'invalid-request',
          'The reviewed document is unavailable.',
        )
      const parent = request.documentEntry.split('/').slice(0, -1).join('/')
      if (parent && !request.entry.startsWith(`${parent}/`))
        throw new SkillagerError(
          'invalid-request',
          'Image escapes the reviewed document directory.',
        )
    }
    const path = joinHostPath(snapshot.detail.root, ...request.entry.split('/'))
    return skillagerFileContent(
      request.entry,
      path,
      bytes,
      request.documentEntry !== undefined,
      request.workspaceRoot,
      session.previews,
      this.previews,
    )
  }

  async diff(
    owner: RendererOwner,
    request: SkillagerReviewRequest & { readonly fromHash?: string },
  ) {
    const session = this.get(owner, request)
    if (session.pending)
      throw new SkillagerError('busy', 'This review already has a pending action.')
    const task = this.cli.diff(
      session.grant.selection,
      session.snapshot!,
      request.fromHash,
      session.controller.signal,
    )
    session.pending = task
    try {
      const result = await task
      this.current(session)
      return result
    } finally {
      session.pending = undefined
    }
  }

  async accept(owner: RendererOwner, request: SkillagerReviewRequest) {
    const session = this.get(owner, request)
    if (session.consumed)
      throw new SkillagerError(
        'review-expired',
        'This confirmation was already used. Refresh and review again.',
      )
    if (session.pending)
      throw new SkillagerError('busy', 'Wait for this review action to finish.')
    session.consumed = true
    const task = this.cli.accept(
      session.grant.selection,
      session.snapshot!,
      session.controller.signal,
    )
    session.pending = task
    try {
      // Return an observed completed mutation truthfully even if its view was closed.
      return await task
    } catch (error) {
      if (error instanceof SkillagerError && error.reason === 'busy')
        session.consumed = false
      throw error
    } finally {
      session.pending = undefined
    }
  }

  async release(owner: RendererOwner, id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session || !sameOwner(session.owner, owner)) return
    this.sessions.delete(id)
    session.disposed = true
    session.controller.abort()
    session.lease?.release()
    for (const preview of session.previews.values()) this.previews.release(preview.id)
    session.previews.clear()
    await session.pending?.catch(() => undefined)
    await session.snapshot?.dispose()
  }

  async cancel(owner: RendererOwner, requestId: number): Promise<void> {
    for (const [controller, job] of this.histories)
      if (sameOwner(job.owner, owner) && job.requestId === requestId) controller.abort()
    await Promise.all(
      [...this.sessions]
        .filter(
          ([, session]) =>
            sameOwner(session.owner, owner) && session.request.requestId === requestId,
        )
        .map(([id]) => this.release(owner, id)),
    )
  }

  async revoke(owner?: RendererOwner): Promise<void> {
    const historyJobs = [...this.histories].filter(
      ([, job]) => !owner || sameOwner(job.owner, owner),
    )
    for (const [controller] of historyJobs) controller.abort()
    const releases = [...this.sessions]
      .filter(([, session]) => !owner || sameOwner(session.owner, owner))
      .map(([id, session]) => this.release(session.owner, id))
    await Promise.all([
      ...[...this.documents]
        .filter(([, item]) => !owner || sameOwner(owner, item.owner))
        .map(([id, item]) => this.releaseDocument(item.owner, id)),
      Promise.allSettled(historyJobs.map(([, job]) => job.task)),
      ...releases,
    ])
  }

  private get(owner: RendererOwner, request: SkillagerReviewRequest): Session {
    const session = this.sessions.get(request.reviewId)
    if (
      !session ||
      !session.snapshot ||
      !sameOwner(session.owner, owner) ||
      session.request.connectionId !== request.connectionId ||
      !hostPathEquals(session.request.workspaceRoot, request.workspaceRoot) ||
      session.request.agent !== request.agent
    )
      throw new SkillagerError(
        'review-expired',
        'This skill review expired. Review the current version again.',
      )
    this.current(session)
    return session
  }
  private current(session: Session): void {
    this.resources.assertCurrent(session.owner)
    session.grant.assertCurrent()
    if (session.disposed || session.controller.signal.aborted)
      throw new SkillagerError('cancelled', 'Skill review cancelled.')
  }
}
function sameOwner(left: RendererOwner, right: RendererOwner): boolean {
  return left.id === right.id && left.generation === right.generation
}
