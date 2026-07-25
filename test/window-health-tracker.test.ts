import { describe, expect, it, vi } from 'vitest'

import { WindowHealthTracker } from '../src/main/window/window-health-tracker'
import type { WindowHealthDiagnostic } from '../src/main/health/workbench-health-events'

const OWNER = { id: 9, generation: 4 }

describe('WindowHealthTracker', () => {
  it('classifies and deduplicates main-document load evidence without raw context', () => {
    const events: WindowHealthDiagnostic[] = []
    const tracker = new WindowHealthTracker((event) => events.push(event))

    tracker.documentFailed(OWNER, -3, false)
    tracker.documentFailed(OWNER, -105, false)
    tracker.documentFailed(OWNER, -105, false)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: 'main-document-load-failed',
      failure: 'connection',
      impact: 'critical',
    })
    tracker.documentStarted()
    tracker.documentFailed(OWNER, -202, true)
    expect(events[1]).toMatchObject({ failure: 'certificate', impact: 'degraded' })
    expect(events[1]?.occurrenceId).not.toBe(events[0]?.occurrenceId)
  })

  it('correlates unresponsiveness with one safe recovery and rejects late outcomes', () => {
    const record = vi.fn<(event: WindowHealthDiagnostic) => void>()
    const tracker = new WindowHealthTracker(record)
    const episode = tracker.unresponsive(OWNER)

    tracker.responsive(OWNER)
    expect(record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'workbench-health-recovered',
        occurrenceId: episode.occurrenceId,
        outcome: 'responsive',
      }),
    )
    const before = record.mock.calls.length
    tracker.recoverUnresponsive(episode, 'reload-requested')
    expect(record).toHaveBeenCalledTimes(before)
  })

  it('keeps a Wait episode active until the renderer becomes responsive', () => {
    const events: WindowHealthDiagnostic[] = []
    const tracker = new WindowHealthTracker((event) => events.push(event))
    const episode = tracker.unresponsive(OWNER)

    tracker.recoverUnresponsive(episode, 'wait-selected')
    tracker.responsive(OWNER)

    expect(events.slice(1)).toEqual([
      expect.objectContaining({
        occurrenceId: episode.occurrenceId,
        outcome: 'wait-selected',
      }),
      expect.objectContaining({
        occurrenceId: episode.occurrenceId,
        outcome: 'responsive',
      }),
    ])
    const before = events.length
    tracker.recoverUnresponsive(episode, 'reload-requested')
    expect(events).toHaveLength(before)
  })

  it('resolves an unresponsive episode before recording an unexpected exit', () => {
    const events: WindowHealthDiagnostic[] = []
    const tracker = new WindowHealthTracker((event) => events.push(event))
    const episode = tracker.unresponsive(OWNER)
    tracker.rendererGone(OWNER, 'oom')

    expect(events.slice(1)).toEqual([
      expect.objectContaining({
        kind: 'workbench-health-recovered',
        occurrenceId: episode.occurrenceId,
        outcome: 'renderer-exited',
      }),
      expect.objectContaining({ kind: 'renderer-process-exited', reason: 'oom' }),
    ])
    const before = events.length
    tracker.rendererGone(OWNER, 'clean-exit')
    expect(events).toHaveLength(before)
    tracker.rendererGone(OWNER, 'crashed', 'forced-for-reload')
    expect(events).toHaveLength(before)
  })

  it('distinguishes requested, failed, and successful renderer reloads', () => {
    const events: WindowHealthDiagnostic[] = []
    const tracker = new WindowHealthTracker((event) => events.push(event))
    const episode = tracker.unresponsive(OWNER)

    tracker.recoverUnresponsive(episode, 'reload-requested')
    tracker.rendererGone(OWNER, 'killed', 'forced-for-reload')
    tracker.responsive({ ...OWNER, generation: OWNER.generation + 1 })
    tracker.recoverUnresponsive(episode, 'reload-failed')
    tracker.recoverUnresponsive(episode, 'reload-requested')
    tracker.recoverUnresponsive(episode, 'reload-succeeded')

    expect(
      events
        .filter((event) => event.kind === 'workbench-health-recovered')
        .map((event) => event.outcome),
    ).toEqual([
      'reload-requested',
      'reload-failed',
      'reload-requested',
      'reload-succeeded',
    ])
  })

  it('records a replacement exit without resolving the original episode', () => {
    const events: WindowHealthDiagnostic[] = []
    const tracker = new WindowHealthTracker((event) => events.push(event))
    const episode = tracker.unresponsive(OWNER)
    const replacement = { ...OWNER, generation: OWNER.generation + 1 }

    tracker.recoverUnresponsive(episode, 'reload-requested')
    tracker.rendererGone(replacement, 'crashed', 'replacement-failed')
    tracker.recoverUnresponsive(episode, 'reload-failed')

    expect(events.slice(1)).toEqual([
      expect.objectContaining({ outcome: 'reload-requested' }),
      expect.objectContaining({
        kind: 'renderer-process-exited',
        ownerGeneration: replacement.generation,
      }),
      expect.objectContaining({ outcome: 'reload-failed' }),
    ])
  })
})
