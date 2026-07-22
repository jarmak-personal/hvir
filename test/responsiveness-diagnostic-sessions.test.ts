import { describe, expect, it } from 'vitest'

import { DiagnosticIntake } from '../src/main/diagnostics/diagnostic-intake'
import { ResponsivenessDiagnosticSessions } from '../src/main/diagnostics/responsiveness-diagnostic-sessions'
import type { RendererOwner } from '../src/main/renderer-resource-scopes'
import {
  RENDERER_RESPONSIVENESS_MAX_DURATION_MS,
  RENDERER_RESPONSIVENESS_VERSION,
  type ResponsivenessObservation,
} from '../src/shared'

const OWNER: RendererOwner = { id: 7, generation: 3 }
const NOW = Date.parse('2026-07-22T12:00:00.000Z')
const SENTINEL = '/secret/project TOKEN=hvir-private raw-input'

describe('ResponsivenessDiagnosticSessions', () => {
  it('keeps the packaged application unavailable and evidence-free', () => {
    const fixture = createFixture(false)

    expect(fixture.sessions.start(OWNER)).toEqual({
      version: 1,
      available: false,
      status: 'unavailable',
      reason: 'packaged-build',
    })
    fixture.sessions.observe(OWNER, batch(opaqueId(1)))
    expect(fixture.intake.snapshot().events).toEqual([])
  })

  it('aggregates by a 30-second owner window and retains only the closed schema', () => {
    const fixture = createFixture()
    const active = fixture.sessions.start(OWNER)
    expect(active.status).toBe('active')
    if (active.status !== 'active') return

    fixture.sessions.observe(OWNER, batch(active.diagnosticSessionId))
    fixture.advance(1_000)
    fixture.sessions.observe(
      OWNER,
      batch(active.diagnosticSessionId, [
        observation(active.diagnosticSessionId, {
          observationCount: 2,
          timing: '500ms-or-more',
          classification: 'unattributed',
          confounder: 'runtime-or-environment',
        }),
      ]),
    )
    fixture.sessions.observe(OWNER, {
      ...batch(active.diagnosticSessionId),
      arbitrary: SENTINEL,
    })
    fixture.advance(30_000)
    fixture.sessions.observe(OWNER, batch(active.diagnosticSessionId))
    fixture.advance(500)
    const complete = fixture.sessions.stop(OWNER, active.diagnosticSessionId, 'user-stop')

    expect(complete).toMatchObject({
      status: 'complete',
      observationCount: 4,
      aggregateCount: 2,
      dropped: 0,
      stopReason: 'user-stop',
    })
    expect(fixture.intake.snapshot().events).toEqual([
      expect.objectContaining({
        kind: 'renderer-responsiveness-episode',
        owner: 'renderer-responsiveness',
        ownerGeneration: 3,
        sessionId: active.diagnosticSessionId,
        count: 3,
        drop: 0,
        timing: '500ms-or-more',
        classification: 'unattributed',
        confounder: 'runtime-or-environment',
        resolution: 'window-rollover',
      }),
      expect.objectContaining({
        count: 1,
        classification: 'input-paint-delay',
        resolution: 'user-stop',
      }),
    ])
    expect(JSON.stringify(fixture.intake.snapshot())).not.toContain(SENTINEL)
    expect(fixture.written.every((line) => Buffer.byteLength(line) <= 512)).toBe(true)
  })

  it('bounds observations, rejects stale generations, times out, and deletes idempotently', () => {
    const fixture = createFixture()
    const active = fixture.sessions.start(OWNER)
    if (active.status !== 'active') return
    fixture.sessions.observe(
      OWNER,
      batch(active.diagnosticSessionId, [
        observation(active.diagnosticSessionId, { observationCount: 512 }),
      ]),
    )
    fixture.sessions.observe(
      OWNER,
      batch(active.diagnosticSessionId, undefined, { invalid: 0, queue: 0, rate: 1 }),
    )
    fixture.sessions.observe(
      { id: OWNER.id, generation: OWNER.generation + 1 },
      batch(active.diagnosticSessionId),
    )

    fixture.advance(RENDERER_RESPONSIVENESS_MAX_DURATION_MS)
    fixture.expire?.()
    expect(fixture.sessions.state(OWNER)).toMatchObject({
      status: 'complete',
      stopReason: 'timeout',
      observationCount: 512,
      aggregateCount: 1,
      dropped: 2,
    })
    expect(fixture.sessions.delete(OWNER, active.diagnosticSessionId)).toMatchObject({
      status: 'idle',
    })
    expect(fixture.sessions.delete(OWNER, active.diagnosticSessionId)).toMatchObject({
      status: 'idle',
    })
    expect(fixture.intake.snapshot().events).toEqual([])
  })

  it('saturates drop accounting while every accepted aggregate stays within 512 bytes', () => {
    const fixture = createFixture()
    const owner = { id: Number.MAX_SAFE_INTEGER, generation: Number.MAX_SAFE_INTEGER }
    const active = fixture.sessions.start(owner)
    if (active.status !== 'active') return
    fixture.sessions.observe(
      owner,
      batch(
        active.diagnosticSessionId,
        [
          observation(active.diagnosticSessionId, {
            observationCount: 512,
            timing: '500ms-or-more',
            classification: 'unattributed',
            confounder: 'runtime-or-environment',
          }),
        ],
        {
          invalid: Number.MAX_SAFE_INTEGER,
          queue: Number.MAX_SAFE_INTEGER,
          rate: Number.MAX_SAFE_INTEGER,
        },
      ),
    )
    expect(
      fixture.sessions.stop(owner, active.diagnosticSessionId, 'user-stop'),
    ).toMatchObject({ dropped: 9_999 })
    expect(fixture.written).toHaveLength(1)
    expect(Buffer.byteLength(fixture.written[0]!)).toBeLessThanOrEqual(512)
  })
})

function createFixture(available = true): {
  readonly intake: DiagnosticIntake
  readonly sessions: ResponsivenessDiagnosticSessions
  readonly written: string[]
  readonly advance: (elapsedMs: number) => void
  readonly expire?: () => void
} {
  let now = NOW
  let expire: (() => void) | undefined
  const written: string[] = []
  const intake = new DiagnosticIntake({
    now: () => now,
    correlation: () => opaqueId(90),
    writer: {
      record: (line) => {
        written.push(line)
        return true
      },
      status: () => ({
        location: '/disposable/runtime-diagnostics.jsonl',
        sink: 'available',
        dropped: { queue: 0, storage: 0 },
      }),
    },
  })
  const result = {
    intake,
    written,
    sessions: new ResponsivenessDiagnosticSessions(intake, {
      available,
      now: () => now,
      sessionId: () => opaqueId(1),
      schedule: (callback) => {
        expire = callback
        return () => {
          if (expire === callback) expire = undefined
        }
      },
    }),
    advance: (elapsedMs: number) => {
      now += elapsedMs
    },
    get expire() {
      return expire
    },
  }
  return result
}

function observation(
  diagnosticSessionId: string,
  overrides: Partial<ResponsivenessObservation> = {},
): ResponsivenessObservation {
  return {
    version: RENDERER_RESPONSIVENESS_VERSION,
    diagnosticSessionId,
    observationCount: 1,
    dropped: 0,
    timing: '100-199ms',
    classification: 'input-paint-delay',
    confounder: 'none',
    ...overrides,
  }
}

function batch(
  diagnosticSessionId: string,
  observations = [observation(diagnosticSessionId)],
  dropped = { invalid: 0, queue: 0, rate: 0 },
) {
  return {
    version: RENDERER_RESPONSIVENESS_VERSION,
    diagnosticSessionId,
    observations,
    dropped,
  } as const
}

function opaqueId(value: number): string {
  return `019c0000-0000-7000-8000-${value.toString().padStart(12, '0')}`
}
