import {
  MAX_RENDERER_DIAGNOSTIC_BATCH_EVENTS,
  MAX_RENDERER_DIAGNOSTIC_QUEUE_EVENTS,
  RENDERER_DIAGNOSTIC_VERSION,
  RENDERER_RESPONSIVENESS_BATCH_EVENTS,
  RENDERER_RESPONSIVENESS_QUEUE_EVENTS,
  RENDERER_RESPONSIVENESS_VERSION,
  isDiagnosticOpaqueId,
  isResponsivenessObservation,
  type RenderContainmentDiagnosticBatch,
  type RendererDiagnosticDroppedCounts,
  type RendererDiagnosticSession,
  type ResponsivenessObservation,
  type ResponsivenessObservationBatch,
} from '../shared'

const SOURCE_RATE_PER_SECOND = 4
const SOURCE_RATE_BURST = 16
const SATURATING_COUNT = Number.MAX_SAFE_INTEGER

export interface RendererDiagnosticsAdapterOptions {
  readonly send: (batch: RenderContainmentDiagnosticBatch) => void
  readonly sendResponsiveness?: (batch: ResponsivenessObservationBatch) => void
  readonly now?: () => number
  readonly schedule?: (task: () => void) => void
}

/** Preload-owned, domain-specific, droppable transport for render containment. */
export class RendererDiagnosticsAdapter {
  private readonly now: () => number
  private readonly schedule: (task: () => void) => void
  private readonly queue: string[] = []
  private readonly responsivenessQueue: ResponsivenessObservation[] = []
  private dropped: RendererDiagnosticDroppedCounts = emptyDroppedCounts()
  private responsivenessDropped = emptyResponsivenessDropped()
  private responsivenessSessionId?: string
  private session?: RendererDiagnosticSession
  private scheduled = false
  private tokens = SOURCE_RATE_BURST
  private refilledAt: number

  constructor(private readonly options: RendererDiagnosticsAdapterOptions) {
    this.now = options.now ?? Date.now
    this.schedule = options.schedule ?? ((task) => setTimeout(task, 0))
    this.refilledAt = this.now()
  }

  activate(session: unknown): void {
    if (!isSession(session)) return
    if (
      this.session &&
      (this.session.ownerGeneration !== session.ownerGeneration ||
        this.session.sessionId !== session.sessionId)
    ) {
      this.queue.length = 0
      this.dropped = emptyDroppedCounts()
    }
    this.session = session
    if (this.queue.length > 0 || hasDropped(this.dropped)) this.scheduleFlush()
  }

  recordRenderContainment(occurrenceId: string): void {
    if (!isDiagnosticOpaqueId(occurrenceId)) {
      this.incrementDropped('invalid')
      this.scheduleFlush()
      return
    }
    if (!this.session) {
      this.incrementDropped('unavailable')
      return
    }
    if (!this.takeRateToken()) {
      this.incrementDropped('rate')
      this.scheduleFlush()
      return
    }
    if (this.queue.length >= MAX_RENDERER_DIAGNOSTIC_QUEUE_EVENTS) {
      this.incrementDropped('queue')
      this.scheduleFlush()
      return
    }
    this.queue.push(occurrenceId)
    this.scheduleFlush()
  }

  recordResponsivenessObservation(observation: unknown): void {
    if (!this.options.sendResponsiveness) return
    if (!isResponsivenessObservation(observation)) {
      this.incrementResponsivenessDropped('invalid')
      this.scheduleFlush()
      return
    }
    if (
      this.responsivenessSessionId &&
      this.responsivenessSessionId !== observation.diagnosticSessionId
    ) {
      this.responsivenessQueue.length = 0
      this.responsivenessDropped = emptyResponsivenessDropped()
    }
    this.responsivenessSessionId = observation.diagnosticSessionId
    if (!this.takeRateToken()) {
      this.incrementResponsivenessDropped('rate')
      this.scheduleFlush()
      return
    }
    if (this.responsivenessQueue.length >= RENDERER_RESPONSIVENESS_QUEUE_EVENTS) {
      this.incrementResponsivenessDropped('queue')
      this.scheduleFlush()
      return
    }
    this.responsivenessQueue.push(observation)
    this.scheduleFlush()
  }

  flushResponsivenessObservations(): void {
    this.flush()
  }

  private scheduleFlush(): void {
    const containmentPending =
      this.session && (this.queue.length > 0 || hasDropped(this.dropped))
    const responsivenessPending =
      this.responsivenessSessionId &&
      (this.responsivenessQueue.length > 0 ||
        hasResponsivenessDropped(this.responsivenessDropped))
    if (this.scheduled || (!containmentPending && !responsivenessPending)) return
    this.scheduled = true
    this.schedule(() => {
      this.scheduled = false
      this.flush()
    })
  }

  private flush(): void {
    const session = this.session
    if (session) {
      const occurrenceIds = this.queue.splice(0, MAX_RENDERER_DIAGNOSTIC_BATCH_EVENTS)
      const dropped = this.dropped
      this.dropped = emptyDroppedCounts()
      if (occurrenceIds.length > 0 || hasDropped(dropped)) {
        try {
          this.options.send({
            version: RENDERER_DIAGNOSTIC_VERSION,
            session,
            events: occurrenceIds.map((occurrenceId) => ({
              version: RENDERER_DIAGNOSTIC_VERSION,
              occurrenceId,
            })),
            dropped,
          })
        } catch {
          // A destroyed renderer or main process cannot be held open by diagnostics.
        }
      }
    }
    const diagnosticSessionId = this.responsivenessSessionId
    if (diagnosticSessionId && this.options.sendResponsiveness) {
      const observations = this.responsivenessQueue.splice(
        0,
        RENDERER_RESPONSIVENESS_BATCH_EVENTS,
      )
      const dropped = this.responsivenessDropped
      this.responsivenessDropped = emptyResponsivenessDropped()
      if (observations.length > 0 || hasResponsivenessDropped(dropped)) {
        try {
          this.options.sendResponsiveness({
            version: RENDERER_RESPONSIVENESS_VERSION,
            diagnosticSessionId,
            observations,
            dropped,
          })
        } catch {
          // A destroyed renderer or main process cannot be held open by diagnostics.
        }
      }
    }
    this.scheduleFlush()
  }

  private takeRateToken(): boolean {
    const now = this.now()
    const elapsedMs = Math.max(0, now - this.refilledAt)
    this.tokens = Math.min(
      SOURCE_RATE_BURST,
      this.tokens + (elapsedMs / 1000) * SOURCE_RATE_PER_SECOND,
    )
    this.refilledAt = now
    if (this.tokens < 1) return false
    this.tokens--
    return true
  }

  private incrementDropped(reason: keyof RendererDiagnosticDroppedCounts): void {
    this.dropped = {
      ...this.dropped,
      [reason]: saturatingAdd(this.dropped[reason], 1),
    }
  }

  private incrementResponsivenessDropped(
    reason: keyof ResponsivenessObservationBatch['dropped'],
  ): void {
    this.responsivenessDropped = {
      ...this.responsivenessDropped,
      [reason]: saturatingAdd(this.responsivenessDropped[reason], 1),
    }
  }
}

function isSession(value: unknown): value is RendererDiagnosticSession {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 3 &&
    'version' in value &&
    value.version === RENDERER_DIAGNOSTIC_VERSION &&
    'ownerGeneration' in value &&
    typeof value.ownerGeneration === 'number' &&
    Number.isSafeInteger(value.ownerGeneration) &&
    value.ownerGeneration > 0 &&
    'sessionId' in value &&
    isDiagnosticOpaqueId(value.sessionId)
  )
}

function emptyDroppedCounts(): RendererDiagnosticDroppedCounts {
  return { invalid: 0, queue: 0, rate: 0, unavailable: 0 }
}

function hasDropped(dropped: RendererDiagnosticDroppedCounts): boolean {
  return Object.values(dropped).some((count) => count > 0)
}

function emptyResponsivenessDropped(): ResponsivenessObservationBatch['dropped'] {
  return { invalid: 0, queue: 0, rate: 0 }
}

function hasResponsivenessDropped(
  dropped: ResponsivenessObservationBatch['dropped'],
): boolean {
  return Object.values(dropped).some((count) => count > 0)
}

function saturatingAdd(current: number, increment: number): number {
  return Math.min(SATURATING_COUNT, current + increment)
}
