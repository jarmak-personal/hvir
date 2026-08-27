import { TerminalRuntimeRegistry } from './terminal-runtime-registry'
import type { TerminalWorkspaceController } from './use-terminal-workspace-move'
import type { SessionsRendererSession } from '../sessions/sessions-renderer-observation'
import type {
  SessionsTerminalSurfaceCapabilityRequest,
  SessionsTerminalSurfacePort,
  SessionsTerminalSurfaceRequest,
} from '../sessions/sessions-terminal-surface'
import type {
  SessionsLivePtyQualifier,
  SessionsTerminalHandle,
  SessionsWorkspaceQualifier,
} from '../../../shared'

interface ControllerWaiter {
  readonly resolve: () => void
  readonly reject: (reason: Error) => void
}

const PROJECTED_SESSION_FOCUS_FRAME_LIMIT = 12

/** Owns materialized renderer workspace models independently of presentation. */
export class TerminalWorkspaceRuntimeOwner {
  readonly runtimes = new TerminalRuntimeRegistry()

  private readonly retainedWorkspaceIds = new Set<string>()
  private readonly transferWorkspaceIds = new Set<string>()
  private readonly controllers = new Map<string, TerminalWorkspaceController>()
  private readonly controllerWaiters = new Map<string, Set<ControllerWaiter>>()
  private readonly listeners = new Set<() => void>()
  private readonly sessionsSources = new Map<
    string,
    () => readonly SessionsRendererSession[]
  >()
  private readonly sessionsSurfaceEligibility = new Map<
    SessionsTerminalHandle,
    Map<SessionsWorkspaceQualifier, boolean>
  >()
  private readonly sessionsListeners = new Set<() => void>()
  private readonly focusFrames = new Map<number, (focused: boolean) => void>()
  private focusGeneration = 0
  private materializedSnapshot: readonly string[] = []
  private disposed = false

  snapshot = (): readonly string[] => this.materializedSnapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  sessionsSnapshot = (): readonly SessionsRendererSession[] => {
    this.sessionsSurfaceEligibility.clear()
    const sessions: SessionsRendererSession[] = []
    for (const source of this.sessionsSources.values()) {
      for (const session of source()) {
        sessions.push(session)
        const workspaces =
          this.sessionsSurfaceEligibility.get(session.handle) ??
          new Map<SessionsWorkspaceQualifier, boolean>()
        workspaces.set(session.workspaceQualifier, !session.dormant && !session.exited)
        this.sessionsSurfaceEligibility.set(session.handle, workspaces)
      }
    }
    return sessions
  }

  subscribeSessions = (listener: () => void): (() => void) => {
    this.sessionsListeners.add(listener)
    return () => this.sessionsListeners.delete(listener)
  }

  readonly sessionsObservation = {
    snapshot: this.sessionsSnapshot,
    subscribe: this.subscribeSessions,
  }

  readonly sessionsSurface: SessionsTerminalSurfacePort = {
    availability: (request) => this.sessionsSurfaceAvailability(request),
    acquire: (request) => this.acquireSessionsSurface(request),
  }

  registerSessionsSource = (
    workspaceId: string,
    source: (() => readonly SessionsRendererSession[]) | undefined,
  ): void => {
    if (this.disposed) return
    if (source) this.sessionsSources.set(workspaceId, source)
    else this.sessionsSources.delete(workspaceId)
    this.publishSessions()
  }

  sessionsChanged = (workspaceId: string): void => {
    if (!this.sessionsSources.has(workspaceId)) return
    this.publishSessions()
  }

  private acquireSessionsSurface(request: SessionsTerminalSurfaceRequest) {
    if (this.disposed) {
      return { outcome: 'unavailable' as const, reason: 'runtime-not-ready' as const }
    }
    const exact = this.sessionsSources
      .get(request.workspaceRuntimeId)?.()
      .some(
        (session) =>
          session.handle === request.handle && !session.dormant && !session.exited,
      )
    if (!exact) {
      return { outcome: 'unavailable' as const, reason: 'source-missing' as const }
    }
    return this.runtimes.acquireSessionsSurface(request)
  }

  private sessionsSurfaceAvailability(request: SessionsTerminalSurfaceCapabilityRequest) {
    if (this.disposed) {
      return { outcome: 'unavailable' as const, reason: 'runtime-not-ready' as const }
    }
    const eligible = this.sessionsSurfaceEligibility
      .get(request.handle)
      ?.get(request.workspaceQualifier)
    if (eligible !== true) {
      return { outcome: 'unavailable' as const, reason: 'source-missing' as const }
    }
    return this.runtimes.sessionsSurfaceAvailability(request)
  }

  focusProjectedSession(
    handle: SessionsTerminalHandle,
    workspaceQualifier: SessionsWorkspaceQualifier,
    livePty: SessionsLivePtyQualifier,
  ): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false)
    this.cancelFocusFrames()
    const source = [...this.sessionsSources].find(([, snapshot]) =>
      snapshot().some(
        (session) =>
          session.handle === handle &&
          session.workspaceQualifier === workspaceQualifier &&
          !session.dormant &&
          !session.exited,
      ),
    )
    const controller = source ? this.controllers.get(source[0]) : undefined
    if (!controller?.hasSession(handle) || !controller.selectSession(handle)) {
      return Promise.resolve(false)
    }
    const generation = this.focusGeneration
    return new Promise((resolve) => {
      let attempts = 0
      const schedule = (): void => {
        const frame = window.requestAnimationFrame(() => {
          this.focusFrames.delete(frame)
          if (this.disposed || generation !== this.focusGeneration) {
            resolve(false)
            return
          }
          attempts += 1
          if (this.runtimes.focusLiveInstance(handle, livePty.handle)) {
            resolve(true)
            return
          }
          if (attempts >= PROJECTED_SESSION_FOCUS_FRAME_LIMIT) {
            resolve(false)
            return
          }
          schedule()
        })
        this.focusFrames.set(frame, resolve)
      }
      schedule()
    })
  }

  retainWorkspace = (workspaceId: string, retained: boolean): void => {
    if (this.disposed) return
    if (retained) this.retainedWorkspaceIds.add(workspaceId)
    else this.retainedWorkspaceIds.delete(workspaceId)
    this.publishMaterialized()
  }

  registerController = (
    workspaceId: string,
    controller: TerminalWorkspaceController | undefined,
  ): void => {
    if (this.disposed) return
    if (!controller) {
      this.controllers.delete(workspaceId)
      return
    }
    this.controllers.set(workspaceId, controller)
    const waiters = this.controllerWaiters.get(workspaceId)
    if (!waiters) return
    this.controllerWaiters.delete(workspaceId)
    for (const waiter of waiters) waiter.resolve()
  }

  controller(workspaceId: string): TerminalWorkspaceController | undefined {
    return this.controllers.get(workspaceId)
  }

  prepareTransferTarget(workspaceId: string): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error('Terminal workspace runtime owner is disposed'))
    }
    this.transferWorkspaceIds.add(workspaceId)
    this.publishMaterialized()
    if (this.controllers.has(workspaceId)) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const waiters = this.controllerWaiters.get(workspaceId) ?? new Set()
      waiters.add({ resolve, reject })
      this.controllerWaiters.set(workspaceId, waiters)
    })
  }

  releaseTransferTarget = (workspaceId: string): void => {
    if (this.disposed) return
    this.transferWorkspaceIds.delete(workspaceId)
    this.publishMaterialized()
  }

  pruneWorkspaces(workspaceIds: ReadonlySet<string>): void {
    if (this.disposed) return
    for (const workspaceId of this.materializedSnapshot) {
      if (workspaceIds.has(workspaceId)) continue
      this.retainedWorkspaceIds.delete(workspaceId)
      this.transferWorkspaceIds.delete(workspaceId)
      this.controllers.delete(workspaceId)
      this.rejectWaiters(
        workspaceId,
        new Error(`Terminal workspace '${workspaceId}' is no longer available`),
      )
    }
    this.publishMaterialized()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelFocusFrames()
    for (const workspaceId of this.controllerWaiters.keys()) {
      this.rejectWaiters(
        workspaceId,
        new Error('Terminal workspace runtime owner was disposed'),
      )
    }
    this.controllers.clear()
    this.sessionsSources.clear()
    this.sessionsSurfaceEligibility.clear()
    this.transferWorkspaceIds.clear()
    this.retainedWorkspaceIds.clear()
    this.materializedSnapshot = []
    this.listeners.clear()
    this.sessionsListeners.clear()
    this.runtimes.dispose()
  }

  private rejectWaiters(workspaceId: string, reason: Error): void {
    const waiters = this.controllerWaiters.get(workspaceId)
    if (!waiters) return
    this.controllerWaiters.delete(workspaceId)
    for (const waiter of waiters) waiter.reject(reason)
  }

  private cancelFocusFrames(): void {
    this.focusGeneration += 1
    for (const [frame, resolve] of this.focusFrames) {
      window.cancelAnimationFrame(frame)
      resolve(false)
    }
    this.focusFrames.clear()
  }

  private publishMaterialized(): void {
    const next = [
      ...new Set([...this.retainedWorkspaceIds, ...this.transferWorkspaceIds]),
    ]
    if (
      next.length === this.materializedSnapshot.length &&
      next.every((workspaceId, index) => workspaceId === this.materializedSnapshot[index])
    ) {
      return
    }
    this.materializedSnapshot = next
    for (const listener of this.listeners) listener()
  }

  private publishSessions(): void {
    if (this.sessionsListeners.size === 0) return
    for (const listener of this.sessionsListeners) listener()
  }
}
