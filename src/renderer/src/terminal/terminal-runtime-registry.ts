import { hostPathEquals, type HostPath } from '../../../shared'
import { TerminalRuntime, type TerminalRuntimeOptions } from './terminal-runtime'

export class TerminalRuntimeRegistry {
  private readonly runtimes = new Map<string, TerminalRuntime>()

  acquire(options: TerminalRuntimeOptions): TerminalRuntime {
    const existing = this.runtimes.get(options.sessionId)
    if (existing) {
      existing.update(options)
      return existing
    }
    const runtime = new TerminalRuntime(options, (previousId, nextId, value) => {
      if (this.runtimes.get(previousId) !== value) {
        throw new Error('Terminal runtime identity changed while it was not registered')
      }
      const collision = this.runtimes.get(nextId)
      if (collision && collision !== value) {
        throw new Error(`Terminal runtime '${nextId}' is already registered`)
      }
      this.runtimes.delete(previousId)
      this.runtimes.set(nextId, value)
    })
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

  dispose(): void {
    for (const runtime of this.runtimes.values()) runtime.dispose()
    this.runtimes.clear()
  }
}
