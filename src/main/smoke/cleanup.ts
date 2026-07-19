export type SmokeCleanupTask = () => void | Promise<void>

interface RegisteredCleanup {
  readonly name: string
  readonly task: SmokeCleanupTask
}

/** Reverse-order cleanup for smoke resources, including partial-startup failures. */
export class SmokeCleanup {
  private readonly tasks: RegisteredCleanup[] = []
  private completed = false

  defer(name: string, task: SmokeCleanupTask): void {
    if (this.completed) throw new Error('Smoke cleanup has already run')
    this.tasks.push({ name, task })
  }

  async run(): Promise<void> {
    if (this.completed) return
    this.completed = true
    const failures: Error[] = []
    for (const cleanup of this.tasks.reverse()) {
      try {
        await cleanup.task()
      } catch (reason) {
        failures.push(
          new Error(`Smoke cleanup failed for ${cleanup.name}`, { cause: reason }),
        )
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Electron smoke cleanup failed')
    }
  }
}
