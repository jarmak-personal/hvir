import type {
  SessionsTerminalSurfaceAvailability,
  SessionsTerminalSurfaceLease,
  SessionsTerminalSurfacePort,
  SessionsTerminalSurfaceRequest,
  SessionsTerminalSurfaceRevocationReason,
} from '../sessions/sessions-terminal-surface'
import type { TerminalPane } from './terminal-pane'
import type { TerminalSurfaceAttachment } from './terminal-surface-attachment'

interface SessionsSurfaceRuntimeContext {
  readonly disposed: boolean
  readonly sessionId: string
  readonly started: boolean
  readonly ptyInstanceId?: string
  readonly pane?: TerminalPane
  readonly connected: boolean
  readonly focused: () => void
}

interface ActiveLease {
  readonly generation: number
  request: SessionsTerminalSurfaceRequest
  readonly listeners: Set<(reason: SessionsTerminalSurfaceRevocationReason) => void>
}

/** Exclusive Sessions borrower beneath one exact TerminalRuntime. */
export class TerminalSessionsSurfaceOwner {
  private active?: ActiveLease

  constructor(
    private readonly surface: TerminalSurfaceAttachment,
    private readonly context: () => SessionsSurfaceRuntimeContext,
  ) {}

  private availability(
    request: Pick<SessionsTerminalSurfaceRequest, 'handle' | 'livePty'>,
  ): SessionsTerminalSurfaceAvailability {
    const context = this.context()
    if (context.disposed || !context.started || !context.pane || !context.connected) {
      return { outcome: 'unavailable', reason: 'runtime-not-ready' }
    }
    if (
      request.handle !== context.sessionId ||
      context.ptyInstanceId !== request.livePty.handle
    ) {
      return { outcome: 'unavailable', reason: 'instance-mismatch' }
    }
    if (this.active) return { outcome: 'unavailable', reason: 'lease-conflict' }
    return { outcome: 'available' }
  }

  acquire(
    request: SessionsTerminalSurfaceRequest,
  ): ReturnType<SessionsTerminalSurfacePort['acquire']> {
    const availability = this.availability(request)
    if (availability.outcome === 'unavailable') return availability
    const generation = this.surface.acquireLease()
    if (generation === undefined) {
      return { outcome: 'unavailable', reason: 'lease-conflict' }
    }
    const state: ActiveLease = { generation, request, listeners: new Set() }
    this.active = state
    let released = false
    const current = (): boolean => {
      const latest = this.context()
      return (
        !released &&
        this.active === state &&
        !latest.disposed &&
        latest.connected &&
        latest.started &&
        latest.ptyInstanceId === state.request.livePty.handle &&
        latest.pane !== undefined &&
        this.surface.isCurrentLease(generation)
      )
    }
    const lease: SessionsTerminalSurfaceLease = {
      renew: (next) => this.renew(state, next, current),
      attach: (container) =>
        current() && this.surface.attachLease(generation, container, 'visible'),
      detach: (container) => {
        if (current()) this.surface.detachLease(generation, container)
      },
      setVisible: (container, visible) =>
        current() &&
        this.surface.setLeasePresentation(
          generation,
          container,
          visible ? 'visible' : 'hidden',
        ),
      focus: (container) => {
        const latest = this.context()
        if (
          !current() ||
          !this.surface.isCurrentLease(generation, container) ||
          !this.surface.canFocus() ||
          !latest.pane
        ) {
          return false
        }
        latest.pane.focus()
        latest.focused()
        return true
      },
      subscribe: (listener) => {
        if (current()) state.listeners.add(listener)
        return () => state.listeners.delete(listener)
      },
      release: () => {
        if (released) return
        released = true
        state.listeners.clear()
        if (this.active !== state) return
        this.active = undefined
        this.surface.releaseLease(generation)
      },
    }
    return { outcome: 'acquired', lease }
  }

  revoke(reason: SessionsTerminalSurfaceRevocationReason): void {
    const lease = this.active
    if (!lease) return
    this.active = undefined
    this.surface.releaseLease(lease.generation)
    for (const listener of lease.listeners) listener(reason)
    lease.listeners.clear()
  }

  private renew(
    state: ActiveLease,
    next: SessionsTerminalSurfaceRequest,
    current: () => boolean,
  ): boolean {
    // The acquired runtime already owns the exact workspace surface. Projection
    // revisions may advance while that runtime and PTY identity remain unchanged.
    if (
      !current() ||
      next.handle !== state.request.handle ||
      next.workspaceRuntimeId !== state.request.workspaceRuntimeId ||
      next.livePty.handle !== state.request.livePty.handle ||
      next.livePty.rendererOwnerId !== state.request.livePty.rendererOwnerId ||
      next.livePty.rendererGeneration !== state.request.livePty.rendererGeneration ||
      next.demandGeneration !== state.request.demandGeneration ||
      next.sourceRevision < state.request.sourceRevision ||
      next.projectionRevision < state.request.projectionRevision
    ) {
      return false
    }
    state.request = next
    return true
  }
}
