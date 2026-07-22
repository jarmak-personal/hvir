import { describe, expect, it, vi } from 'vitest'

import { RendererDiagnosticsAdapter } from '../src/preload/renderer-diagnostics'
import {
  MAX_RENDERER_DIAGNOSTIC_BATCH_BYTES,
  MAX_RENDERER_DIAGNOSTIC_BATCH_EVENTS,
  MAX_RENDERER_DIAGNOSTIC_QUEUE_BYTES,
  RENDERER_DIAGNOSTIC_VERSION,
  RENDERER_RESPONSIVENESS_VERSION,
  RENDERER_RESPONSIVENESS_BATCH_BYTES,
  RENDERER_RESPONSIVENESS_QUEUE_BYTES,
  type RenderContainmentDiagnosticBatch,
  type ResponsivenessObservationBatch,
} from '../src/shared'

const SESSION_ID = opaqueId(900)

describe('RendererDiagnosticsAdapter', () => {
  it('waits for a main-issued session and emits only the closed feature schema', () => {
    const tasks: Array<() => void> = []
    const sent: RenderContainmentDiagnosticBatch[] = []
    const adapter = new RendererDiagnosticsAdapter({
      send: (batch) => sent.push(batch),
      now: () => 1_000,
      schedule: (task) => tasks.push(task),
    })

    adapter.recordRenderContainment('/secret/path TOKEN=hvir-private')
    adapter.recordRenderContainment(opaqueId(1))
    expect(tasks).toEqual([])
    expect(() => adapter.activate(null)).not.toThrow()
    adapter.activate({
      version: 2,
      ownerGeneration: 4,
      sessionId: SESSION_ID,
      arbitrary: '/secret/path',
    })
    expect(tasks).toEqual([])

    adapter.activate({
      version: RENDERER_DIAGNOSTIC_VERSION,
      ownerGeneration: 4,
      sessionId: SESSION_ID,
    })
    tasks.shift()?.()

    expect(sent).toEqual([
      {
        version: 1,
        session: { version: 1, ownerGeneration: 4, sessionId: SESSION_ID },
        events: [],
        dropped: { invalid: 1, queue: 0, rate: 0, unavailable: 1 },
      },
    ])
    expect(JSON.stringify(sent)).not.toMatch(/secret|TOKEN|path/)
  })

  it('bounds queued events, batches, serialized bytes, and safe drop counts', () => {
    const tasks: Array<() => void> = []
    const sent: RenderContainmentDiagnosticBatch[] = []
    let now = 0
    const adapter = new RendererDiagnosticsAdapter({
      send: (batch) => sent.push(batch),
      now: () => now,
      schedule: (task) => tasks.push(task),
    })
    adapter.activate({ version: 1, ownerGeneration: 1, sessionId: SESSION_ID })

    for (let index = 0; index < 70; index++) {
      now += 250
      adapter.recordRenderContainment(opaqueId(index))
    }
    while (tasks.length > 0) tasks.shift()?.()

    expect(sent.flatMap(({ events }) => events)).toHaveLength(64)
    expect(sent.reduce((total, batch) => total + batch.dropped.queue, 0)).toBe(6)
    expect(
      sent.every(
        (batch) =>
          batch.events.length <= MAX_RENDERER_DIAGNOSTIC_BATCH_EVENTS &&
          Buffer.byteLength(JSON.stringify(batch), 'utf8') <=
            MAX_RENDERER_DIAGNOSTIC_BATCH_BYTES,
      ),
    ).toBe(true)
    expect(
      Buffer.byteLength(JSON.stringify(sent.flatMap(({ events }) => events)), 'utf8'),
    ).toBeLessThan(MAX_RENDERER_DIAGNOSTIC_QUEUE_BYTES)
  })

  it('rate-limits a burst and never lets transport failure reach the feature', () => {
    const tasks: Array<() => void> = []
    const send = vi.fn((_batch: RenderContainmentDiagnosticBatch) => {
      throw new Error('main is gone')
    })
    const adapter = new RendererDiagnosticsAdapter({
      send,
      now: () => 0,
      schedule: (task) => tasks.push(task),
    })
    adapter.activate({ version: 1, ownerGeneration: 1, sessionId: SESSION_ID })

    expect(() => {
      for (let index = 0; index < 20; index++) {
        adapter.recordRenderContainment(opaqueId(index))
      }
      while (tasks.length > 0) tasks.shift()?.()
    }).not.toThrow()
    const [batch] = send.mock.calls[0]!
    expect(Array.isArray(batch.events)).toBe(true)
    expect(batch.dropped.rate).toBe(4)
  })

  it('routes responsiveness through the same bounded droppable preload path', () => {
    const tasks: Array<() => void> = []
    const sent: ResponsivenessObservationBatch[] = []
    let now = 0
    const adapter = new RendererDiagnosticsAdapter({
      send: vi.fn(),
      sendResponsiveness: (batch) => sent.push(batch),
      now: () => now,
      schedule: (task) => tasks.push(task),
    })
    for (let index = 0; index < 70; index++) {
      now += 250
      adapter.recordResponsivenessObservation({
        version: RENDERER_RESPONSIVENESS_VERSION,
        diagnosticSessionId: SESSION_ID,
        observationCount: 1,
        dropped: 0,
        timing: '100-199ms',
        classification: 'unattributed',
        confounder: 'runtime-or-environment',
      })
    }
    adapter.recordResponsivenessObservation({
      version: 1,
      diagnosticSessionId: SESSION_ID,
      arbitrary: '/secret/path TOKEN=hvir-private',
    })
    while (tasks.length > 0) tasks.shift()?.()

    expect(sent.flatMap(({ observations }) => observations)).toHaveLength(64)
    expect(sent.reduce((total, batch) => total + batch.dropped.queue, 0)).toBe(6)
    expect(sent.reduce((total, batch) => total + batch.dropped.invalid, 0)).toBe(1)
    expect(sent.every((batch) => batch.observations.length <= 16)).toBe(true)
    expect(
      sent.every(
        (batch) =>
          Buffer.byteLength(JSON.stringify(batch), 'utf8') <=
          RENDERER_RESPONSIVENESS_BATCH_BYTES,
      ),
    ).toBe(true)
    expect(
      Buffer.byteLength(JSON.stringify(sent.flatMap(({ observations }) => observations))),
    ).toBeLessThan(RENDERER_RESPONSIVENESS_QUEUE_BYTES)
    expect(JSON.stringify(sent)).not.toMatch(/secret|TOKEN|path/)
  })
})

function opaqueId(value: number): string {
  return `019c0000-0000-7000-8000-${value.toString().padStart(12, '0')}`
}
