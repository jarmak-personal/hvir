import { hostPathEquals, TerminalStartAdmission, type HostPath } from '../../../shared'
import { TerminalEventRouter } from './terminal-event-router'
import { TerminalRuntime } from './terminal-runtime'
import type { TerminalRuntimeOptions } from './terminal-runtime-options'
import type { TerminalRuntimeSnapshot } from './terminal-runtime-presentation'
import type {
  SessionsTerminalSurfaceLease,
  SessionsTerminalSurfaceRequest,
} from '../sessions/sessions-terminal-surface'

export class TerminalRuntimeRegistry {
  private readonly runtimes = new Map<string, TerminalRuntime>()
  private eventRouter?: TerminalEventRouter
  private readonly startAdmission = new TerminalStartAdmission(2)

  acquire(options: TerminalRuntimeOptions): TerminalRuntime {
    const existing = this.runtimes.get(options.sessionId)
    if (existing) {
      existing.update(options)
      return existing
    }
    const runtime = new TerminalRuntime(
      options,
      () => (this.eventRouter ??= new TerminalEventRouter(window.hvir)),
      (previousId, nextId, value) => {
        if (this.runtimes.get(previousId) !== value) {
          throw new Error('Terminal runtime identity changed while it was not registered')
        }
        const collision = this.runtimes.get(nextId)
        if (collision && collision !== value) {
          throw new Error(`Terminal runtime '${nextId}' is already registered`)
        }
        this.runtimes.delete(previousId)
        this.runtimes.set(nextId, value)
      },
      (hostId, signal) => this.startAdmission.acquire(hostId, signal),
    )
    this.runtimes.set(options.sessionId, runtime)
    return runtime
  }

  disposeSession(id: string): string | undefined {
    const runtime = this.runtimes.get(id)
    if (!runtime) return undefined
    this.runtimes.delete(id)
    const pendingReplacementId = runtime.cancelPendingReplacement()
    runtime.dispose()
    return pendingReplacementId
  }

  disposeMissingWorkspaces(roots: readonly HostPath[]): void {
    for (const [id, runtime] of this.runtimes) {
      if (roots.some((root) => hostPathEquals(root, runtime.workspaceRoot))) continue
      this.runtimes.delete(id)
      runtime.dispose()
    }
  }

  openSearch(): boolean {
    for (const runtime of this.runtimes.values()) {
      if (runtime.interactions.search.open()) return true
    }
    return false
  }

  sessionSnapshot(id: string): TerminalRuntimeSnapshot | undefined {
    return this.runtimes.get(id)?.snapshot()
  }

  focusLiveInstance(id: string, instanceId: string): boolean {
    return this.runtimes.get(id)?.focusLiveInstance(instanceId) === true
  }

  acquireSessionsSurface(
    request: SessionsTerminalSurfaceRequest,
  ): SessionsTerminalSurfaceLease | undefined {
    return this.runtimes.get(request.handle)?.acquireSessionsSurface(request)
  }

  dispose(): void {
    for (const runtime of this.runtimes.values()) runtime.dispose()
    this.runtimes.clear()
    this.eventRouter?.dispose()
    this.eventRouter = undefined
  }
}
