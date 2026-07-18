import type { GitSyncOperation } from './git-rail-model'

export interface GitSyncObserver {
  readonly started: (operation: GitSyncOperation, requestId: number) => void
  readonly succeeded: (
    operation: GitSyncOperation,
    requestId: number,
    finishedAt: number,
  ) => void
  readonly failed: (
    operation: GitSyncOperation,
    requestId: number,
    error: string,
  ) => void
}

export class GitSyncCoordinator {
  readonly #now: () => number
  #generation = 0
  #requestId = 0
  #running = false

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  reset(): number {
    this.#generation += 1
    this.#running = false
    return this.#generation
  }

  generation(): number {
    return this.#generation
  }

  running(): boolean {
    return this.#running
  }

  run(
    operation: GitSyncOperation,
    request: () => Promise<void>,
    observer: GitSyncObserver,
  ): boolean {
    if (this.#running) return false
    const generation = this.#generation
    const requestId = ++this.#requestId
    this.#running = true
    observer.started(operation, requestId)
    void request().then(
      () => {
        if (!this.#isCurrent(generation, requestId)) return
        observer.succeeded(operation, requestId, this.#now())
      },
      (reason: unknown) => {
        if (!this.#isCurrent(generation, requestId)) return
        observer.failed(operation, requestId, errorMessage(reason))
      },
    ).finally(() => {
      if (this.#isCurrent(generation, requestId)) this.#running = false
    })
    return true
  }

  #isCurrent(generation: number, requestId: number): boolean {
    return generation === this.#generation && requestId === this.#requestId
  }
}

export function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
