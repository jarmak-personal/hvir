import {
  contextStatusHarnessSnapshot,
  type HarnessTelemetry,
  type HostPath,
  type TerminalIdentityStatus,
  type HarnessProviderId,
} from '../../shared'
import type { Disposer } from '../project-host/project-host'
import type {
  HarnessArtifactContext,
  HarnessSessionDiscoveryContext,
  HarnessSessionDiscoveryResult,
  HarnessTelemetryContext,
} from '../harness/harness-provider-contract'

interface ObservationContext {
  readonly terminalId: string
  readonly providerId: HarnessProviderId
  readonly cwd: HostPath
  readonly artifact: HarnessArtifactContext
  readonly observe?: (context: HarnessTelemetryContext) => Disposer | Promise<Disposer>
}

interface ObservationAuthority {
  readonly isCurrent: () => boolean
  /** Registry acceptance and live identity publication belong to the supervisor. */
  readonly acceptCandidate: (sessionId: string) => Promise<boolean>
  readonly setIdentityStatus: (status: TerminalIdentityStatus) => void
  readonly identityChanged: () => void
  readonly publishTelemetry: (telemetry: HarnessTelemetry | undefined) => void
  readonly identityDiverged: () => void
}

interface DiscoveryRetry {
  readonly identify: (
    context: HarnessSessionDiscoveryContext,
  ) => Promise<HarnessSessionDiscoveryResult>
  readonly launchedAtMs: number
}

/** Provider subscriptions and retry lifetime; cannot acquire or transfer live authority. */
export class PtySessionObservation {
  private disposed = false
  private readonly controllers = new Set<AbortController>()
  private telemetryDisposer?: Disposer
  private telemetryStarted = false
  private discoveryActive = false
  private retryPending = false
  private retry?: DiscoveryRetry
  private identityStatus: TerminalIdentityStatus = 'unavailable'
  private currentTelemetry?: HarnessTelemetry
  private currentSessionData?: unknown

  constructor(
    private readonly context: ObservationContext,
    private readonly authority: ObservationAuthority,
  ) {}

  get telemetry(): HarnessTelemetry | undefined {
    return this.currentTelemetry
  }
  get sessionData(): unknown {
    return this.currentSessionData
  }

  discover(identify: DiscoveryRetry['identify'], launchedAtMs: number): void {
    if (!this.isCurrent()) return
    this.retry = { identify, launchedAtMs }
    this.identityStatus = 'discovering'
    this.discoveryActive = true
    void this.identify(this.retry, launchedAtMs)
  }

  retryAfterInput(): void {
    const retry = this.retry
    if (!retry || !this.isCurrent() || this.identityStatus === 'identified') return
    if (this.discoveryActive) {
      this.retryPending = true
      return
    }
    this.discoveryActive = true
    this.setIdentityStatus('discovering')
    this.authority.identityChanged()
    void this.identify(retry, Date.now())
  }

  startTelemetry(sessionId: string, sessionData?: unknown): void {
    const observer = this.context.observe
    if (!observer || this.telemetryStarted || !this.isCurrent()) return
    this.telemetryStarted = true
    const controller = this.controller()
    const publishTelemetry = (telemetry: HarnessTelemetry | undefined): void => {
      if (controller.signal.aborted || !this.isCurrent()) return
      this.currentTelemetry = telemetry
      this.authority.publishTelemetry(telemetry)
    }
    void Promise.resolve()
      .then(() =>
        observer({
          subscriptionId: this.context.terminalId,
          sessionId,
          cwd: this.context.cwd,
          sessionData,
          artifact: this.context.artifact,
          signal: controller.signal,
          emit: publishTelemetry,
          identityDiverged: () => {
            if (!controller.signal.aborted && this.isCurrent())
              this.authority.identityDiverged()
          },
        }),
      )
      .then(
        (dispose) => {
          if (controller.signal.aborted || !this.isCurrent()) void dispose()
          else this.telemetryDisposer = dispose
        },
        (error: unknown) => {
          if (!controller.signal.aborted) {
            console.warn(`[pty] ${this.context.providerId} telemetry unavailable`, error)
            publishTelemetry(
              contextStatusHarnessSnapshot({
                providerId: this.context.providerId,
                provenance: 'Harness telemetry observer lifecycle',
                sessionId,
                context: {
                  status: 'unavailable',
                  reason: 'Harness telemetry observer unavailable',
                },
              }),
            )
          }
        },
      )
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const controller of this.controllers) controller.abort()
    this.controllers.clear()
    void this.telemetryDisposer?.()
    this.retry = undefined
    this.retryPending = false
  }

  private isCurrent(): boolean {
    return !this.disposed && this.authority.isCurrent()
  }

  private controller(): AbortController {
    const controller = new AbortController()
    this.controllers.add(controller)
    return controller
  }

  private setIdentityStatus(status: TerminalIdentityStatus): void {
    this.identityStatus = status
    this.authority.setIdentityStatus(status)
  }

  private async identify(
    retry: DiscoveryRetry,
    discoveryStartedAtMs: number,
  ): Promise<void> {
    const controller = this.controller()
    try {
      const result = await retry.identify({
        cwd: this.context.cwd,
        launchedAtMs: retry.launchedAtMs,
        discoveryStartedAtMs,
        signal: controller.signal,
        artifact: this.context.artifact,
      })
      if (!this.isCurrent()) return
      if (result.status === 'identified') {
        this.currentSessionData = result.sessionData
        let accepted = false
        try {
          accepted = await this.authority.acceptCandidate(result.sessionId)
        } catch {
          // The registry owns persistence diagnostics. Publication stays unavailable.
        }
        if (this.isCurrent()) {
          this.setIdentityStatus(accepted ? 'identified' : 'unavailable')
          if (accepted) {
            this.retry = undefined
            this.retryPending = false
            this.startTelemetry(result.sessionId, result.sessionData)
          }
        }
      } else {
        this.setIdentityStatus(result.status)
        if (result.status === 'ambiguous') {
          this.retry = undefined
          this.retryPending = false
        }
      }
    } catch (error) {
      if (this.isCurrent()) this.setIdentityStatus('unavailable')
      if (!controller.signal.aborted)
        console.warn(
          `[pty] ${this.context.providerId} session discovery unavailable`,
          error,
        )
    } finally {
      this.discoveryActive = false
      this.controllers.delete(controller)
    }
    if (!this.isCurrent()) return
    this.authority.identityChanged()
    if (this.retryPending && this.identityStatus === 'unavailable' && this.retry) {
      this.retryPending = false
      this.retryAfterInput()
    }
  }
}
