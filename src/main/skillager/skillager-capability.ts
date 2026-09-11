import type {
  SkillagerSkillRequest,
  SkillagerReviewRequest,
} from '../../shared/skillager-review'
import { SkillagerReviewOwner } from './skillager-review-owner'
import type {
  SkillagerReviewCliPort,
  SkillagerReviewPreviewPort,
} from './skillager-review-port'
import { randomUUID } from 'node:crypto'
import type { HostPath } from '../../shared/host-path'
import {
  SKILLAGER_QUERY_BYTES,
  SKILLAGER_AGENTS,
  type SkillagerConnection,
  type SkillagerMetadataResult,
  type SkillagerProbe,
  type SkillagerRequest,
  type SkillagerResult,
  type SkillagerSearchRequest,
} from '../../shared/skillager'
import type { RendererOwner, RendererResourceScopes } from '../renderer-resource-scopes'
import type { SkillagerCliPort, SkillagerCliSelection } from './skillager-port'
import { SkillagerError, SKILLAGER_REQUEST_DEADLINE_MS } from './skillager-port'

interface RequestState {
  readonly id: number
  readonly controller: AbortController
  readonly start: () => Promise<void>
  readonly discard: () => void
}
interface RequestLane {
  active?: RequestState
  pending?: RequestState
}
interface OwnerState {
  enabled: boolean
  generation: number
  selection?: SkillagerCliSelection
  probeId?: string
  connectionId?: string
  probe?: AbortController
  readonly lanes: { search: RequestLane; inventory: RequestLane }
  latest: { search: number; inventory: number }
}

export class SkillagerCapability {
  private readonly owners = new Map<string, OwnerState>()
  private readonly jobs = new Map<Promise<unknown>, string>()
  private disposed = false
  private readonly reviews?: SkillagerReviewOwner

  constructor(
    private readonly cli: SkillagerCliPort,
    private readonly resources: Pick<
      RendererResourceScopes,
      'assertCurrent' | 'isCurrent' | 'register'
    >,
    private readonly workspaceAvailable: (root: HostPath) => boolean,
    review?: {
      readonly cli: SkillagerReviewCliPort
      readonly previews: SkillagerReviewPreviewPort
    },
  ) {
    if (review)
      this.reviews = new SkillagerReviewOwner(review.cli, resources, review.previews)
  }

  configure(owner: RendererOwner, enabled: boolean): void {
    this.resources.assertCurrent(owner)
    if (this.disposed) return
    void this.revoke(owner)
    if (!enabled) return
    this.owners.set(key(owner), {
      enabled: true,
      generation: 0,
      latest: { search: 0, inventory: 0 },
      lanes: { search: {}, inventory: {} },
    })
    this.resources.register(
      owner,
      { lifetime: 'renderer', type: 'skillager' },
      () => this.revoke(owner),
      { duplicate: 'reuse' },
    )
  }

  probe(
    owner: RendererOwner,
    executable?: HostPath,
  ): Promise<SkillagerResult<SkillagerProbe>> {
    return this.track(
      owner,
      result(async () => {
        const state = this.state(owner)
        this.disconnect(owner)
        const generation = state.generation
        const controller = new AbortController()
        state.probe = controller
        try {
          const selection = await this.cli.probe(executable, controller.signal)
          this.current(owner, state, generation)
          const probeId = randomUUID()
          state.selection = selection
          state.probeId = probeId
          return {
            probeId,
            executable: selection.executable,
            version: selection.version,
            library: selection.library,
          }
        } catch (error) {
          this.current(owner, state, generation)
          throw error
        } finally {
          if (state.probe === controller) state.probe = undefined
        }
      }),
    )
  }

  connect(
    owner: RendererOwner,
    probeId: string,
  ): Promise<SkillagerResult<SkillagerConnection>> {
    return this.track(
      owner,
      result(async () => {
        const state = this.state(owner)
        if (!state.selection || probeId !== state.probeId)
          throw new SkillagerError(
            'disconnected',
            'Check Skillager again before connecting.',
          )
        if (!state.selection.library)
          throw new SkillagerError(
            'not-initialized',
            'Initialize your Skillager library in your local terminal, then check again.',
          )
        const generation = ++state.generation
        state.probe?.abort()
        const controller = new AbortController()
        state.probe = controller
        try {
          await this.cli.validate(state.selection, controller.signal)
        } catch (error) {
          this.current(owner, state, generation)
          throw error
        } finally {
          if (state.probe === controller) state.probe = undefined
        }
        this.current(owner, state, generation)
        state.connectionId = randomUUID()
        return {
          connectionId: state.connectionId,
          executable: state.selection.executable,
          version: state.selection.version,
          library: state.selection.library,
        }
      }),
    )
  }

  disconnect(owner: RendererOwner): void {
    const state = this.owners.get(key(owner))
    if (!state) return
    state.generation++
    if (this.reviews) void this.track(owner, this.reviews.revoke(owner))
    state.probe?.abort()
    this.cancelLane(state.lanes.search)
    this.cancelLane(state.lanes.inventory)
    state.connectionId = undefined
    state.probeId = undefined
    state.selection = undefined
  }

  search(
    owner: RendererOwner,
    request: SkillagerSearchRequest,
  ): Promise<SkillagerResult<SkillagerMetadataResult>> {
    return this.read(owner, 'search', request, (selection, signal) => {
      if (
        typeof request.query !== 'string' ||
        request.query.trim().length === 0 ||
        Buffer.byteLength(request.query) > SKILLAGER_QUERY_BYTES ||
        request.query.includes('\0') ||
        !['library', 'workspace'].includes(request.scope)
      )
        throw new SkillagerError(
          'invalid-request',
          'Enter a search of at most 1,000 UTF-8 bytes.',
        )
      if (request.scope === 'workspace' && request.workspaceRoot.hostId !== 'local') {
        throw new SkillagerError(
          'unavailable',
          'Use Personal library for an SSH workspace.',
        )
      }
      return this.cli.search(selection, request, signal)
    })
  }

  inventory(
    owner: RendererOwner,
    request: SkillagerRequest,
  ): Promise<SkillagerResult<SkillagerMetadataResult>> {
    return this.read(owner, 'inventory', request, (selection, signal) =>
      this.cli.inventory(selection, signal),
    )
  }

  cancel(owner: RendererOwner, kind: 'search' | 'inventory', requestId: number): void {
    const state = this.owners.get(key(owner))
    if (!state || !Number.isSafeInteger(requestId) || requestId < 1) return
    state.latest[kind] = Math.max(state.latest[kind], requestId)
    const lane = state.lanes[kind]
    if (lane.active && lane.active.id <= requestId) lane.active.controller.abort()
    if (lane.pending && lane.pending.id <= requestId) {
      lane.pending.discard()
      lane.pending = undefined
    }
  }

  async revoke(owner: RendererOwner): Promise<void> {
    this.disconnect(owner)
    this.owners.delete(key(owner))
    await Promise.allSettled(
      [...this.jobs]
        .filter(([, ownerKey]) => ownerKey === key(owner))
        .map(([job]) => job),
    )
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const state of this.owners.values()) {
      state.generation++
      state.probe?.abort()
      this.cancelLane(state.lanes.search)
      this.cancelLane(state.lanes.inventory)
    }
    this.owners.clear()
    await this.reviews?.revoke()
    await Promise.allSettled([...this.jobs.keys()])
  }

  review(owner: RendererOwner, request: SkillagerSkillRequest) {
    return this.track(
      owner,
      result(() =>
        this.reviewOwner().review(owner, request, this.reviewGrant(owner, request)),
      ),
    )
  }
  history(owner: RendererOwner, request: SkillagerSkillRequest) {
    return this.track(
      owner,
      result(() =>
        this.reviewOwner().history(owner, request, this.reviewGrant(owner, request)),
      ),
    )
  }
  reviewContent(
    owner: RendererOwner,
    request: SkillagerReviewRequest & {
      readonly entry: string
      readonly documentEntry?: string
    },
  ) {
    return result(() => Promise.resolve(this.reviewOwner().content(owner, request)))
  }
  reviewDiff(
    owner: RendererOwner,
    request: SkillagerReviewRequest & { readonly fromHash?: string },
  ) {
    return this.track(
      owner,
      result(() => this.reviewOwner().diff(owner, request)),
    )
  }
  acceptReview(owner: RendererOwner, request: SkillagerReviewRequest) {
    return this.track(
      owner,
      result(() => this.reviewOwner().accept(owner, request)),
    )
  }
  cancelReview(owner: RendererOwner, requestId: number): Promise<void> {
    return this.reviews?.cancel(owner, requestId) ?? Promise.resolve()
  }
  releaseReview(owner: RendererOwner, reviewId: string): Promise<void> {
    return this.reviews?.release(owner, reviewId) ?? Promise.resolve()
  }
  private reviewOwner(): SkillagerReviewOwner {
    if (!this.reviews)
      throw new SkillagerError('unavailable', 'Skill review is unavailable.')
    return this.reviews
  }
  private reviewGrant(owner: RendererOwner, request: SkillagerRequest) {
    const state = this.state(owner),
      generation = state.generation
    if (
      !state.selection ||
      !state.connectionId ||
      request.connectionId !== state.connectionId ||
      !Number.isSafeInteger(request.requestId) ||
      request.requestId < 1 ||
      !SKILLAGER_AGENTS.some((agent) => agent.id === request.agent) ||
      !this.workspaceAvailable(request.workspaceRoot)
    )
      throw new SkillagerError(
        'invalid-request',
        'The connected skill workspace is unavailable.',
      )
    return {
      selection: state.selection,
      assertCurrent: () => {
        this.current(owner, state, generation)
        if (!this.workspaceAvailable(request.workspaceRoot))
          throw new SkillagerError('cancelled', 'The skill workspace changed.')
      },
    }
  }

  private track<T>(owner: RendererOwner, job: Promise<T>): Promise<T> {
    this.jobs.set(job, key(owner))
    void job.then(
      () => this.jobs.delete(job),
      () => this.jobs.delete(job),
    )
    return job
  }

  private cancelLane(lane: RequestLane): void {
    lane.active?.controller.abort()
    lane.pending?.discard()
    lane.pending = undefined
  }

  private pump(lane: RequestLane): void {
    if (lane.active || !lane.pending) return
    const active = lane.pending
    lane.pending = undefined
    lane.active = active
    void active.start().finally(() => {
      lane.active = undefined
      this.pump(lane)
    })
  }

  private read(
    owner: RendererOwner,
    kind: 'search' | 'inventory',
    request: SkillagerRequest,
    operation: (
      selection: SkillagerCliSelection,
      signal: AbortSignal,
    ) => ReturnType<SkillagerCliPort['inventory']>,
  ): Promise<SkillagerResult<SkillagerMetadataResult>> {
    return this.track(
      owner,
      result(async () => {
        const state = this.state(owner)
        const generation = state.generation
        if (
          !state.selection ||
          !state.connectionId ||
          state.connectionId !== request.connectionId
        )
          throw new SkillagerError(
            'disconnected',
            'Connect your Skillager library first.',
          )
        if (
          !Number.isSafeInteger(request.requestId) ||
          request.requestId <= state.latest[kind] ||
          !SKILLAGER_AGENTS.some((agent) => agent.id === request.agent) ||
          !this.workspaceAvailable(request.workspaceRoot)
        ) {
          throw new SkillagerError(
            'invalid-request',
            'The Skillager workspace or request is no longer available.',
          )
        }
        const selection = state.selection
        const lane = state.lanes[kind]
        this.cancelLane(lane)
        state.latest[kind] = request.requestId
        return new Promise<SkillagerMetadataResult>((resolve, reject) => {
          const controller = new AbortController()
          const cancelled = (): SkillagerError =>
            new SkillagerError('cancelled', 'Skillager request cancelled.')
          let finish = (): void => undefined
          const completed = new Promise<void>((resolveDone) => {
            finish = resolveDone
          })
          const lease = this.resources.register(
            owner,
            {
              lifetime: 'workspace',
              type: 'skillager-request',
              root: request.workspaceRoot,
              id: `${kind}:${request.requestId}`,
            },
            () => {
              controller.abort()
              return completed
            },
          )
          const active: RequestState = {
            id: request.requestId,
            controller,
            discard: () => {
              controller.abort()
              lease.release()
              finish()
              reject(cancelled())
            },
            start: async () => {
              const started = performance.now()
              let timedOut = false
              const deadline = setTimeout(() => {
                timedOut = true
                controller.abort()
              }, SKILLAGER_REQUEST_DEADLINE_MS)
              try {
                this.current(owner, state, generation)
                if (controller.signal.aborted) throw cancelled()
                const rows = await operation(selection, controller.signal)
                const exposures = await this.cli.exposures(
                  selection,
                  request,
                  controller.signal,
                )
                this.current(owner, state, generation)
                if (
                  controller.signal.aborted ||
                  state.latest[kind] !== request.requestId ||
                  !this.workspaceAvailable(request.workspaceRoot)
                )
                  throw cancelled()
                resolve({
                  rows,
                  exposures,
                  checkedAt: Date.now(),
                  durationMs: performance.now() - started,
                })
              } catch (error) {
                if (error instanceof SkillagerError && error.reason === 'library-changed')
                  this.disconnect(owner)
                reject(
                  timedOut
                    ? new SkillagerError('timeout', 'Skillager took too long. Try again.')
                    : controller.signal.aborted || !this.resources.isCurrent(owner)
                      ? cancelled()
                      : error instanceof Error
                        ? error
                        : new Error('Skillager request failed.'),
                )
              } finally {
                clearTimeout(deadline)
                lease.release()
                finish()
              }
            },
          }
          lane.pending = active
          this.pump(lane)
        })
      }),
    )
  }

  private state(owner: RendererOwner): OwnerState {
    if (!this.resources.isCurrent(owner))
      throw new SkillagerError('cancelled', 'Skillager request cancelled.')
    const state = this.owners.get(key(owner))
    if (this.disposed || !state?.enabled)
      throw new SkillagerError('disabled', 'Skillager is disabled.')
    return state
  }

  private current(owner: RendererOwner, state: OwnerState, generation: number): void {
    if (
      !this.resources.isCurrent(owner) ||
      this.owners.get(key(owner)) !== state ||
      state.generation !== generation
    )
      throw new SkillagerError('cancelled', 'Skillager request cancelled.')
  }
}

function key(owner: RendererOwner): string {
  return `${owner.id}:${owner.generation}`
}

export async function result<T>(
  operation: () => Promise<T>,
): Promise<SkillagerResult<T>> {
  try {
    return { ok: true, value: await operation() }
  } catch (error) {
    if (error instanceof SkillagerError)
      return { ok: false, reason: error.reason, message: error.message }
    return {
      ok: false,
      reason: 'command-failed',
      message: 'Skillager request failed. Try again.',
    }
  }
}
