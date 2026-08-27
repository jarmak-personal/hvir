import {
  MAX_SESSIONS_USAGE_ROWS,
  SESSIONS_PROJECTION_VERSION,
  type HvirApi,
  type SessionsProjectionSnapshot,
  type SessionsProjectionRow,
  type SessionsTerminalHandle,
  type SessionsUsageChange,
  type SessionsUsageDemandRequest,
  type SessionsUsageFact,
  type SessionsUsageSnapshot,
} from '../../../shared'
import {
  SESSIONS_USAGE_SAMPLE_CADENCE_MS,
  appendSessionsUsageSample,
  appendSessionsUsageStateBoundary,
  rankSessionsUsage,
  type SessionsUsageMode,
  type SessionsUsageHistory,
  type SessionsUsageRankedRow,
  type SessionsUsageWindow,
} from './sessions-usage-model'

export interface SessionsUsageMainPort {
  observe(request: SessionsUsageDemandRequest): Promise<SessionsUsageSnapshot>
  snapshot(demandGeneration: number): Promise<SessionsUsageSnapshot>
  release(demandGeneration: number): Promise<void>
  subscribe(listener: (change: SessionsUsageChange) => void): () => void
}

export interface SessionsUsageCoordinatorSnapshot {
  readonly status: 'inactive' | 'pending' | 'available' | 'unavailable'
  readonly revision: number
  readonly sampledAt: number
  readonly ranking: readonly SessionsUsageRankedRow[]
}

interface SessionsUsageClock {
  now(): number
  setTimeout(callback: () => void, milliseconds: number): number
  clearTimeout(timer: number): void
}

const EMPTY_FACTS = new Map<SessionsTerminalHandle, SessionsUsageFact>()
const EMPTY_HISTORIES = new Map<SessionsTerminalHandle, SessionsUsageHistory>()
const INACTIVE: SessionsUsageCoordinatorSnapshot = {
  status: 'inactive',
  revision: 0,
  sampledAt: 0,
  ranking: [],
}

/** Owns the visible Usage demand, bounded samples, cadence, and late-result fencing. */
export class SessionsUsageCoordinator {
  private readonly listeners = new Set<() => void>()
  private current = INACTIVE
  private facts = EMPTY_FACTS
  private histories = EMPTY_HISTORIES
  private demandGeneration = 0
  private revision = 0
  private unsubscribe?: () => void
  private timer?: number
  private inFlight = false
  private refreshPending = false
  private samplePending = false
  private observed = false
  private active = false
  private disposed = false
  private presentation?: {
    readonly rows: readonly SessionsProjectionRow[]
    readonly mode: SessionsUsageMode
    readonly windowMs: SessionsUsageWindow
  }
  private observeRequest?: SessionsUsageDemandRequest

  constructor(
    private readonly main: SessionsUsageMainPort,
    private readonly clock: SessionsUsageClock = browserClock(),
  ) {}

  snapshot = (): SessionsUsageCoordinatorSnapshot => this.current

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  acquire(projection: SessionsProjectionSnapshot): () => void {
    if (this.disposed) throw new Error('Sessions usage coordinator is disposed')
    if (this.active) throw new Error('Sessions usage demand is already active')
    if (projection.status !== 'available') return () => undefined
    this.active = true
    const demandGeneration = ++this.demandGeneration
    this.facts = EMPTY_FACTS
    this.histories = EMPTY_HISTORIES
    this.publish('pending', 0)
    this.unsubscribe = this.main.subscribe((change) => {
      if (
        this.isCurrent(demandGeneration) &&
        change.demandGeneration === demandGeneration
      ) {
        this.requestSnapshot(demandGeneration, false)
      }
    })
    const request: SessionsUsageDemandRequest = {
      demandGeneration,
      projectionDemandGeneration: projection.demandGeneration,
      sourceRevision: projection.sourceRevision,
      targets: projection.rows.flatMap((row) =>
        row.livePty && row.usage.status !== 'unsupported'
          ? [{ handle: row.handle, livePty: row.livePty }]
          : [],
      ),
    }
    this.observeRequest = request
    this.requestObservation(demandGeneration, request)
    let released = false
    return () => {
      if (released) return
      released = true
      this.stop(demandGeneration)
    }
  }

  configure(
    rows: readonly SessionsProjectionRow[],
    mode: SessionsUsageMode,
    windowMs: SessionsUsageWindow,
  ): void {
    this.presentation = { rows, mode, windowMs }
    if (this.current.status !== 'inactive') {
      this.publish(this.current.status, this.current.sampledAt)
    }
  }

  dispose(): void {
    if (this.disposed) return
    if (this.active) this.stop(this.demandGeneration)
    this.disposed = true
    this.listeners.clear()
  }

  private requestObservation(
    demandGeneration: number,
    request: SessionsUsageDemandRequest,
  ): void {
    if (!this.isCurrent(demandGeneration) || this.inFlight) return
    this.inFlight = true
    void this.main.observe(request).then(
      (snapshot) => {
        if (!this.isCurrent(demandGeneration)) return
        this.inFlight = false
        if (!this.acceptSnapshot(demandGeneration, snapshot, true)) {
          this.publish('unavailable', this.clock.now())
        } else {
          this.observed = true
        }
        this.schedule(demandGeneration)
        this.drainPending(demandGeneration)
      },
      () => {
        if (!this.isCurrent(demandGeneration)) return
        this.inFlight = false
        this.publish('unavailable', this.clock.now())
        this.schedule(demandGeneration)
        this.drainPending(demandGeneration)
      },
    )
  }

  private requestSnapshot(demandGeneration: number, sample: boolean): void {
    if (!this.isCurrent(demandGeneration)) return
    if (this.inFlight) {
      this.refreshPending = true
      this.samplePending ||= sample
      return
    }
    this.inFlight = true
    void this.main.snapshot(demandGeneration).then(
      (snapshot) => {
        if (!this.isCurrent(demandGeneration)) return
        this.inFlight = false
        if (!this.acceptSnapshot(demandGeneration, snapshot, sample)) {
          this.publish('unavailable', this.clock.now())
          return
        }
        this.drainPending(demandGeneration)
      },
      () => {
        if (!this.isCurrent(demandGeneration)) return
        this.inFlight = false
        this.publish('unavailable', this.clock.now())
      },
    )
  }

  private acceptSnapshot(
    demandGeneration: number,
    snapshot: SessionsUsageSnapshot,
    sample: boolean,
  ): boolean {
    if (
      !this.isCurrent(demandGeneration) ||
      snapshot.version !== SESSIONS_PROJECTION_VERSION ||
      snapshot.demandGeneration !== demandGeneration ||
      !Number.isSafeInteger(snapshot.sampledAt) ||
      snapshot.sampledAt < 0 ||
      snapshot.rows.length > MAX_SESSIONS_USAGE_ROWS
    ) {
      return false
    }
    const handles = new Set(snapshot.rows.map((row) => row.handle))
    if (handles.size !== snapshot.rows.length) return false
    const facts = new Map(snapshot.rows.map((row) => [row.handle, row.usage]))
    const histories = new Map(
      [...this.histories].filter(([handle]) => handles.has(handle)),
    )
    for (const row of snapshot.rows) {
      const usageSample = { sampledAt: snapshot.sampledAt, usage: row.usage }
      const history = sample
        ? appendSessionsUsageSample(histories.get(row.handle), usageSample)
        : appendSessionsUsageStateBoundary(histories.get(row.handle), usageSample)
      if (history) histories.set(row.handle, history)
    }
    this.facts = facts
    this.histories = histories
    this.publish('available', snapshot.sampledAt)
    return true
  }

  private schedule(demandGeneration: number): void {
    if (!this.isCurrent(demandGeneration) || this.timer !== undefined) return
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined
      if (!this.isCurrent(demandGeneration)) return
      if (this.observed) this.requestSnapshot(demandGeneration, true)
      else if (this.observeRequest) {
        this.requestObservation(demandGeneration, this.observeRequest)
      }
      this.schedule(demandGeneration)
    }, SESSIONS_USAGE_SAMPLE_CADENCE_MS)
  }

  private drainPending(demandGeneration: number): void {
    if (!this.refreshPending || !this.isCurrent(demandGeneration)) return
    const sample = this.samplePending
    this.refreshPending = false
    this.samplePending = false
    this.requestSnapshot(demandGeneration, sample)
  }

  private stop(demandGeneration: number): void {
    if (!this.isCurrent(demandGeneration)) return
    this.active = false
    this.demandGeneration += 1
    this.unsubscribe?.()
    this.unsubscribe = undefined
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer)
    this.timer = undefined
    this.inFlight = false
    this.refreshPending = false
    this.samplePending = false
    this.observed = false
    this.observeRequest = undefined
    this.facts = EMPTY_FACTS
    this.histories = EMPTY_HISTORIES
    this.current = INACTIVE
    void this.main.release(demandGeneration).catch(() => undefined)
    this.notify()
  }

  private publish(
    status: SessionsUsageCoordinatorSnapshot['status'],
    sampledAt: number,
  ): void {
    this.revision += 1
    this.current = {
      status,
      revision: this.revision,
      sampledAt,
      ranking: this.presentation
        ? rankSessionsUsage(
            this.presentation.rows,
            this.facts,
            this.histories,
            this.presentation.mode,
            this.presentation.windowMs,
            sampledAt || this.clock.now(),
          )
        : [],
    }
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  private isCurrent(demandGeneration: number): boolean {
    return !this.disposed && this.active && this.demandGeneration === demandGeneration
  }
}

export function createSessionsUsageMainPort(
  api: Pick<HvirApi, 'invoke' | 'on'>,
): SessionsUsageMainPort {
  return {
    observe: (request) => api.invoke('sessions:usage-observe', request),
    snapshot: (demandGeneration) =>
      api.invoke('sessions:usage-snapshot', { demandGeneration }),
    release: (demandGeneration) =>
      api.invoke('sessions:usage-release', { demandGeneration }),
    subscribe: (listener) => api.on('sessions:usage-changed', listener),
  }
}

function browserClock(): SessionsUsageClock {
  return {
    now: () => Date.now(),
    setTimeout: (callback, milliseconds) => window.setTimeout(callback, milliseconds),
    clearTimeout: (timer) => window.clearTimeout(timer),
  }
}
