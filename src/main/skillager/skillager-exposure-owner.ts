import type { SkillagerRequest } from '../../shared/skillager'
import type { SkillagerLibrarySyncCliPort } from './skillager-library-sync-port'
import type { SkillagerExposureLineageRequest } from '../../shared/skillager-exposure-plan'
import { validateLifecycleSelection } from './skillager-exposure-plan-selection'
import { skillagerLibrarySkillRoot } from './skillager-library-identity'
import type {
  SkillagerLocalActionPort,
  SkillagerLocalActionSnapshot,
} from './skillager-exposure-plan-commands'
import type {
  SkillagerExposureActionRequest,
  SkillagerPreviewFor,
} from '../../shared/skillager-exposure-plan'
import { validateExposureSelection } from './skillager-exposure-selection'
import { randomUUID } from 'node:crypto'
import { hostPathEquals } from '../../shared/host-path'
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
  readonly request: SkillagerExposureActionRequest | SkillagerExposureLineageRequest
  readonly grant: SkillagerExposureGrant
  readonly controller: AbortController
  readonly leases: RendererResourceLease[]
  snapshot?: SkillagerExposureSnapshot | SkillagerLocalActionSnapshot
  pending?: Promise<unknown>
  consumed: boolean
  disposed: boolean
}

/** One explicit action owns both its originating workspace and selected destination. */
export class SkillagerExposureOwner {
  private readonly sessions = new Map<string, Session>()
  private readonly pendingDestinations = new Map<string, Session>()
  private readonly uncertainDestinations = new Set<string>()
  constructor(
    private readonly cli: Pick<
      SkillagerExposureCliPort,
      'previewExposure' | 'applyExposure'
    >,
    private readonly resources: Pick<
      RendererResourceScopes,
      'register' | 'assertCurrent'
    >,
    private readonly local?: SkillagerLocalActionPort &
      Pick<SkillagerLibrarySyncCliPort, 'syncStatus'>,
  ) {}

  async preview<T extends SkillagerExposureActionRequest>(
    owner: RendererOwner,
    request: T,
    grant: SkillagerExposureGrant,
  ): Promise<SkillagerPreviewFor<T>> {
    grant.assertCurrent()
    validateActionSelection(request, grant)
    this.available(request)
    const { session, id } = this.begin(owner, request, grant)
    const timer = setTimeout(
      () => session.controller.abort(),
      SKILLAGER_REQUEST_DEADLINE_MS,
    )
    const task =
      request.action === 'plan' || request.action === 'remove-router'
        ? this.local!.previewLocalAction(
            grant.selection,
            request,
            session.controller.signal,
          )
        : this.cli.previewExposure(grant.selection, request, session.controller.signal)
    session.pending = task
    try {
      session.snapshot = await task
      this.current(session)
      if (!('kind' in session.snapshot.detail))
        grant.validatePreview?.(session.snapshot as SkillagerExposureSnapshot)
      return { ...session.snapshot.detail, previewId: id } as SkillagerPreviewFor<T>
    } catch (error) {
      session.pending = undefined
      await this.release(owner, id)
      throw error
    } finally {
      clearTimeout(timer)
      session.pending = undefined
    }
  }

  async inspectLineage(
    owner: RendererOwner,
    request: SkillagerExposureLineageRequest,
    grant: SkillagerExposureGrant,
  ) {
    grant.assertCurrent()
    if (
      !this.local ||
      request.workspaceRoot.hostId !== 'local' ||
      !hostPathEquals(request.workspaceRoot, request.destination.root)
    )
      throw new SkillagerError(
        'unsupported',
        'Native preservation can be checked only in the exact current local project.',
      )
    this.available(request)
    const { session, id } = this.begin(owner, request, grant)
    const timer = setTimeout(
      () => session.controller.abort(),
      SKILLAGER_REQUEST_DEADLINE_MS,
    )
    try {
      const task = this.local.syncStatus(
        grant.selection,
        request.workspaceRoot,
        session.controller.signal,
      )
      session.pending = task
      const report = await task
      this.current(session)
      return report
    } finally {
      session.pending = undefined
      clearTimeout(timer)
      await this.release(owner, id)
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
    this.available(session.request)
    session.consumed = true
    const destination = destinationKey(session.request)
    if (destination) this.pendingDestinations.set(destination, session)
    let submitted = false
    const snapshot = session.snapshot
    const task =
      'kind' in snapshot.detail
        ? this.local!.applyLocalAction(
            session.grant.selection,
            snapshot as SkillagerLocalActionSnapshot,
            session.controller.signal,
            () => {
              this.current(session)
              submitted = true
              if (destination) this.uncertainDestinations.add(destination)
            },
          )
        : this.cli.applyExposure(
            session.grant.selection,
            snapshot as SkillagerExposureSnapshot,
            session.controller.signal,
          )
    session.pending = task
    try {
      // A completed mutation remains factual even if its originating view departed.
      const completion = await task
      if (destination) {
        const unresolved =
          'kind' in completion &&
          completion.kind === 'plan' &&
          completion.targets.some(
            (target) => target.status === 'recovery_required' || target.recoveryPath,
          )
        if (unresolved) this.uncertainDestinations.add(destination)
        else this.uncertainDestinations.delete(destination)
      }
      return completion
    } catch (error) {
      if (error instanceof SkillagerError && error.reason === 'busy')
        session.consumed = false
      if (destination) {
        if (
          error instanceof SkillagerError &&
          ['busy', 'review-refused', 'stale-review'].includes(error.reason)
        )
          this.uncertainDestinations.delete(destination)
        else if (
          submitted ||
          (error instanceof SkillagerError && error.reason === 'uncertain')
        )
          this.uncertainDestinations.add(destination)
      }
      throw error
    } finally {
      session.pending = undefined
      if (destination && this.pendingDestinations.get(destination) === session)
        this.pendingDestinations.delete(destination)
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
    if (session.snapshot && !('kind' in session.snapshot.detail))
      await (session.snapshot as SkillagerExposureSnapshot).dispose?.()
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
  private begin(
    owner: RendererOwner,
    request: SkillagerExposureActionRequest | SkillagerExposureLineageRequest,
    grant: SkillagerExposureGrant,
  ) {
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
    return { session, id }
  }
  private available(
    request: SkillagerExposureActionRequest | SkillagerExposureLineageRequest,
  ): void {
    const destination = destinationKey(request)
    if (destination && this.pendingDestinations.has(destination))
      throw new SkillagerError(
        'busy',
        'Wait for the previous project action to finish stopping.',
      )
    if (destination && this.uncertainDestinations.has(destination))
      throw new SkillagerError(
        'uncertain',
        'A prior action has unresolved project targets, tags or recovery material. Refresh and reconnect cannot establish its complete outcome; inspect it in Skillager before further project changes.',
      )
    if (
      'action' in request &&
      (request.action === 'plan' || request.action === 'remove-router') &&
      !this.local
    )
      throw new SkillagerError('unsupported', 'Local lifecycle actions are unavailable.')
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

function destinationKey(
  request: SkillagerRequest & {
    readonly destination: import('../../shared/skillager-exposure').SkillagerDestination
  },
): string | undefined {
  return request.destination.root.hostId === 'local'
    ? JSON.stringify([request.destination.root.hostId, request.destination.root.path])
    : undefined
}
function validateActionSelection(
  request: SkillagerExposureActionRequest,
  grant: SkillagerExposureGrant,
): void {
  if (request.action === 'plan' || request.action === 'remove-router')
    return validateLifecycleSelection(request, grant.selection)
  validateExposureSelection(request)
  if (request.action !== 'remove')
    skillagerLibrarySkillRoot(grant.selection.library!, request.skillId)
  if (
    !['add', 'change', 'remove', 'update'].includes(request.action) ||
    !['native', 'stub'].includes(request.mode) ||
    (request.action !== 'add' &&
      (request.exposure?.skillId !== request.skillId ||
        !['native', 'stub'].includes(request.exposure.mode)))
  )
    throw new SkillagerError(
      'invalid-request',
      'Select the exact source or managed project copy for this action.',
    )
}
/** Compose exposure authority here; Update still consumes its explicit content-review grant. */
export function exposureActionGrant(
  request: SkillagerExposureActionRequest,
  grant: SkillagerExposureGrant,
  update: Pick<SkillagerExposureGrant, 'assertCurrent' | 'validatePreview'> | undefined,
  destinationAvailable: import('./skillager-exposure-port').SkillagerDestinationAvailable,
): SkillagerExposureGrant {
  validateActionSelection(request, grant)
  const assertCurrent = () => {
    grant.assertCurrent()
    update?.assertCurrent()
    if (!destinationAvailable(request.destination))
      throw new SkillagerError(
        'unavailable',
        'The selected destination is disconnected, closed, missing, or no longer registered.',
      )
  }
  assertCurrent()
  return {
    selection: grant.selection,
    assertCurrent,
    validatePreview: update?.validatePreview,
  }
}
