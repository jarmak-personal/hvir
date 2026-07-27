export const DEVELOPMENT_PERFORMANCE_MEASURE_POLICY_ID =
  'hvir:development-performance-measure-budget:v1'
// #289's observed cleanup delta was roughly 2 KiB per entry; retain about 16 MiB
// of development evidence while bounding the browser-owned collection.
export const DEVELOPMENT_MEASURE_ENTRY_BUDGET = 8_192
// Inspection is periodic, but entry count alone decides whether cleanup runs.
export const DEVELOPMENT_MEASURE_INSPECTION_INTERVAL_MS = 5_000

export interface PerformanceMeasureTimeline {
  getEntriesByType(type: 'measure'): readonly PerformanceTimelineEntry[]
  clearMeasures(): void
}

export interface PerformanceTimelineEntry {
  readonly entryType: string
}

export interface IntervalSchedule {
  setInterval(callback: () => void, delayMs: number): number
  clearInterval(handle: number): void
}

/** Development-only owner for Blink's otherwise-unbounded measure collection. */
export class DevelopmentPerformanceMeasureBudget {
  private timer?: number
  private generation = 0
  private disposed = false

  constructor(
    private readonly timeline: PerformanceMeasureTimeline,
    private readonly schedule: IntervalSchedule,
    private readonly entryBudget = DEVELOPMENT_MEASURE_ENTRY_BUDGET,
    private readonly inspectionIntervalMs = DEVELOPMENT_MEASURE_INSPECTION_INTERVAL_MS,
  ) {
    if (!Number.isSafeInteger(entryBudget) || entryBudget < 1) {
      throw new Error(
        `${DEVELOPMENT_PERFORMANCE_MEASURE_POLICY_ID}: invalid entry budget`,
      )
    }
    if (!Number.isSafeInteger(inspectionIntervalMs) || inspectionIntervalMs < 1) {
      throw new Error(
        `${DEVELOPMENT_PERFORMANCE_MEASURE_POLICY_ID}: invalid inspection interval`,
      )
    }
  }

  start(): void {
    if (this.disposed || this.timer !== undefined) return
    const generation = ++this.generation
    this.timer = this.schedule.setInterval(() => {
      if (this.disposed || generation !== this.generation) return
      if (this.timeline.getEntriesByType('measure').length > this.entryBudget) {
        // React's dynamic names do not provide reliable selective ownership.
        this.timeline.clearMeasures()
      }
    }, this.inspectionIntervalMs)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generation++
    if (this.timer !== undefined) this.schedule.clearInterval(this.timer)
    this.timer = undefined
  }
}
