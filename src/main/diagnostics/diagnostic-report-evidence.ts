import {
  MAX_DIAGNOSTIC_REPORT_EVENTS,
  type DiagnosticReportLifetimeScope,
} from '../../shared'
import type {
  DiagnosticDroppedCount,
  DiagnosticRecentSnapshot,
} from './diagnostic-intake'
import type { StoredDiagnosticEvent } from './diagnostic-event'

export type DiagnosticReportScopeAvailability = 'included' | 'partial' | 'unavailable'

export interface DurableDiagnosticEvidence {
  readonly availability: 'available' | 'partial' | 'unavailable'
  readonly events: readonly StoredDiagnosticEvent[]
}

export interface DiagnosticLifetimeStart {
  readonly correlation: string
  readonly occurredAt: string
}

export interface ScopedDiagnosticEvent {
  readonly scope: DiagnosticReportLifetimeScope
  readonly event: StoredDiagnosticEvent
}

export interface DiagnosticReportEvidenceSnapshot {
  readonly version: 1
  readonly scopes: {
    readonly currentLifetime: {
      readonly availability: 'included'
      readonly eventCount: number
    }
    readonly precedingLifetime: {
      readonly availability: DiagnosticReportScopeAvailability
      readonly eventCount: number
    }
  }
  readonly events: readonly ScopedDiagnosticEvent[]
  readonly dropped: readonly DiagnosticDroppedCount[]
}

/** Selects one preceding app lifetime and merges it with bounded current intake. */
export function prepareDiagnosticReportEvidence(
  current: DiagnosticRecentSnapshot,
  durable: DurableDiagnosticEvidence,
  currentStart: DiagnosticLifetimeStart | undefined,
): DiagnosticReportEvidenceSnapshot {
  const currentEvents = uniqueChronological(current.events).slice(
    -MAX_DIAGNOSTIC_REPORT_EVENTS,
  )
  const currentCorrelations = new Set(currentEvents.map((event) => event.correlation))
  const preceding = selectPrecedingLifetime(durable, currentStart)
  const uniquePreceding = uniqueChronological(preceding.events).filter(
    (event) => !currentCorrelations.has(event.correlation),
  )
  const precedingCapacity = Math.max(
    0,
    MAX_DIAGNOSTIC_REPORT_EVENTS - currentEvents.length,
  )
  const boundedPreceding =
    precedingCapacity === 0 ? [] : uniquePreceding.slice(-precedingCapacity)
  const precedingTruncated = boundedPreceding.length < uniquePreceding.length
  const precedingAvailability =
    precedingTruncated && preceding.availability === 'included'
      ? 'partial'
      : preceding.availability
  const events = [
    ...boundedPreceding.map((event): ScopedDiagnosticEvent => ({
      scope: 'preceding-lifetime',
      event,
    })),
    ...currentEvents.map((event): ScopedDiagnosticEvent => ({
      scope: 'current-lifetime',
      event,
    })),
  ].sort(compareScopedEvents)

  return {
    version: 1,
    scopes: {
      currentLifetime: {
        availability: 'included',
        eventCount: currentEvents.length,
      },
      precedingLifetime: {
        availability: precedingAvailability,
        eventCount: boundedPreceding.length,
      },
    },
    events,
    dropped: current.dropped,
  }
}

function selectPrecedingLifetime(
  durable: DurableDiagnosticEvidence,
  currentStart: DiagnosticLifetimeStart | undefined,
): {
  readonly availability: DiagnosticReportScopeAvailability
  readonly events: readonly StoredDiagnosticEvent[]
} {
  if (durable.availability === 'unavailable' || !currentStart) {
    return { availability: 'unavailable', events: [] }
  }
  const events = uniqueChronological(durable.events)
  const currentIndex = events.findIndex(
    (event) => event.correlation === currentStart.correlation,
  )
  let beforeCurrent: readonly StoredDiagnosticEvent[]
  if (currentIndex >= 0) {
    beforeCurrent = events.slice(0, currentIndex)
  } else {
    const currentStartedAt = Date.parse(currentStart.occurredAt)
    if (events.some((event) => Date.parse(event.occurredAt) > currentStartedAt)) {
      return { availability: 'partial', events: [] }
    }
    beforeCurrent = events
  }
  let precedingStart = -1
  for (let index = beforeCurrent.length - 1; index >= 0; index--) {
    if (beforeCurrent[index]?.kind === 'application-starting') {
      precedingStart = index
      break
    }
  }
  if (precedingStart < 0) {
    return {
      availability:
        beforeCurrent.length > 0 || durable.availability === 'partial'
          ? 'partial'
          : 'unavailable',
      events: [],
    }
  }
  return {
    availability: durable.availability === 'partial' ? 'partial' : 'included',
    events: beforeCurrent.slice(precedingStart),
  }
}

function uniqueChronological(
  events: readonly StoredDiagnosticEvent[],
): StoredDiagnosticEvent[] {
  const byCorrelation = new Map<string, StoredDiagnosticEvent>()
  for (const event of events) {
    if (!byCorrelation.has(event.correlation)) {
      byCorrelation.set(event.correlation, event)
    }
  }
  return [...byCorrelation.values()].sort((left, right) => {
    return Date.parse(left.occurredAt) - Date.parse(right.occurredAt)
  })
}

function compareScopedEvents(
  left: ScopedDiagnosticEvent,
  right: ScopedDiagnosticEvent,
): number {
  const time = Date.parse(left.event.occurredAt) - Date.parse(right.event.occurredAt)
  if (time) return time
  if (left.scope !== right.scope) {
    return left.scope === 'preceding-lifetime' ? -1 : 1
  }
  return 0
}
