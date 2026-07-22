import {
  RENDERER_RESPONSIVENESS_VERSION,
  type ResponsivenessObservation,
  type ResponsivenessStopReason,
  type ResponsivenessTiming,
} from '../../../shared'

const LONG_TASK_THRESHOLD_MS = 100
const STARTUP_WARMUP_MS = 1_000
const EPISODE_GAP_MS = 1_000
const CORRELATION_MARGIN_MS = 250
const SETTLE_MS = 300
const MAX_PENDING_ENTRIES = 64

interface TimingEntry {
  readonly startTime: number
  readonly duration: number
}

export interface DetectorEnvironment {
  readonly now: () => number
  readonly visible: () => boolean
  readonly supports: (type: 'longtask' | 'event') => boolean
  readonly observe: (
    type: 'longtask' | 'event',
    callback: (entries: readonly TimingEntry[]) => void,
  ) => () => void
  readonly schedule: (callback: () => void, delayMs: number) => () => void
  readonly onVisibilityChange: (callback: () => void) => () => void
}

export interface RendererResponsivenessDetectorCallbacks {
  readonly observe: (observation: ResponsivenessObservation) => void
  readonly stop: (
    reason: Extract<ResponsivenessStopReason, 'backgrounded' | 'api-unavailable'>,
  ) => void
}

/** Content-free Long Tasks experiment; observations remain low-confidence evidence. */
export class RendererResponsivenessDetector {
  private readonly tasks: TimingEntry[] = []
  private readonly events: TimingEntry[] = []
  private disposers: Array<() => void> = []
  private cancelSettle?: () => void
  private sessionId?: string
  private warmupEndsAt = 0
  private taskDrops = 0

  constructor(
    private readonly callbacks: RendererResponsivenessDetectorCallbacks,
    private readonly environment: DetectorEnvironment = browserEnvironment(),
  ) {}

  start(diagnosticSessionId: string): boolean {
    this.dispose()
    if (!this.environment.supports('longtask')) {
      this.callbacks.stop('api-unavailable')
      return false
    }
    this.sessionId = diagnosticSessionId
    this.warmupEndsAt = this.environment.now() + STARTUP_WARMUP_MS
    try {
      this.disposers = [
        this.environment.observe('longtask', (entries) => this.acceptTasks(entries)),
        this.environment.onVisibilityChange(() => this.visibilityChanged()),
      ]
      if (this.environment.supports('event')) {
        this.disposers.push(
          this.environment.observe('event', (entries) => this.acceptEvents(entries)),
        )
      }
      return true
    } catch {
      this.dispose()
      this.callbacks.stop('api-unavailable')
      return false
    }
  }

  dispose(): void {
    this.cancelSettle?.()
    this.cancelSettle = undefined
    for (const dispose of this.disposers.splice(0).reverse()) dispose()
    this.tasks.length = 0
    this.events.length = 0
    this.taskDrops = 0
    this.sessionId = undefined
  }

  private acceptTasks(entries: readonly TimingEntry[]): void {
    if (!this.sessionId || !this.environment.visible()) return
    for (const entry of entries) {
      if (
        entry.startTime < this.warmupEndsAt ||
        !isTimingEntry(entry) ||
        entry.duration < LONG_TASK_THRESHOLD_MS
      ) {
        continue
      }
      if (boundedPush(this.tasks, entry)) this.taskDrops++
    }
    if (this.tasks.length > 0) this.scheduleSettle()
  }

  private acceptEvents(entries: readonly TimingEntry[]): void {
    if (!this.sessionId || !this.environment.visible()) return
    for (const entry of entries) {
      if (
        entry.startTime < this.warmupEndsAt ||
        !isTimingEntry(entry) ||
        entry.duration < LONG_TASK_THRESHOLD_MS
      ) {
        continue
      }
      boundedPush(this.events, entry)
    }
  }

  private scheduleSettle(): void {
    this.cancelSettle?.()
    this.cancelSettle = this.environment.schedule(() => {
      this.cancelSettle = undefined
      this.flush()
    }, SETTLE_MS)
  }

  private flush(): void {
    const sessionId = this.sessionId
    if (!sessionId || !this.environment.visible()) return
    const tasks = this.tasks
      .splice(0)
      .sort((left, right) => left.startTime - right.startTime)
    const events = this.events.splice(0)
    let dropped = this.taskDrops
    this.taskDrops = 0
    for (const episode of groupEpisodes(tasks)) {
      const first = episode[0]
      const last = episode.at(-1)
      if (!first || !last) continue
      const start = first.startTime
      const end = Math.max(...episode.map((entry) => entry.startTime + entry.duration))
      const correlated = events.some(
        (event) =>
          event.startTime <= end + CORRELATION_MARGIN_MS &&
          event.startTime + event.duration >= start - CORRELATION_MARGIN_MS,
      )
      this.callbacks.observe({
        version: RENDERER_RESPONSIVENESS_VERSION,
        diagnosticSessionId: sessionId,
        observationCount: episode.length,
        dropped,
        timing: timingBucket(Math.max(...episode.map((entry) => entry.duration))),
        classification: correlated ? 'input-paint-delay' : 'unattributed',
        confounder: correlated ? 'none' : 'runtime-or-environment',
      })
      dropped = 0
    }
  }

  private visibilityChanged(): void {
    if (!this.sessionId || this.environment.visible()) return
    this.dispose()
    this.callbacks.stop('backgrounded')
  }
}

export function supportsRendererResponsivenessDiagnostics(): boolean {
  return supportsEntryType('longtask')
}

function browserEnvironment(): DetectorEnvironment {
  return {
    now: () => performance.now(),
    visible: () => document.visibilityState === 'visible',
    supports: supportsEntryType,
    observe: (type, callback) => {
      const observer = new PerformanceObserver((list) =>
        callback(
          list.getEntries().map((entry) => ({
            startTime: entry.startTime,
            duration: entry.duration,
          })),
        ),
      )
      observer.observe(type === 'event' ? { type, buffered: false } : { type })
      return () => observer.disconnect()
    },
    schedule: (callback, delayMs) => {
      const timer = window.setTimeout(callback, delayMs)
      return () => window.clearTimeout(timer)
    },
    onVisibilityChange: (callback) => {
      document.addEventListener('visibilitychange', callback)
      return () => document.removeEventListener('visibilitychange', callback)
    },
  }
}

function supportsEntryType(type: string): boolean {
  if (typeof PerformanceObserver === 'undefined') return false
  const constructor = PerformanceObserver as typeof PerformanceObserver & {
    readonly supportedEntryTypes?: readonly string[]
  }
  return constructor.supportedEntryTypes?.includes(type) ?? false
}

function groupEpisodes(entries: readonly TimingEntry[]): TimingEntry[][] {
  const episodes: TimingEntry[][] = []
  for (const entry of entries) {
    const current = episodes.at(-1)
    const previous = current?.at(-1)
    if (
      !current ||
      !previous ||
      entry.startTime > previous.startTime + previous.duration + EPISODE_GAP_MS
    ) {
      episodes.push([entry])
    } else {
      current.push(entry)
    }
  }
  return episodes
}

function boundedPush(entries: TimingEntry[], entry: TimingEntry): boolean {
  entries.push(entry)
  if (entries.length <= MAX_PENDING_ENTRIES) return false
  entries.shift()
  return true
}

function timingBucket(duration: number): ResponsivenessTiming {
  if (duration >= 500) return '500ms-or-more'
  if (duration >= 200) return '200-499ms'
  return '100-199ms'
}

function isTimingEntry(value: TimingEntry): boolean {
  return (
    Number.isFinite(value.startTime) &&
    value.startTime >= 0 &&
    Number.isFinite(value.duration) &&
    value.duration >= 0
  )
}
