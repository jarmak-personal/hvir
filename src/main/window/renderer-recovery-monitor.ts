import type { RendererOwner } from '../renderer-resource-scopes'

export const RENDERER_RECOVERY_DEADLINE_MS = 15_000

export type RendererRecoveryFailure =
  'document-load-failed' | 'readiness-timeout' | 'renderer-exited' | 'reload-failed'

export interface RendererRecoveryAttempt {
  readonly sequence: number
  readonly owner: RendererOwner
}

export interface RendererRecoveryMonitorOptions {
  readonly deadlineMs?: number
  readonly schedule?: (task: () => void, delayMs: number) => () => void
  readonly onSucceeded: (attempt: RendererRecoveryAttempt) => void
  readonly onFailed: (
    attempt: RendererRecoveryAttempt,
    failure: RendererRecoveryFailure,
  ) => void
}

interface PendingRecovery {
  readonly attempt: RendererRecoveryAttempt
  cancelDeadline: () => void
  documentLoaded: boolean
  rendererReady: boolean
  state: 'pending' | 'failed'
}

/** Qualifies load, readiness, and timeout completion to one replacement generation. */
export class RendererRecoveryMonitor {
  private readonly deadlineMs: number
  private readonly schedule: (task: () => void, delayMs: number) => () => void
  private sequence = 0
  private current?: PendingRecovery
  private disposed = false

  constructor(private readonly options: RendererRecoveryMonitorOptions) {
    this.deadlineMs = options.deadlineMs ?? RENDERER_RECOVERY_DEADLINE_MS
    this.schedule =
      options.schedule ??
      ((task, delayMs) => {
        const timer = setTimeout(task, delayMs)
        return () => clearTimeout(timer)
      })
  }

  start(owner: RendererOwner): RendererRecoveryAttempt | undefined {
    if (this.disposed) return undefined
    this.cancelCurrent()
    const attempt = { sequence: ++this.sequence, owner }
    const pending: PendingRecovery = {
      attempt,
      cancelDeadline: () => undefined,
      documentLoaded: false,
      rendererReady: false,
      state: 'pending',
    }
    pending.cancelDeadline = this.schedule(
      () => this.failAttempt(attempt, 'readiness-timeout'),
      this.deadlineMs,
    )
    this.current = pending
    return attempt
  }

  documentLoaded(owner: RendererOwner): void {
    const current = this.pendingFor(owner)
    if (!current) return
    current.documentLoaded = true
    this.completeIfUsable(current)
  }

  rendererReady(owner: RendererOwner): void {
    const current = this.pendingFor(owner)
    if (!current) return
    current.rendererReady = true
    this.completeIfUsable(current)
  }

  fail(owner: RendererOwner, failure: RendererRecoveryFailure): void {
    const current = this.pendingFor(owner)
    if (current) this.failAttempt(current.attempt, failure)
  }

  isFailed(attempt: RendererRecoveryAttempt): boolean {
    return this.current?.attempt === attempt && this.current.state === 'failed'
  }

  owns(owner: RendererOwner): boolean {
    return Boolean(this.current && sameOwner(this.current.attempt.owner, owner))
  }

  close(): void {
    this.cancelCurrent()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelCurrent()
  }

  private pendingFor(owner: RendererOwner): PendingRecovery | undefined {
    const current = this.current
    return current?.state === 'pending' && sameOwner(current.attempt.owner, owner)
      ? current
      : undefined
  }

  private completeIfUsable(current: PendingRecovery): void {
    if (!current.documentLoaded || !current.rendererReady) return
    current.cancelDeadline()
    this.current = undefined
    this.options.onSucceeded(current.attempt)
  }

  private failAttempt(
    attempt: RendererRecoveryAttempt,
    failure: RendererRecoveryFailure,
  ): void {
    const current = this.current
    if (current?.attempt !== attempt || current.state !== 'pending') return
    current.state = 'failed'
    current.cancelDeadline()
    this.options.onFailed(attempt, failure)
  }

  private cancelCurrent(): void {
    this.current?.cancelDeadline()
    this.current = undefined
  }
}

function sameOwner(left: RendererOwner, right: RendererOwner): boolean {
  return left.id === right.id && left.generation === right.generation
}
