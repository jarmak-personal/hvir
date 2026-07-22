import { describe, expect, it, vi } from 'vitest'

import {
  RendererResponsivenessDetector,
  type DetectorEnvironment,
} from '../src/renderer/src/diagnostics/renderer-responsiveness-detector'

const SESSION = '019c0000-0000-7000-8000-000000000001'

describe('RendererResponsivenessDetector', () => {
  it('omits startup, groups settled tasks, and reports only timing classifications', () => {
    const fixture = environment()
    const observe = vi.fn()
    const stop = vi.fn()
    const detector = new RendererResponsivenessDetector(
      { observe, stop },
      fixture.environment,
    )
    expect(detector.start(SESSION)).toBe(true)

    fixture.emit('longtask', [{ startTime: 500, duration: 900 }])
    fixture.emit('event', [{ startTime: 1_550, duration: 110 }])
    fixture.emit('longtask', [
      { startTime: 1_500, duration: 120 },
      { startTime: 1_800, duration: 220 },
      { startTime: 4_000, duration: 510 },
    ])
    fixture.settle()

    expect(observe).toHaveBeenCalledTimes(2)
    expect(observe).toHaveBeenNthCalledWith(1, {
      version: 1,
      diagnosticSessionId: SESSION,
      observationCount: 2,
      dropped: 0,
      timing: '200-499ms',
      classification: 'input-paint-delay',
      confounder: 'none',
    })
    expect(observe).toHaveBeenNthCalledWith(2, {
      version: 1,
      diagnosticSessionId: SESSION,
      observationCount: 1,
      dropped: 0,
      timing: '500ms-or-more',
      classification: 'unattributed',
      confounder: 'runtime-or-environment',
    })
    expect(JSON.stringify(observe.mock.calls)).not.toContain('event-name')
    expect(stop).not.toHaveBeenCalled()
  })

  it('stops cleanly on backgrounding and API loss without late observations', () => {
    const fixture = environment()
    const observe = vi.fn()
    const stop = vi.fn()
    const detector = new RendererResponsivenessDetector(
      { observe, stop },
      fixture.environment,
    )
    detector.start(SESSION)
    fixture.emit('longtask', [{ startTime: 1_500, duration: 120 }])
    fixture.hide()
    fixture.settle()
    expect(stop).toHaveBeenCalledWith('backgrounded')
    expect(observe).not.toHaveBeenCalled()

    const failed = new RendererResponsivenessDetector(
      { observe, stop },
      {
        ...fixture.environment,
        observe: () => {
          throw new Error('observer unavailable')
        },
      },
    )
    expect(failed.start(SESSION)).toBe(false)
    expect(stop).toHaveBeenCalledWith('api-unavailable')
  })

  it('accounts for entries omitted by its bounded settle queue', () => {
    const fixture = environment()
    const observe = vi.fn()
    const detector = new RendererResponsivenessDetector(
      { observe, stop: vi.fn() },
      fixture.environment,
    )
    detector.start(SESSION)
    fixture.emit(
      'longtask',
      Array.from({ length: 70 }, (_value, index) => ({
        startTime: 1_500 + index * 101,
        duration: 100,
      })),
    )
    fixture.settle()

    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({ observationCount: 64, dropped: 6 }),
    )
  })
})

function environment(): {
  readonly environment: DetectorEnvironment
  readonly emit: (type: 'longtask' | 'event', entries: TimingEntry[]) => void
  readonly settle: () => void
  readonly hide: () => void
} {
  const observers = new Map<string, (entries: TimingEntry[]) => void>()
  let scheduled: (() => void) | undefined
  let visibilityChanged: (() => void) | undefined
  let visible = true
  return {
    environment: {
      now: () => 0,
      visible: () => visible,
      supports: () => true,
      observe: (type, callback) => {
        observers.set(type, callback)
        return () => observers.delete(type)
      },
      schedule: (callback) => {
        scheduled = callback
        return () => {
          if (scheduled === callback) scheduled = undefined
        }
      },
      onVisibilityChange: (callback) => {
        visibilityChanged = callback
        return () => {
          if (visibilityChanged === callback) visibilityChanged = undefined
        }
      },
    },
    emit: (type, entries) => observers.get(type)?.(entries),
    settle: () => scheduled?.(),
    hide: () => {
      visible = false
      visibilityChanged?.()
    },
  }
}

interface TimingEntry {
  readonly startTime: number
  readonly duration: number
}
