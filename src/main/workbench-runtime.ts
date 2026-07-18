export interface WorkbenchRuntimeComponents {
  readonly start: () => Promise<void>
  readonly suspend: () => Promise<void>
  readonly reopen: () => void | Promise<void>
  readonly shutdown: () => Promise<void>
}

export type WorkbenchResourceDisposer = () => void | Promise<void>

interface OwnedWorkbenchResource {
  readonly label: string
  readonly dispose: WorkbenchResourceDisposer
}

export type WorkbenchRuntimeState =
  | 'cold'
  | 'starting'
  | 'running'
  | 'suspending'
  | 'suspended'
  | 'reopening'
  | 'stopping'
  | 'stopped'

/** Owns the idempotent lifecycle of the main-process workbench components. */
export class WorkbenchRuntime {
  private currentState: WorkbenchRuntimeState = 'cold'
  private startTask?: Promise<void>
  private suspendTask?: Promise<void>
  private reopenTask?: Promise<void>
  private shutdownTask?: Promise<void>
  private cleanupTask?: Promise<void>
  private readonly ownedResources: OwnedWorkbenchResource[] = []

  constructor(private readonly components: WorkbenchRuntimeComponents) {}

  get state(): WorkbenchRuntimeState {
    return this.currentState
  }

  get isShuttingDown(): boolean {
    return this.currentState === 'stopping' || this.currentState === 'stopped'
  }

  get isShutdown(): boolean {
    return this.currentState === 'stopped'
  }

  /** Registers a long-lived resource for deterministic reverse-order disposal. */
  own<T>(label: string, resource: T, dispose: (resource: T) => void | Promise<void>): T {
    if (this.cleanupTask || this.isShuttingDown) {
      throw new Error(`Cannot register ${label} after workbench shutdown started`)
    }
    this.ownedResources.push({ label, dispose: () => dispose(resource) })
    return resource
  }

  start(): Promise<void> {
    if (this.startTask) return this.startTask
    if (this.currentState === 'running' || this.currentState === 'suspended') {
      return Promise.resolve()
    }
    if (this.isShuttingDown) {
      return Promise.reject(new Error('Workbench runtime has stopped'))
    }
    this.currentState = 'starting'
    this.startTask = this.startComponents()
    return this.startTask
  }

  suspend(): Promise<void> {
    if (this.suspendTask) return this.suspendTask
    if (this.currentState === 'cold' || this.currentState === 'suspended') {
      return Promise.resolve()
    }
    if (this.isShuttingDown) return this.shutdownTask ?? Promise.resolve()
    const priorReopen = this.reopenTask
    this.currentState = 'suspending'
    this.suspendTask = this.suspendComponents(priorReopen)
    return this.suspendTask
  }

  reopen(): Promise<void> {
    if (this.reopenTask) return this.reopenTask
    if (this.isShuttingDown) return Promise.resolve()
    if (this.currentState === 'cold') return this.start()
    const priorSuspend = this.suspendTask
    const fallbackState =
      this.currentState === 'suspended' || this.currentState === 'suspending'
        ? 'suspended'
        : 'running'
    this.currentState = 'reopening'
    this.reopenTask = this.reopenComponents(priorSuspend, fallbackState)
    return this.reopenTask
  }

  shutdown(): Promise<void> {
    if (this.shutdownTask) return this.shutdownTask
    if (this.currentState === 'stopped') return Promise.resolve()
    this.currentState = 'stopping'
    this.shutdownTask = this.shutdownComponents()
    return this.shutdownTask
  }

  private async startComponents(): Promise<void> {
    try {
      await this.components.start()
      if (this.currentState === 'starting') this.currentState = 'running'
    } catch (startError) {
      this.currentState = 'stopping'
      try {
        await this.cleanup()
      } catch (cleanupError) {
        this.currentState = 'stopped'
        throw new AggregateError(
          [startError, cleanupError],
          'Workbench startup and rollback failed',
          { cause: cleanupError },
        )
      }
      this.currentState = 'stopped'
      throw startError
    }
  }

  private async suspendComponents(priorReopen?: Promise<void>): Promise<void> {
    try {
      await this.startTask
      await priorReopen
      if (this.isShuttingDown) return
      await this.components.suspend()
      if (!this.isShuttingDown) this.currentState = 'suspended'
    } catch (error) {
      if (!this.isShuttingDown) this.currentState = 'running'
      throw error
    } finally {
      this.suspendTask = undefined
    }
  }

  private async reopenComponents(
    priorSuspend: Promise<void> | undefined,
    fallbackState: 'running' | 'suspended',
  ): Promise<void> {
    try {
      await this.startTask
      await priorSuspend
      if (this.isShuttingDown) return
      await this.components.reopen()
      if (!this.isShuttingDown) this.currentState = 'running'
    } catch (error) {
      if (!this.isShuttingDown) this.currentState = fallbackState
      throw error
    } finally {
      this.reopenTask = undefined
    }
  }

  private async shutdownComponents(): Promise<void> {
    try {
      await this.startTask?.catch(() => undefined)
      await this.suspendTask?.catch(() => undefined)
      await this.reopenTask?.catch(() => undefined)
      await this.cleanup()
    } finally {
      this.currentState = 'stopped'
    }
  }

  private cleanup(): Promise<void> {
    if (!this.cleanupTask) this.cleanupTask = this.cleanupComponents()
    return this.cleanupTask
  }

  private async cleanupComponents(): Promise<void> {
    const failures: Error[] = []
    try {
      await this.components.shutdown()
    } catch (error) {
      failures.push(asError('workbench operations', error))
    }
    for (const resource of this.ownedResources.splice(0).reverse()) {
      try {
        await resource.dispose()
      } catch (error) {
        failures.push(asError(resource.label, error))
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Workbench cleanup failed')
    }
  }
}

function asError(label: string, value: unknown): Error {
  const cause = value instanceof Error ? value : new Error(String(value))
  return new Error(`Failed to dispose ${label}: ${cause.message}`, { cause })
}
