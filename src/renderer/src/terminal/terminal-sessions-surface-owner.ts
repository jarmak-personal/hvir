import type {
  SessionsTerminalSurfaceLease,
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

  acquire(
    request: SessionsTerminalSurfaceRequest,
  ): SessionsTerminalSurfaceLease | undefined {
    const context = this.context()
    if (
      context.disposed ||
      this.active ||
      request.handle !== context.sessionId ||
      !context.started ||
      context.ptyInstanceId !== request.livePty.handle ||
      !context.pane ||
      !context.connected
    ) {
      return undefined
    }
    const generation = this.surface.acquireLease()
    if (generation === undefined) return undefined
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
    return {
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
    if (
      !current() ||
      next.handle !== state.request.handle ||
      next.workspaceQualifier !== state.request.workspaceQualifier ||
      next.livePty.handle !== state.request.livePty.handle ||
      next.livePty.rendererOwnerId !== state.request.livePty.rendererOwnerId ||
      next.livePty.rendererGeneration !== state.request.livePty.rendererGeneration ||
      next.sourceRevision !== state.request.sourceRevision ||
      next.projectionRevision < state.request.projectionRevision
    ) {
      return false
    }
    state.request = next
    return true
  }
}
