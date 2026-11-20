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
  firstFrameDelivery: {
    frameMs: number
    deliveredMs: number
    frameEpochMs: number
    deliveredEpochMs: number
  } | null
  callbackProgress?: {
    intervalMs: number
    unavailable: boolean
    totalTimerCallbacks: number
    worst: CallbackInterval | null
    records: CallbackInterval[]
    crossingCount: number
    truncated: boolean
  }
  restore(): void
}
interface CallbackInterval {
  origin: string
  frame: { fromMs: number; toMs: number; durationMs: number }
  callbacks: { fromMs: number; toMs: number; durationMs: number } | null
  timer: {
    unavailable: boolean
    callbacks: number | null
    firstMs: number | null
    lastMs: number | null
    maxSilenceMs: number | null
  }
}

/** The production script owns measurement policy; RAF delivery is its immediate edge. */
function rendererProbe(startedMs: number, queryProgress = false, failTimerSetup = false) {
  let nextFrame: ((timestamp: number) => void) | undefined
  let timerCallback: (() => void) | undefined
  let timerCleared = false
  let frameId = 0,
    clock = startedMs
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
  runInNewContext(clipboardInstall(false, queryProgress), {
    window,
    navigator: { clipboard: { writeText: () => Promise.resolve(undefined) } },
    document: new Document(),
    Document,
    performance: { now: () => clock, timeOrigin: 10000 },
    setInterval(callback: () => void, intervalMs: number) {
      if (failTimerSetup) throw new Error('Timer unavailable')
      expect(intervalMs).toBe(10)
      timerCallback = callback
      return 1
    },
    clearInterval(id: number) {
      expect(id).toBe(1)
      timerCleared = true
    },
    requestAnimationFrame: (callback: (timestamp: number) => void) => {
      nextFrame = callback
      return ++frameId
    },
  })
  if (!window.nativeSelectionProbe) throw new Error('Native renderer probe missing')
  return {
    probe: window.nativeSelectionProbe,
    timer(atMs: number) {
      clock = atMs
      if (!timerCallback) throw new Error('Native query timer missing')
      timerCallback()
    },
    timerCleared: () => timerCleared,
    frame(timestamp: number, deliveredMs = Math.max(startedMs, timestamp)) {
      clock = deliveredMs
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
      firstFrameDelivery: null,
    })
    f.frame(4446.2)
    expect(f.probe.frames).toBe(1)
    expect(f.probe.maxGapMs).toBeCloseTo(499.5)
    expect(f.probe.worstGap).toMatchObject({ fromMs: 3946.7, toMs: 4446.2 })
    expect(exceedsBudget(f.probe)).toBe(false)
  })

  it('records first qualifying frame delivery separately without changing the frame budget', () => {
    const f = rendererProbe(100)
    f.frame(99, 105)
    expect(f.probe.firstFrameDelivery).toBeNull()
    f.frame(600.1, 120)
    expect(f.probe.firstFrameDelivery).toEqual({
      frameMs: 600.1,
      deliveredMs: 120,
      frameEpochMs: 10600.1,
      deliveredEpochMs: 10120,
    })
    f.frame(616.8, 140)
    expect(f.probe.firstFrameDelivery?.deliveredMs).toBe(120)
    expect(exceedsBudget(f.probe)).toBe(true)
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

  it('records query timer progress separately while retaining the first qualifying gap', () => {
    const f = rendererProbe(100, true)
    f.frame(99, 105)
    for (const at of [110, 200, 300, 400, 500, 600]) f.timer(at)
    f.frame(600.1, 610)
    expect(f.probe.frames).toBe(1)
    expect(f.probe.maxGapMs).toBeCloseTo(500.1)
    expect(f.probe.firstFrameDelivery?.deliveredMs).toBe(610)
    expect(f.probe.callbackProgress?.worst).toMatchObject({
      origin: 'install-to-first-advancing-raf',
      frame: { fromMs: 100, toMs: 600.1 },
      callbacks: { fromMs: 100, toMs: 610, durationMs: 510 },
      timer: {
        unavailable: false,
        callbacks: 6,
        firstMs: 110,
        lastMs: 600,
        maxSilenceMs: 100,
      },
    })
    expect(exceedsBudget(f.probe)).toBe(true)
  })

  it('uses advancing callback entries for later timer windows without rebasing RAF timestamps', () => {
    const f = rendererProbe(100, true)
    f.frame(116.7, 120)
    f.timer(130)
    f.frame(700, 710)
    expect(f.probe.callbackProgress?.worst).toMatchObject({
      origin: 'advancing-raf-to-advancing-raf',
      frame: { fromMs: 116.7, toMs: 700 },
      callbacks: { fromMs: 120, toMs: 710 },
      timer: { callbacks: 1, maxSilenceMs: 580 },
    })
    expect(f.probe.maxGapMs).toBeCloseTo(583.3)
  })

  it('bounds crossing records while retaining a later global worst independently', () => {
    const f = rendererProbe(100, true)
    let timestamp = 100
    for (let index = 0; index < 17; index++) {
      timestamp += index === 16 ? 650 : 600
      f.frame(timestamp, timestamp + 2)
    }
    expect(f.probe.frames).toBe(17)
    expect(f.probe.maxGapMs).toBe(650)
    expect(f.probe.callbackProgress).toMatchObject({ crossingCount: 17, truncated: true })
    expect(f.probe.callbackProgress?.records).toHaveLength(16)
    expect(f.probe.callbackProgress?.worst?.frame.durationMs).toBe(650)
    expect(f.probe.callbackProgress?.records.at(-1)?.frame.durationMs).toBe(600)
  })

  it('clears the query timer and ignores late callbacks after restore', () => {
    const f = rendererProbe(100, true)
    f.timer(110)
    f.probe.restore()
    f.timer(500)
    f.frame(700)
    expect(f.timerCleared()).toBe(true)
    expect(f.probe.callbackProgress?.totalTimerCallbacks).toBe(1)
    expect(f.probe.frames).toBe(0)
  })

  it('reports unavailable timer evidence without changing qualification', () => {
    const f = rendererProbe(100, true, true)
    f.frame(600.1)
    expect(f.probe.callbackProgress?.unavailable).toBe(true)
    expect(f.probe.callbackProgress?.worst?.timer).toEqual({
      unavailable: true,
      callbacks: null,
      firstMs: null,
      lastMs: null,
      maxSilenceMs: null,
    })
    expect(exceedsBudget(f.probe)).toBe(true)
  })

  it('keeps the timer disabled for existing non-query callers', () => {
    const f = rendererProbe(100)
    f.frame(600.1)
    expect(f.probe.callbackProgress).toBeUndefined()
    expect(exceedsBudget(f.probe)).toBe(true)
  })
})
