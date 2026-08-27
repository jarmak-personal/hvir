import { TerminalRuntimeRegistry } from './terminal-runtime-registry'
import type { TerminalWorkspaceController } from './use-terminal-workspace-move'
import type { SessionsRendererSession } from '../sessions/sessions-renderer-observation'

interface ControllerWaiter {
  readonly resolve: () => void
  readonly reject: (reason: Error) => void
}

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
  private readonly sessionsListeners = new Set<() => void>()
  private materializedSnapshot: readonly string[] = []
  private disposed = false

  snapshot = (): readonly string[] => this.materializedSnapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  sessionsSnapshot = (): readonly SessionsRendererSession[] =>
    [...this.sessionsSources.values()].flatMap((source) => source())

  subscribeSessions = (listener: () => void): (() => void) => {
    this.sessionsListeners.add(listener)
    return () => this.sessionsListeners.delete(listener)
  }

  readonly sessionsObservation = {
    snapshot: this.sessionsSnapshot,
    subscribe: this.subscribeSessions,
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
    for (const workspaceId of this.controllerWaiters.keys()) {
      this.rejectWaiters(
        workspaceId,
        new Error('Terminal workspace runtime owner was disposed'),
      )
    }
    this.controllers.clear()
    this.sessionsSources.clear()
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
