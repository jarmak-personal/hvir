import type { ProjectHost } from '../project-host'

export const MAX_CONCURRENT_HARNESS_USAGE_READS = 4
export const MAX_QUEUED_HARNESS_USAGE_READS = 128

interface QueuedRead<T> {
  readonly signal: AbortSignal
  readonly read: () => Promise<T>
  readonly resolve: (value: T | PromiseLike<T>) => void
  readonly reject: (reason?: unknown) => void
  abort?: () => void
}

const schedulers = new WeakMap<ProjectHost, HarnessUsageReadScheduler>()

/** Bound artifact-read concurrency independently for each logical ProjectHost. */
export function scheduleHarnessUsageRead<T>(
  host: ProjectHost,
  signal: AbortSignal,
  read: () => Promise<T>,
): Promise<T> {
  let scheduler = schedulers.get(host)
  if (!scheduler) {
    scheduler = new HarnessUsageReadScheduler()
    schedulers.set(host, scheduler)
  }
  return scheduler.schedule(signal, read)
}

export class HarnessUsageReadScheduler {
  private readonly queued: QueuedRead<unknown>[] = []
  private running = 0

  schedule<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
    if (signal.aborted) return Promise.reject(abortError(signal))
    if (this.queued.length >= MAX_QUEUED_HARNESS_USAGE_READS) {
      return Promise.reject(new Error('Harness usage read queue is full'))
    }
    return new Promise<T>((resolve, reject) => {
      const task = { signal, read, resolve, reject } as QueuedRead<unknown>
      const abort = (): void => {
        const index = this.queued.indexOf(task)
        if (index < 0) return
        this.queued.splice(index, 1)
        task.signal.removeEventListener('abort', abort)
        task.reject(abortError(task.signal))
      }
      task.abort = abort
      this.queued.push(task)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      this.drain()
    })
  }

  private drain(): void {
    while (this.running < MAX_CONCURRENT_HARNESS_USAGE_READS && this.queued.length > 0) {
      const task = this.queued.shift()
      if (!task) return
      if (task.abort) task.signal.removeEventListener('abort', task.abort)
      if (task.signal.aborted) {
        task.reject(task.signal.reason)
        continue
      }
      this.running += 1
      void Promise.resolve()
        .then(task.read)
        .then(task.resolve, task.reject)
        .finally(() => {
          this.running -= 1
          this.drain()
        })
    }
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Harness usage read aborted')
}
