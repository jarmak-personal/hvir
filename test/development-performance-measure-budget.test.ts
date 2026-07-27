import { describe, expect, it, vi } from 'vitest'

import {
  DevelopmentPerformanceMeasureBudget,
  type IntervalSchedule,
  type PerformanceMeasureTimeline,
  type PerformanceTimelineEntry,
} from '../src/renderer/src/development/performance-measure-budget'

describe('development Performance Timeline measure budget', () => {
  it('retains measure evidence at or below the entry budget', () => {
    const timeline = new FakeTimeline([entry('measure'), entry('measure'), entry('mark')])
    const schedule = new FakeSchedule()
    const owner = new DevelopmentPerformanceMeasureBudget(timeline, schedule, 2, 100)

    owner.start()
    schedule.inspect()

    expect(timeline.clearMeasures).not.toHaveBeenCalled()
    expect(timeline.entries).toHaveLength(3)
  })

  it('clears only measures after the entry budget is exceeded', () => {
    const timeline = new FakeTimeline([
      entry('measure'),
      entry('measure'),
      entry('measure'),
      entry('mark'),
      entry('resource'),
    ])
    const schedule = new FakeSchedule()
    const owner = new DevelopmentPerformanceMeasureBudget(timeline, schedule, 2, 100)

    owner.start()
    schedule.inspect()

    expect(timeline.clearMeasures).toHaveBeenCalledOnce()
    expect(timeline.entries.map(({ entryType }) => entryType)).toEqual([
      'mark',
      'resource',
    ])
  })

  it('owns one schedule and rejects callbacks after teardown', () => {
    const timeline = new FakeTimeline([entry('measure'), entry('measure')])
    const schedule = new FakeSchedule()
    const owner = new DevelopmentPerformanceMeasureBudget(timeline, schedule, 1, 100)

    owner.start()
    owner.start()
    expect(schedule.setInterval).toHaveBeenCalledOnce()
    const obsoleteInspection = schedule.callback

    owner.dispose()
    owner.dispose()
    expect(schedule.clearInterval).toHaveBeenCalledOnce()
    obsoleteInspection?.()
    expect(timeline.clearMeasures).not.toHaveBeenCalled()
  })
})

class FakeTimeline implements PerformanceMeasureTimeline {
  readonly clearMeasures = vi.fn(() => {
    this.entries = this.entries.filter(({ entryType }) => entryType !== 'measure')
  })

  constructor(public entries: PerformanceTimelineEntry[]) {}

  getEntriesByType(type: 'measure'): readonly PerformanceTimelineEntry[] {
    return this.entries.filter(({ entryType }) => entryType === type)
  }
}

class FakeSchedule implements IntervalSchedule {
  callback?: () => void
  readonly setInterval = vi.fn((callback: () => void, _delayMs: number) => {
    this.callback = callback
    return 17
  })
  readonly clearInterval = vi.fn((_handle: number) => {
    this.callback = undefined
  })

  inspect(): void {
    this.callback?.()
  }
}

function entry(entryType: string): PerformanceTimelineEntry {
  return { entryType }
}
