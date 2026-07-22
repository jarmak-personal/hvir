import { describe, expect, it, vi } from 'vitest'

import { WorkbenchHealth } from '../src/main/health/workbench-health'
import { RuntimeDiagnostics } from '../src/main/diagnostics/runtime-diagnostics'
import {
  materializeDiagnosticEvent,
  parseStoredDiagnosticEvent,
  serializeStoredDiagnosticEvent,
  type RuntimeDiagnosticEvent,
  type StoredDiagnosticEvent,
} from '../src/main/diagnostics/diagnostic-event'
import {
  MAX_WORKBENCH_HEALTH_ITEMS,
  MAX_WORKBENCH_HEALTH_SNAPSHOT_BYTES,
  isWorkbenchHealthSnapshot,
} from '../src/shared'

const OWNER = { id: 7, generation: 2 }
const SENSITIVE = '/secret/project TOKEN=hvir-private terminal prompt'

describe('WorkbenchHealth', () => {
  it('keeps acknowledgement distinct from recurrence and renderer recovery', () => {
    const health = new WorkbenchHealth()
    health.observe(
      stored({
        kind: 'react-render-contained',
        ownerId: OWNER.id,
        ownerGeneration: OWNER.generation,
        occurrenceId: opaqueId(1),
      }),
    )

    expect(health.acknowledge(opaqueId(1))).toBe(true)
    expect(health.snapshot('durable').items[0]?.state).toBe('acknowledged')

    health.observe(
      stored(
        {
          kind: 'react-render-contained',
          ownerId: OWNER.id,
          ownerGeneration: OWNER.generation,
          occurrenceId: opaqueId(2),
        },
        2,
      ),
    )
    const recurring = health.snapshot('durable').items[0]
    expect(recurring).toMatchObject({
      occurrenceId: opaqueId(1),
      state: 'open',
      count: 2,
    })
    expect(recurring).not.toHaveProperty('recoveryOutcome')

    const [recovery] = health.rendererReady({ id: OWNER.id, generation: 3 })
    expect(recovery).toMatchObject({
      kind: 'workbench-health-recovered',
      occurrenceId: opaqueId(1),
      outcome: 'renderer-reloaded',
    })
    health.observe(stored(recovery!, 3))
    expect(health.snapshot('durable').items[0]).toMatchObject({
      state: 'resolved',
      recoveryOutcome: 'renderer-reloaded',
    })
    expect(health.rendererClosed({ id: OWNER.id, generation: 3 })).toEqual([])
    expect(health.observe(stored(recovery!, 4))).toBe(false)
  })

  it('closes active renderer evidence idempotently and rejects late recovery', () => {
    const health = new WorkbenchHealth()
    const occurrenceId = opaqueId(6)
    health.observe(
      stored({
        kind: 'renderer-unresponsive',
        ownerId: OWNER.id,
        ownerGeneration: OWNER.generation,
        occurrenceId,
      }),
    )

    const [closed] = health.rendererClosed(OWNER)
    expect(closed).toMatchObject({ occurrenceId, outcome: 'window-closed' })
    expect(health.observe(stored(closed!, 1))).toBe(true)
    expect(health.rendererClosed(OWNER)).toEqual([])
    expect(
      health.observe(
        stored(
          {
            kind: 'workbench-health-recovered',
            ownerId: OWNER.id,
            ownerGeneration: OWNER.generation,
            occurrenceId,
            outcome: 'responsive',
          },
          2,
        ),
      ),
    ).toBe(false)
    expect(health.snapshot('durable').items[0]?.recoveryOutcome).toBe('window-closed')
  })

  it('keeps ratified window faults separate and ignores expected IPC evidence', () => {
    const health = new WorkbenchHealth()
    health.observe(
      stored({
        kind: 'ipc-contract-rejected',
        channel: 'pty:start',
        outcome: 'renderer-revoked',
        timing: 'under-1ms',
      }),
    )
    health.observe(
      stored({
        kind: 'main-document-load-failed',
        ownerId: OWNER.id,
        ownerGeneration: OWNER.generation,
        occurrenceId: opaqueId(4),
        failure: 'connection',
        impact: 'critical',
        error: SENSITIVE,
        url: SENSITIVE,
      } as RuntimeDiagnosticEvent),
    )
    health.observe(
      stored({
        kind: 'renderer-unresponsive',
        ownerId: OWNER.id,
        ownerGeneration: OWNER.generation,
        occurrenceId: opaqueId(5),
      }),
    )

    const snapshot = health.snapshot('memory-only')
    expect(snapshot.items).toHaveLength(2)
    expect(snapshot.items.map(({ kind }) => kind)).toEqual([
      'main-document-load-failed',
      'renderer-unresponsive',
    ])
    expect(JSON.stringify(snapshot)).not.toContain(SENSITIVE)
  })

  it('round-trips only the closed window-health event schema', () => {
    const event = stored({
      kind: 'renderer-process-exited',
      ownerId: OWNER.id,
      ownerGeneration: OWNER.generation,
      occurrenceId: opaqueId(7),
      reason: 'integrity',
      error: SENSITIVE,
    } as RuntimeDiagnosticEvent)
    const line = serializeStoredDiagnosticEvent(event)

    expect(line).toBeDefined()
    if (!line) throw new Error('Window-health event must serialize')
    expect(line).not.toContain(SENSITIVE)
    expect(parseStoredDiagnosticEvent(JSON.parse(line))).toEqual(event)
    expect(parseStoredDiagnosticEvent({ ...event, path: SENSITIVE })).toBeUndefined()
  })

  it('bounds history and its closed renderer contract', () => {
    const health = new WorkbenchHealth()
    for (let index = 0; index < MAX_WORKBENCH_HEALTH_ITEMS + 6; index++) {
      const event = stored(
        {
          kind: 'renderer-process-exited',
          ownerId: OWNER.id,
          ownerGeneration: OWNER.generation,
          occurrenceId: opaqueId(index + 10),
          reason: 'crashed',
        },
        index,
      )
      health.observe(event)
      health.observe(
        stored(
          {
            kind: 'workbench-health-recovered',
            ownerId: OWNER.id,
            ownerGeneration: OWNER.generation,
            occurrenceId: String(event['occurrenceId']),
            outcome: 'renderer-reloaded',
          },
          index + 1,
        ),
      )
    }

    const snapshot = health.snapshot('durable')
    expect(snapshot.items).toHaveLength(MAX_WORKBENCH_HEALTH_ITEMS)
    expect(snapshot.dropped).toBe(6)
    expect(isWorkbenchHealthSnapshot(snapshot)).toBe(true)
    expect(new TextEncoder().encode(JSON.stringify(snapshot)).byteLength).toBeLessThan(
      MAX_WORKBENCH_HEALTH_SNAPSHOT_BYTES,
    )
    expect(
      isWorkbenchHealthSnapshot({ ...snapshot, version: 2, arbitrary: SENSITIVE }),
    ).toBe(false)
    expect(
      isWorkbenchHealthSnapshot({
        ...snapshot,
        items: snapshot.items.map((item, index) =>
          index === 0 ? { ...item, classification: 'unresponsive' } : item,
        ),
      }),
    ).toBe(false)
  })

  it('publishes accepted health only and isolates presentation failure', () => {
    const publish = vi.fn(() => {
      throw new Error(SENSITIVE)
    })
    const diagnostics = RuntimeDiagnostics.create('/unused', false, publish)

    expect(() =>
      diagnostics.recordWindowHealth({
        kind: 'renderer-process-exited',
        ownerId: OWNER.id,
        ownerGeneration: OWNER.generation,
        occurrenceId: opaqueId(90),
        reason: 'crashed',
      }),
    ).not.toThrow()
    expect(diagnostics.healthSnapshot()).toMatchObject({
      evidence: 'memory-only',
      items: [expect.objectContaining({ state: 'open' })],
    })
    expect(JSON.stringify(diagnostics.healthSnapshot())).not.toContain(SENSITIVE)
  })
})

function stored(event: RuntimeDiagnosticEvent, offset = 0): StoredDiagnosticEvent {
  const result = materializeDiagnosticEvent(event, {
    occurredAtMs: Date.parse('2026-07-22T12:00:00.000Z') + offset * 1_000,
    correlation: opaqueId(800 + offset),
  })
  if (!result) throw new Error('Test event must satisfy the diagnostic schema')
  return result
}

function opaqueId(value: number): string {
  return `019c0000-0000-7000-8000-${value.toString().padStart(12, '0')}`
}
