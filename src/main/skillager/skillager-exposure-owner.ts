import { validateExposureSelection } from './skillager-exposure-selection'
import { randomUUID } from 'node:crypto'
import { hostPathEquals } from '../../shared/host-path'
import type {
  SkillagerExposureRequest,
  SkillagerExposurePreview,
} from '../../shared/skillager-exposure'
import type {
  RendererOwner,
  RendererResourceLease,
  RendererResourceScopes,
} from '../renderer-resource-scopes'
import { SkillagerError, SKILLAGER_REQUEST_DEADLINE_MS } from './skillager-port'
import type {
  SkillagerExposureCliPort,
  SkillagerExposureGrant,
  SkillagerExposureSnapshot,
} from './skillager-exposure-port'

interface Session {
  readonly owner: RendererOwner
  readonly request: SkillagerExposureRequest
  readonly grant: SkillagerExposureGrant
  readonly controller: AbortController
  readonly leases: RendererResourceLease[]
  snapshot?: SkillagerExposureSnapshot
  pending?: Promise<unknown>
  consumed: boolean
  disposed: boolean
}

/** One explicit action owns both its originating workspace and selected destination. */
export class SkillagerExposureOwner {
  private readonly sessions = new Map<string, Session>()
  constructor(
    private readonly cli: Pick<
      SkillagerExposureCliPort,
      'previewExposure' | 'applyExposure'
    >,
    private readonly resources: Pick<
      RendererResourceScopes,
      'register' | 'assertCurrent'
    >,
  ) {}

  async preview(
    owner: RendererOwner,
    request: SkillagerExposureRequest,
    grant: SkillagerExposureGrant,
  ): Promise<SkillagerExposurePreview> {
    grant.assertCurrent()
    validateExposureSelection(request)
    if ([...this.sessions.values()].some((session) => sameOwner(session.owner, owner)))
      throw new SkillagerError(
        'busy',
        'Close the current workspace action before starting another.',
      )
    const id = randomUUID()
    const session: Session = {
      owner,
      request,
      grant,
      controller: new AbortController(),
      leases: [],
      consumed: false,
      disposed: false,
    }
    this.sessions.set(id, session)
    const roots = hostPathEquals(request.workspaceRoot, request.destination.root)
      ? [request.workspaceRoot]
      : [request.workspaceRoot, request.destination.root]
    for (const root of roots)
      session.leases.push(
        this.resources.register(
          owner,
          {
            lifetime: 'workspace',
            type: 'skillager-request',
            root,
            id: `exposure:${id}`,
          },
          () => this.release(owner, id),
        ),
      )
    const timer = setTimeout(
      () => session.controller.abort(),
      SKILLAGER_REQUEST_DEADLINE_MS,
    )
    const task = this.cli.previewExposure(
      grant.selection,
      request,
      session.controller.signal,
    )
    session.pending = task
    try {
      session.snapshot = await task
      this.current(session)
      grant.validatePreview?.(session.snapshot)
      return { ...session.snapshot.detail, previewId: id }
    } catch (error) {
      session.pending = undefined
      await this.release(owner, id)
      throw error
    } finally {
      clearTimeout(timer)
      session.pending = undefined
    }
  }

  async apply(owner: RendererOwner, id: string) {
    const session = this.sessions.get(id)
    if (
      !session ||
      !sameOwner(session.owner, owner) ||
      !session.snapshot ||
      session.consumed
    )
      throw new SkillagerError(
        'review-expired',
        'This workspace confirmation expired or was already used. Refresh and preview again.',
      )
    this.current(session)
    if (session.pending)
      throw new SkillagerError('busy', 'Wait for the current workspace action.')
    session.consumed = true
    const task = this.cli.applyExposure(
      session.grant.selection,
      session.snapshot,
      session.controller.signal,
    )
    session.pending = task
    try {
      // A completed mutation remains factual even if its originating view departed.
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
    for (const lease of session.leases.reverse()) lease.release()
    await session.pending?.catch(() => undefined)
  }
  async cancel(owner: RendererOwner, requestId: number): Promise<void> {
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
    await Promise.all(
      [...this.sessions]
        .filter(([, session]) => !owner || sameOwner(session.owner, owner))
        .map(([id, session]) => this.release(session.owner, id)),
    )
  }
  private current(session: Session): void {
    this.resources.assertCurrent(session.owner)
    session.grant.assertCurrent()
    if (session.disposed || session.controller.signal.aborted)
      throw new SkillagerError('cancelled', 'Workspace skill action cancelled.')
  }
}
function sameOwner(left: RendererOwner, right: RendererOwner): boolean {
  return left.id === right.id && left.generation === right.generation
}
