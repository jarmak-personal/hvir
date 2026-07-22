import { describe, expect, it, vi } from 'vitest'

import {
  DiagnosticIntake,
  type DiagnosticIntakeOptions,
} from '../src/main/diagnostics/diagnostic-intake'
import type { DiagnosticJournalStatus } from '../src/main/diagnostics/diagnostic-journal'
import type { RendererOwner } from '../src/main/renderer-resource-scopes'

const OWNER: RendererOwner = { id: 7, generation: 3 }
const SENSITIVE = '/secret/project TOKEN=hvir-private terminal prompt'

describe('DiagnosticIntake', () => {
  it('qualifies renderer evidence with the exact main-owned generation and session', () => {
    const intake = fixture().intake
    const session = intake.startRenderer(OWNER)
    intake.recordRenderContainment(OWNER, {
      version: 1,
      session,
      events: [{ version: 1, occurrenceId: opaqueId(2) }],
      dropped: { invalid: 1, queue: 2, rate: 3, unavailable: 4 },
    })

    const snapshot = intake.snapshot()
    expect(snapshot.events).toEqual([
      expect.objectContaining({
        kind: 'react-render-contained',
        owner: 'renderer-error-boundary',
        ownerId: 7,
        ownerGeneration: 3,
        occurrenceId: opaqueId(2),
      }),
    ])
    expect(snapshot.dropped).toEqual(
      expect.arrayContaining([
        { source: 'renderer-error-boundary', reason: 'renderer-invalid', count: 1 },
        { source: 'renderer-error-boundary', reason: 'renderer-queue', count: 2 },
        { source: 'renderer-error-boundary', reason: 'renderer-rate', count: 3 },
        {
          source: 'renderer-error-boundary',
          reason: 'renderer-unavailable',
          count: 4,
        },
      ]),
    )
    expect(JSON.stringify(snapshot)).not.toContain(session.sessionId)
  })

  it('rejects revoked, rolled-over, and unknown renderer material', () => {
    const intake = fixture().intake
    const staleSession = intake.startRenderer(OWNER)
    intake.revokeRenderer(OWNER)
    const replacement = { id: OWNER.id, generation: OWNER.generation + 1 }
    intake.startRenderer(replacement)

    intake.recordRenderContainment(replacement, {
      version: 1,
      session: staleSession,
      events: [{ version: 1, occurrenceId: opaqueId(3) }],
      dropped: { invalid: 0, queue: 0, rate: 0, unavailable: 0 },
    })
    intake.recordRenderContainment(replacement, {
      version: 1,
      session: intake.startRenderer(replacement),
      events: [
        {
          version: 1,
          occurrenceId: opaqueId(4),
          arbitrary: SENSITIVE,
        } as never,
      ],
      dropped: { invalid: 0, queue: 0, rate: 0, unavailable: 0 },
    })

    expect(intake.snapshot().events).toEqual([])
    expect(intake.snapshot().dropped).toEqual(
      expect.arrayContaining([
        { source: 'renderer-error-boundary', reason: 'renderer-session', count: 1 },
        { source: 'renderer-error-boundary', reason: 'renderer-invalid', count: 1 },
      ]),
    )
    expect(JSON.stringify(intake.snapshot())).not.toContain(SENSITIVE)
  })

  it('shares one event identity with the writer and the recent snapshot', () => {
    const status = writerStatus()
    const record = vi.fn((_line: string) => true)
    const writer = {
      record,
      status: vi.fn(() => status),
    }
    const { intake } = fixture(writer)
    intake.record({ kind: 'application-startup-failed' })

    const [line] = record.mock.calls[0]!
    const [event] = intake.snapshot().events
    expect(line).toBe(`${JSON.stringify(event)}\n`)
  })

  it('rate-limits by closed source and retains at most 256 events and 256 KiB', () => {
    let now = 0
    let correlation = 0
    const intake = new DiagnosticIntake({
      now: () => now,
      correlation: () => opaqueId(correlation++),
    })

    for (let index = 0; index < 20; index++) {
      intake.record({ kind: 'application-ready' })
    }
    expect(intake.snapshot().events).toHaveLength(16)
    expect(intake.snapshot().dropped).toContainEqual({
      source: 'application',
      reason: 'rate',
      count: 4,
    })

    for (let index = 0; index < 300; index++) {
      now += 250
      intake.record({
        kind: 'pty-spawned',
        hostKind: 'ssh',
        launchMode: 'fresh',
      })
    }
    const snapshot = intake.snapshot()
    expect(snapshot.events.length).toBeLessThanOrEqual(256)
    expect(Buffer.byteLength(JSON.stringify(snapshot), 'utf8')).toBeLessThanOrEqual(
      256 * 1024,
    )
    expect(snapshot.dropped).toContainEqual(
      expect.objectContaining({ reason: 'recent-capacity' }),
    )
  })

  it('reports writer drops without exposing its app-data location', () => {
    const writer = {
      record: () => false,
      status: () => writerStatus({ storage: 2, queue: 1 }),
    }
    const { intake } = fixture(writer)
    intake.record({ kind: 'application-ready' })

    const snapshot = intake.snapshot()
    expect(snapshot.dropped).toEqual(
      expect.arrayContaining([
        { source: 'diagnostic-writer', reason: 'writer-queue', count: 1 },
        { source: 'diagnostic-writer', reason: 'writer-storage', count: 2 },
      ]),
    )
    expect(JSON.stringify(snapshot)).not.toContain('/private/app-data')
  })
})

function fixture(writer?: DiagnosticIntakeOptions['writer']): {
  intake: DiagnosticIntake
} {
  let correlation = 100
  return {
    intake: new DiagnosticIntake({
      writer,
      now: () => Date.parse('2026-07-22T12:00:00.000Z'),
      correlation: () => opaqueId(correlation++),
    }),
  }
}

function writerStatus(dropped = { queue: 0, storage: 0 }): DiagnosticJournalStatus {
  return {
    location: '/private/app-data/runtime-diagnostics.jsonl',
    sink: 'available',
    dropped,
  }
}

function opaqueId(value: number): string {
  return `019c0000-0000-7000-8000-${value.toString().padStart(12, '0')}`
}
