import { randomUUID } from 'node:crypto'
import { hostPathEquals, joinHostPath } from '../../shared/host-path'
import { repositoryImageMimeType } from '../../shared'
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
  pending?: Promise<unknown>
  consumed: boolean
  disposed: boolean
}

/** Owns content leases independently of sidebar searches and metadata refresh. */
export class SkillagerReviewOwner {
  private readonly sessions = new Map<string, Session>()
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
    const operation = this.cli.review(
      grant.selection,
      request.skillId,
      session.controller.signal,
    )
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
    const result = { entry: request.entry, path, size: bytes.byteLength }
    const mime = repositoryImageMimeType(path.path)
    if (mime) return { ...result, image: { mime, bytes } }
    if (request.documentEntry !== undefined)
      throw new SkillagerError(
        'invalid-request',
        'Only reviewed image assets may load automatically.',
      )
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      return result
    }
    if (text.includes('\0')) return result
    if (/\.html?$/i.test(path.path)) {
      let preview = session.previews.get(request.entry)
      if (!preview) {
        preview = this.previews.create(text, request.workspaceRoot)
        session.previews.set(request.entry, preview)
      }
      return { ...result, text, htmlUrl: preview.url }
    }
    return { ...result, text }
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
