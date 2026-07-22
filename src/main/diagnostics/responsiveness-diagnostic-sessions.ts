import { randomUUID } from 'node:crypto'

import {
  RENDERER_RESPONSIVENESS_MAX_AGGREGATES,
  RENDERER_RESPONSIVENESS_MAX_DURATION_MS,
  RENDERER_RESPONSIVENESS_MAX_DROPPED,
  RENDERER_RESPONSIVENESS_MAX_OBSERVATIONS,
  RENDERER_RESPONSIVENESS_VERSION,
  RENDERER_RESPONSIVENESS_WINDOW_MS,
  isResponsivenessObservationBatch,
  type ResponsivenessClassification,
  type ResponsivenessConfounder,
  type ResponsivenessDiagnosticsState,
  type ResponsivenessObservation,
  type ResponsivenessStopReason,
  type ResponsivenessTiming,
} from '../../shared'
import type { RendererOwner } from '../renderer-resource-scopes'
import type { RuntimeDiagnosticEvent } from './diagnostic-event'

interface ResponsivenessEvidencePort {
  record(event: RuntimeDiagnosticEvent): void
  deleteResponsivenessSession(diagnosticSessionId: string): void
}

interface PendingAggregate {
  readonly windowStartedAt: number
  firstObservedAt: number
  lastObservedAt: number
  observationCount: number
  timing: ResponsivenessTiming
  classification: ResponsivenessClassification
  confounder: ResponsivenessConfounder
}

interface SessionRecord {
  readonly owner: RendererOwner
  readonly diagnosticSessionId: string
  readonly startedAt: number
  readonly expiresAt: number
  observationCount: number
  aggregateCount: number
  dropped: number
  reportedDropped: number
  pending?: PendingAggregate
  completed?: {
    readonly stoppedAt: number
    readonly reason: ResponsivenessStopReason
  }
  cancelExpiry?: () => void
}

export interface ResponsivenessDiagnosticSessionsOptions {
  readonly available: boolean
  readonly now?: () => number
  readonly sessionId?: () => string
  readonly schedule?: (callback: () => void, delayMs: number) => () => void
}

/** Main-owned, generation-qualified policy for one bounded opt-in renderer run. */
export class ResponsivenessDiagnosticSessions {
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly deleted = new Set<string>()
  private readonly now: () => number
  private readonly sessionId: () => string
  private readonly schedule: (callback: () => void, delayMs: number) => () => void

  constructor(
    private readonly evidence: ResponsivenessEvidencePort,
    private readonly options: ResponsivenessDiagnosticSessionsOptions,
  ) {
    this.now = options.now ?? Date.now
    this.sessionId = options.sessionId ?? randomUUID
    this.schedule = options.schedule ?? defaultSchedule
  }

  state(owner: RendererOwner): ResponsivenessDiagnosticsState {
    if (!this.options.available) return unavailableState()
    const record = this.sessions.get(ownerKey(owner))
    if (!record) return idleState()
    if (!record.completed && this.now() >= record.expiresAt) {
      this.complete(record, 'timeout')
    }
    return recordState(record)
  }

  start(owner: RendererOwner): ResponsivenessDiagnosticsState {
    if (!this.options.available) return unavailableState()
    this.remove(owner)
    const startedAt = this.now()
    const record: SessionRecord = {
      owner,
      diagnosticSessionId: this.sessionId(),
      startedAt,
      expiresAt: startedAt + RENDERER_RESPONSIVENESS_MAX_DURATION_MS,
      observationCount: 0,
      aggregateCount: 0,
      dropped: 0,
      reportedDropped: 0,
    }
    record.cancelExpiry = this.schedule(
      () => this.complete(record, 'timeout'),
      RENDERER_RESPONSIVENESS_MAX_DURATION_MS,
    )
    this.sessions.set(ownerKey(owner), record)
    return recordState(record)
  }

  observe(owner: RendererOwner, batch: unknown): void {
    if (!this.options.available || !isResponsivenessObservationBatch(batch)) return
    const record = this.sessions.get(ownerKey(owner))
    if (
      !record ||
      record.completed ||
      batch.diagnosticSessionId !== record.diagnosticSessionId
    ) {
      return
    }
    record.dropped = saturatingDropped(record.dropped, batch.dropped.invalid)
    record.dropped = saturatingDropped(record.dropped, batch.dropped.queue)
    record.dropped = saturatingDropped(record.dropped, batch.dropped.rate)
    for (const observation of batch.observations) this.observeOne(record, observation)
  }

  private observeOne(
    record: SessionRecord,
    observation: ResponsivenessObservation,
  ): void {
    const now = this.now()
    record.dropped = saturatingDropped(record.dropped, observation.dropped)
    if (now >= record.expiresAt) {
      this.complete(record, 'timeout')
      return
    }
    const remaining = RENDERER_RESPONSIVENESS_MAX_OBSERVATIONS - record.observationCount
    const accepted = Math.min(remaining, observation.observationCount)
    record.dropped = saturatingDropped(
      record.dropped,
      observation.observationCount - accepted,
    )
    if (accepted === 0) return
    record.observationCount += accepted
    const aggregateObservation = { ...observation, observationCount: accepted }
    if (
      record.pending &&
      now - record.pending.windowStartedAt < RENDERER_RESPONSIVENESS_WINDOW_MS
    ) {
      mergeAggregate(record.pending, aggregateObservation, now)
      return
    }
    this.flush(record, 'window-rollover')
    if (record.aggregateCount >= RENDERER_RESPONSIVENESS_MAX_AGGREGATES) {
      record.dropped = saturatingDropped(record.dropped, accepted)
      return
    }
    record.pending = {
      windowStartedAt: now,
      firstObservedAt: now,
      lastObservedAt: now,
      observationCount: accepted,
      timing: observation.timing,
      classification: observation.classification,
      confounder: observation.confounder,
    }
  }

  stop(
    owner: RendererOwner,
    diagnosticSessionId: string,
    reason: Exclude<ResponsivenessStopReason, 'timeout' | 'renderer-revoked'>,
  ): ResponsivenessDiagnosticsState {
    if (!this.options.available) return unavailableState()
    const record = this.sessions.get(ownerKey(owner))
    if (!record || record.diagnosticSessionId !== diagnosticSessionId) {
      return this.deleted.has(diagnosticSessionId) ? idleState() : this.state(owner)
    }
    this.complete(record, reason)
    return recordState(record)
  }

  delete(
    owner: RendererOwner,
    diagnosticSessionId: string,
  ): ResponsivenessDiagnosticsState {
    if (!this.options.available) return unavailableState()
    const record = this.sessions.get(ownerKey(owner))
    if (record?.diagnosticSessionId === diagnosticSessionId) this.remove(owner)
    this.rememberDeleted(diagnosticSessionId)
    return this.state(owner)
  }

  revoke(owner: RendererOwner): void {
    const record = this.sessions.get(ownerKey(owner))
    if (!record) return
    this.complete(record, 'renderer-revoked')
    this.remove(owner)
  }

  dispose(): void {
    for (const record of [...this.sessions.values()]) this.revoke(record.owner)
    this.deleted.clear()
  }

  private complete(record: SessionRecord, reason: ResponsivenessStopReason): void {
    if (record.completed || this.sessions.get(ownerKey(record.owner)) !== record) return
    this.flush(record, reason)
    record.completed = { stoppedAt: this.now(), reason }
    record.cancelExpiry?.()
    record.cancelExpiry = undefined
  }

  private flush(
    record: SessionRecord,
    resolution: ResponsivenessStopReason | 'window-rollover',
  ): void {
    const pending = record.pending
    if (!pending) return
    record.pending = undefined
    if (record.aggregateCount >= RENDERER_RESPONSIVENESS_MAX_AGGREGATES) {
      record.dropped = saturatingDropped(record.dropped, pending.observationCount)
      return
    }
    this.evidence.record({
      kind: 'renderer-responsiveness-episode',
      ownerGeneration: record.owner.generation,
      sessionId: record.diagnosticSessionId,
      count: pending.observationCount,
      drop: record.dropped - record.reportedDropped,
      timing: pending.timing,
      classification: pending.classification,
      confounder: pending.confounder,
      firstAt: new Date(pending.firstObservedAt).toISOString(),
      lastAt: new Date(pending.lastObservedAt).toISOString(),
      resolution,
    })
    record.reportedDropped = record.dropped
    record.aggregateCount++
  }

  private remove(owner: RendererOwner): void {
    const key = ownerKey(owner)
    const record = this.sessions.get(key)
    if (!record) return
    record.cancelExpiry?.()
    this.evidence.deleteResponsivenessSession(record.diagnosticSessionId)
    this.sessions.delete(key)
    this.rememberDeleted(record.diagnosticSessionId)
  }

  private rememberDeleted(diagnosticSessionId: string): void {
    this.deleted.add(diagnosticSessionId)
    while (this.deleted.size > 16)
      this.deleted.delete(this.deleted.values().next().value!)
  }
}

function mergeAggregate(
  pending: PendingAggregate,
  observation: ResponsivenessObservation,
  now: number,
): void {
  pending.lastObservedAt = now
  pending.observationCount = Math.min(
    RENDERER_RESPONSIVENESS_MAX_OBSERVATIONS,
    pending.observationCount + observation.observationCount,
  )
  if (timingRank(observation.timing) > timingRank(pending.timing)) {
    pending.timing = observation.timing
  }
  if (observation.classification === 'unattributed') {
    pending.classification = 'unattributed'
    pending.confounder = 'runtime-or-environment'
  }
}

function recordState(record: SessionRecord): ResponsivenessDiagnosticsState {
  const common = {
    version: RENDERER_RESPONSIVENESS_VERSION,
    available: true,
    diagnosticSessionId: record.diagnosticSessionId,
    observationCount: record.observationCount,
    aggregateCount: record.aggregateCount + (record.pending ? 1 : 0),
    dropped: record.dropped,
  } as const
  return record.completed
    ? {
        ...common,
        status: 'complete',
        stoppedAt: new Date(record.completed.stoppedAt).toISOString(),
        stopReason: record.completed.reason,
      }
    : {
        ...common,
        status: 'active',
        startedAt: new Date(record.startedAt).toISOString(),
        expiresAt: new Date(record.expiresAt).toISOString(),
      }
}

function unavailableState(): ResponsivenessDiagnosticsState {
  return {
    version: RENDERER_RESPONSIVENESS_VERSION,
    available: false,
    status: 'unavailable',
    reason: 'packaged-build',
  }
}

function idleState(): ResponsivenessDiagnosticsState {
  return { version: RENDERER_RESPONSIVENESS_VERSION, available: true, status: 'idle' }
}

function timingRank(timing: ResponsivenessTiming): number {
  return timing === '500ms-or-more' ? 3 : timing === '200-499ms' ? 2 : 1
}

function ownerKey(owner: RendererOwner): string {
  return `${owner.id}:${owner.generation}`
}

function defaultSchedule(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs)
  timer.unref()
  return () => clearTimeout(timer)
}

function saturatingDropped(current: number, increment: number): number {
  return Math.min(RENDERER_RESPONSIVENESS_MAX_DROPPED, current + increment)
}
