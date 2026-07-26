import { describe, expect, it } from 'vitest'

import {
  prepareDiagnosticReportEvidence,
  type DurableDiagnosticEvidence,
} from '../src/main/diagnostics/diagnostic-report-evidence'
import {
  materializeDiagnosticEvent,
  type RuntimeDiagnosticEvent,
  type StoredDiagnosticEvent,
} from '../src/main/diagnostics/diagnostic-event'
import type { DiagnosticRecentSnapshot } from '../src/main/diagnostics/diagnostic-intake'

const BASE_TIME = Date.parse('2026-07-22T10:00:00.000Z')

describe('diagnostic report lifetime evidence', () => {
  it('includes only the immediately preceding lifetime and deduplicates current durable events', () => {
    const olderStart = event({ kind: 'application-starting' }, 0, 1)
    const precedingStart = event({ kind: 'application-starting' }, 10, 2)
    const unresponsive = event(
      {
        kind: 'renderer-unresponsive',
        ownerId: 7,
        ownerGeneration: 1,
        occurrenceId: opaqueId(30),
      },
      11,
      3,
    )
    const recovered = event(
      {
        kind: 'workbench-health-recovered',
        ownerId: 7,
        ownerGeneration: 1,
        occurrenceId: opaqueId(30),
        outcome: 'reload-selected',
      },
      12,
      4,
    )
    const shutdown = event({ kind: 'application-shutdown-completed' }, 13, 5)
    const currentStart = event({ kind: 'application-starting' }, 20, 6)
    const currentReady = event({ kind: 'application-ready' }, 21, 7)

    const snapshot = prepareDiagnosticReportEvidence(
      recent([currentStart, currentReady]),
      durable([
        olderStart,
        event({ kind: 'application-ready' }, 1, 8),
        precedingStart,
        unresponsive,
        recovered,
        shutdown,
        currentStart,
      ]),
      boundary(currentStart),
    )

    expect(snapshot.scopes).toEqual({
      currentLifetime: { availability: 'included', eventCount: 2 },
      precedingLifetime: { availability: 'included', eventCount: 4 },
    })
    expect(
      snapshot.events.map(({ scope, event: stored }) => [scope, stored.kind]),
    ).toEqual([
      ['preceding-lifetime', 'application-starting'],
      ['preceding-lifetime', 'renderer-unresponsive'],
      ['preceding-lifetime', 'workbench-health-recovered'],
      ['preceding-lifetime', 'application-shutdown-completed'],
      ['current-lifetime', 'application-starting'],
      ['current-lifetime', 'application-ready'],
    ])
    expect(
      snapshot.events.filter(({ event: stored }) => stored === currentStart),
    ).toHaveLength(1)
  })

  it.each([
    ['clean shutdown', [{ kind: 'application-shutdown-completed' }]],
    ['missing shutdown completion', [{ kind: 'application-shutdown-starting' }]],
    [
      'lost renderer before main exit',
      [
        {
          kind: 'renderer-process-exited',
          ownerId: 7,
          ownerGeneration: 1,
          occurrenceId: opaqueId(40),
          reason: 'crashed',
        },
      ],
    ],
  ] as const)('selects a preceding lifetime with %s', (_name, tail) => {
    const precedingStart = event({ kind: 'application-starting' }, 0, 10)
    const currentStart = event({ kind: 'application-starting' }, 10, 11)
    const tailEvents = tail.map((item, index) =>
      event(item as RuntimeDiagnosticEvent, index + 1, 20 + index),
    )

    const snapshot = prepareDiagnosticReportEvidence(
      recent([currentStart]),
      durable([precedingStart, ...tailEvents]),
      boundary(currentStart),
    )

    expect(snapshot.scopes.precedingLifetime).toEqual({
      availability: 'included',
      eventCount: 1 + tailEvents.length,
    })
  })

  it('fails closed when the retained preceding start boundary rotated away', () => {
    const currentStart = event({ kind: 'application-starting' }, 10, 50)
    const snapshot = prepareDiagnosticReportEvidence(
      recent([currentStart]),
      durable([
        event(
          {
            kind: 'workbench-health-recovered',
            ownerId: 7,
            ownerGeneration: 1,
            occurrenceId: opaqueId(51),
            outcome: 'window-closed',
          },
          1,
          51,
        ),
      ]),
      boundary(currentStart),
    )

    expect(snapshot.scopes.precedingLifetime).toEqual({
      availability: 'partial',
      eventCount: 0,
    })
    expect(snapshot.events).toHaveLength(1)
  })

  it('retains current intake first and marks truncated preceding evidence partial', () => {
    const preceding = Array.from({ length: 20 }, (_value, index) =>
      event(
        { kind: index === 0 ? 'application-starting' : 'application-ready' },
        index,
        100 + index,
      ),
    )
    const current = Array.from({ length: 250 }, (_value, index) =>
      event(
        { kind: index === 0 ? 'application-starting' : 'application-ready' },
        100 + index,
        200 + index,
      ),
    )

    const snapshot = prepareDiagnosticReportEvidence(
      recent(current),
      durable(preceding),
      boundary(current[0]!),
    )

    expect(snapshot.events).toHaveLength(256)
    expect(snapshot.scopes.currentLifetime.eventCount).toBe(250)
    expect(snapshot.scopes.precedingLifetime).toEqual({
      availability: 'partial',
      eventCount: 6,
    })
  })
})

function event(
  value: RuntimeDiagnosticEvent,
  seconds: number,
  id: number,
): StoredDiagnosticEvent {
  const stored = materializeDiagnosticEvent(value, {
    occurredAtMs: BASE_TIME + seconds * 1_000,
    correlation: opaqueId(id),
  })
  if (!stored) throw new Error('Expected valid diagnostic event fixture')
  return stored
}

function recent(events: readonly StoredDiagnosticEvent[]): DiagnosticRecentSnapshot {
  return { version: 1, events, dropped: [] }
}

function durable(events: readonly StoredDiagnosticEvent[]): DurableDiagnosticEvidence {
  return { availability: 'available', events }
}

function boundary(event: StoredDiagnosticEvent): {
  correlation: string
  occurredAt: string
} {
  return { correlation: event.correlation, occurredAt: event.occurredAt }
}

function opaqueId(value: number): string {
  return `019c0000-0000-7000-8000-${value.toString().padStart(12, '0')}`
}
