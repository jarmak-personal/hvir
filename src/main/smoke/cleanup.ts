export type SmokeCleanupTask = () => void | Promise<void>

const DEFAULT_CLEANUP_TASK_TIMEOUT_MS = 10_000

interface RegisteredCleanup {
  readonly name: string
  readonly task: SmokeCleanupTask
}

interface SmokeCleanupOptions {
  readonly taskTimeoutMs?: number
  readonly onFailure?: (name: string) => void
}

/** Reverse-order cleanup for smoke resources, including partial-startup failures. */
export class SmokeCleanup {
  private readonly tasks: RegisteredCleanup[] = []
  private completed = false
  private readonly taskTimeoutMs: number

  constructor(
    private readonly onDisposed?: (name: string) => void,
    private readonly options: SmokeCleanupOptions = {},
  ) {
    this.taskTimeoutMs = options.taskTimeoutMs ?? DEFAULT_CLEANUP_TASK_TIMEOUT_MS
    if (!Number.isFinite(this.taskTimeoutMs) || this.taskTimeoutMs <= 0) {
      throw new Error('Smoke cleanup task deadline was invalid')
    }
  }

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
        await runCleanupTaskWithinDeadline(cleanup.task, this.taskTimeoutMs)
        this.onDisposed?.(cleanup.name)
      } catch (reason) {
        this.options.onFailure?.(cleanup.name)
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

async function runCleanupTaskWithinDeadline(
  task: SmokeCleanupTask,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve().then(task),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Smoke cleanup task timed out after ${timeoutMs}ms`)),
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
