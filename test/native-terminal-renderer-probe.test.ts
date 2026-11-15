import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { clipboardInstall } from '../src/main/smoke/native-terminal-selection-browser'
import { UI_RESPONSIVENESS_BUDGET } from '../src/shared/ui-responsiveness-budget'

interface Probe {
  startedMs: number
  last: number
  frames: number
  maxGapMs: number
  worstGap: { fromMs: number; toMs: number } | null
}

/** The production script owns measurement policy; RAF delivery is its immediate edge. */
function rendererProbe(startedMs: number) {
  let nextFrame: ((timestamp: number) => void) | undefined
  let frameId = 0
  class Document {
    get visibilityState() {
      return 'visible'
    }
    hasFocus() {
      return true
    }
    addEventListener() {}
    removeEventListener() {}
  }
  const window: { nativeSelectionProbe?: Probe; open(): null } = { open: () => null }
  runInNewContext(clipboardInstall(false), {
    window,
    navigator: { clipboard: { writeText: () => Promise.resolve(undefined) } },
    document: new Document(),
    Document,
    performance: { now: () => startedMs, timeOrigin: 10000 },
    requestAnimationFrame: (callback: (timestamp: number) => void) => {
      nextFrame = callback
      return ++frameId
    },
  })
  if (!window.nativeSelectionProbe) throw new Error('Native renderer probe missing')
  return {
    probe: window.nativeSelectionProbe,
    frame(timestamp: number) {
      const callback = nextFrame
      if (!callback) throw new Error('Native renderer probe failed to request a frame')
      nextFrame = undefined
      callback(timestamp)
    },
  }
}

const exceedsBudget = (probe: Probe) =>
  probe.maxGapMs > UI_RESPONSIVENESS_BUDGET.responsivenessMaxMs

describe('native renderer qualification clock boundary', () => {
  it('ignores old RAF timestamps without rewinding the start or inventing qualifying frames', () => {
    const f = rendererProbe(3946.7)
    f.frame(3945.8)
    f.frame(3945.8)
    expect(f.probe).toMatchObject({
      startedMs: 3946.7,
      last: 3946.7,
      frames: 0,
      maxGapMs: 0,
      worstGap: null,
    })
    f.frame(4446.2)
    expect(f.probe.frames).toBe(1)
    expect(f.probe.maxGapMs).toBeCloseTo(499.5)
    expect(f.probe.worstGap).toMatchObject({ fromMs: 3946.7, toMs: 4446.2 })
    expect(exceedsBudget(f.probe)).toBe(false)
  })

  it('retains a genuine first post-start gap above the unchanged 500ms limit', () => {
    const f = rendererProbe(100)
    f.frame(600.1)
    expect(f.probe.frames).toBe(1)
    expect(f.probe.worstGap).toMatchObject({ fromMs: 100, toMs: 600.1 })
    expect(exceedsBudget(f.probe)).toBe(true)
  })

  it('still fails a later qualifying interval above 500ms after an old callback', () => {
    const f = rendererProbe(100)
    f.frame(99)
    f.frame(116.7)
    f.frame(700)
    expect(f.probe.frames).toBe(2)
    expect(f.probe.worstGap).toMatchObject({ fromMs: 116.7, toMs: 700 })
    expect(exceedsBudget(f.probe)).toBe(true)
  })

  it('keeps a 500.4ms gap wholly inside the qualification window as a failure', () => {
    const f = rendererProbe(100)
    f.frame(110)
    f.frame(610.4)
    expect(f.probe.frames).toBe(2)
    expect(f.probe.maxGapMs).toBeCloseTo(500.4)
    expect(f.probe.worstGap).toMatchObject({ fromMs: 110, toMs: 610.4 })
    expect(exceedsBudget(f.probe)).toBe(true)
  })
})
