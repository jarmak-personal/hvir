import { randomUUID } from 'node:crypto'

import {
  MAX_RENDERER_DIAGNOSTIC_BATCH_EVENTS,
  RENDERER_DIAGNOSTIC_VERSION,
  isDiagnosticOpaqueId,
  type RenderContainmentDiagnosticBatch,
  type RendererDiagnosticDroppedCounts,
  type RendererDiagnosticSession,
} from '../../shared'
import type { RendererOwner } from '../renderer-resource-scopes'
import {
  DIAGNOSTIC_EVENT_BYTES,
  type DiagnosticJournal,
  type DiagnosticJournalStatus,
} from './diagnostic-journal'
import {
  diagnosticSource,
  materializeDiagnosticEvent,
  serializeStoredDiagnosticEvent,
  type DiagnosticEventContext,
  type DiagnosticSource,
  type RuntimeDiagnosticEvent,
  type StoredDiagnosticEvent,
} from './diagnostic-event'

export const MAX_RECENT_DIAGNOSTIC_EVENTS = 256
export const MAX_RECENT_DIAGNOSTIC_BYTES = 248 * 1024
const SOURCE_RATE_PER_SECOND = 4
const SOURCE_RATE_BURST = 16
const SATURATING_COUNT = Number.MAX_SAFE_INTEGER

export type DiagnosticDropReason =
  | 'invalid'
  | 'rate'
  | 'recent-capacity'
  | 'renderer-session'
  | 'renderer-invalid'
  | 'renderer-queue'
  | 'renderer-rate'
  | 'renderer-unavailable'
  | 'writer-queue'
  | 'writer-storage'

export interface DiagnosticDroppedCount {
  readonly source: DiagnosticSource | 'diagnostic-writer'
  readonly reason: DiagnosticDropReason
  readonly count: number
}

export interface DiagnosticRecentSnapshot {
  readonly version: 1
  readonly events: readonly StoredDiagnosticEvent[]
  readonly dropped: readonly DiagnosticDroppedCount[]
}

interface RecentEvent {
  readonly event: StoredDiagnosticEvent
  readonly bytes: number
  readonly source: DiagnosticSource
}

interface RateState {
  tokens: number
  refilledAt: number
}

export interface DiagnosticIntakeOptions {
  readonly writer?: Pick<DiagnosticJournal, 'record' | 'status'>
  readonly now?: () => number
  readonly correlation?: () => string
  readonly onAccepted?: (event: StoredDiagnosticEvent) => void
}

/** Main-owned admission policy shared by durable and recent diagnostic evidence. */
export class DiagnosticIntake {
  private readonly now: () => number
  private readonly correlation: () => string
  private readonly recent: RecentEvent[] = []
  private readonly dropped = new Map<string, DiagnosticDroppedCount>()
  private readonly rates = new Map<DiagnosticSource, RateState>()
  private readonly rendererSessions = new Map<string, RendererDiagnosticSession>()
  private recentBytes = 0

  constructor(private readonly options: DiagnosticIntakeOptions = {}) {
    this.now = options.now ?? Date.now
    this.correlation = options.correlation ?? randomUUID
  }

  record(event: RuntimeDiagnosticEvent): StoredDiagnosticEvent | undefined {
    return this.admit(event, true)
  }

  recordTransient(event: RuntimeDiagnosticEvent): void {
    this.admit(event, false)
  }

  private admit(
    event: RuntimeDiagnosticEvent,
    persist: boolean,
  ): StoredDiagnosticEvent | undefined {
    const context: DiagnosticEventContext = {
      occurredAtMs: this.now(),
      correlation: this.correlation(),
    }
    const stored = materializeDiagnosticEvent(event, context)
    const source = diagnosticSource(event.kind)
    if (!stored) {
      this.incrementDropped(source, 'invalid')
      return undefined
    }
    if (!this.takeRateToken(source, context.occurredAtMs)) {
      this.incrementDropped(source, 'rate')
      return undefined
    }
    const line = serializeStoredDiagnosticEvent(stored)
    if (!line || Buffer.byteLength(line, 'utf8') > DIAGNOSTIC_EVENT_BYTES) {
      this.incrementDropped(source, 'invalid')
      return undefined
    }
    if (persist) this.options.writer?.record(line)
    this.retain({
      event: stored,
      bytes: Buffer.byteLength(line, 'utf8'),
      source,
    })
    try {
      this.options.onAccepted?.(stored)
    } catch {
      // Diagnostic consumers are droppable observers and never own feature behavior.
    }
    return stored
  }

  startRenderer(owner: RendererOwner): RendererDiagnosticSession {
    const session = {
      version: RENDERER_DIAGNOSTIC_VERSION,
      ownerGeneration: owner.generation,
      sessionId: this.correlation(),
    } as const
    this.rendererSessions.set(rendererKey(owner), session)
    return session
  }

  revokeRenderer(owner: RendererOwner): void {
    this.rendererSessions.delete(rendererKey(owner))
  }

  recordRenderContainment(
    owner: RendererOwner,
    batch: RenderContainmentDiagnosticBatch,
  ): void {
    if (!isRenderContainmentBatch(batch)) {
      this.incrementDropped('renderer-error-boundary', 'renderer-invalid')
      return
    }
    const session = this.rendererSessions.get(rendererKey(owner))
    if (
      !session ||
      batch.session.ownerGeneration !== owner.generation ||
      batch.session.sessionId !== session.sessionId
    ) {
      this.incrementDropped('renderer-error-boundary', 'renderer-session')
      return
    }
    this.recordRendererDrops(batch.dropped)
    for (const event of batch.events) {
      this.record({
        kind: 'react-render-contained',
        ownerId: owner.id,
        ownerGeneration: owner.generation,
        occurrenceId: event.occurrenceId,
      })
    }
  }

  snapshot(): DiagnosticRecentSnapshot {
    return {
      version: 1,
      events: this.recent.map(({ event }) => event),
      dropped: [...this.dropped.values(), ...writerDropped(this.options.writer?.status())]
        .filter(({ count }) => count > 0)
        .sort((left, right) =>
          `${left.source}:${left.reason}`.localeCompare(
            `${right.source}:${right.reason}`,
          ),
        ),
    }
  }

  clear(): void {
    this.recent.length = 0
    this.recentBytes = 0
    this.dropped.clear()
    this.rates.clear()
  }

  deleteResponsivenessSession(diagnosticSessionId: string): void {
    for (let index = this.recent.length - 1; index >= 0; index--) {
      const item = this.recent[index]
      if (item?.event['sessionId'] !== diagnosticSessionId) continue
      this.recent.splice(index, 1)
      this.recentBytes -= item.bytes
    }
  }

  private retain(recent: RecentEvent): void {
    this.recent.push(recent)
    this.recentBytes += recent.bytes
    while (
      this.recent.length > MAX_RECENT_DIAGNOSTIC_EVENTS ||
      this.recentBytes > MAX_RECENT_DIAGNOSTIC_BYTES
    ) {
      const removed = this.recent.shift()
      if (!removed) break
      this.recentBytes -= removed.bytes
      this.incrementDropped(removed.source, 'recent-capacity')
    }
  }

  private takeRateToken(source: DiagnosticSource, now: number): boolean {
    const state = this.rates.get(source) ?? {
      tokens: SOURCE_RATE_BURST,
      refilledAt: now,
    }
    const elapsedMs = Math.max(0, now - state.refilledAt)
    state.tokens = Math.min(
      SOURCE_RATE_BURST,
      state.tokens + (elapsedMs / 1000) * SOURCE_RATE_PER_SECOND,
    )
    state.refilledAt = now
    this.rates.set(source, state)
    if (state.tokens < 1) return false
    state.tokens--
    return true
  }

  private recordRendererDrops(dropped: RendererDiagnosticDroppedCounts): void {
    const mappings = [
      ['invalid', 'renderer-invalid'],
      ['queue', 'renderer-queue'],
      ['rate', 'renderer-rate'],
      ['unavailable', 'renderer-unavailable'],
    ] as const
    for (const [field, reason] of mappings) {
      this.incrementDropped('renderer-error-boundary', reason, dropped[field])
    }
  }

  private incrementDropped(
    source: DiagnosticDroppedCount['source'],
    reason: DiagnosticDropReason,
    increment = 1,
  ): void {
    if (increment <= 0) return
    const key = `${source}:${reason}`
    const existing = this.dropped.get(key)
    this.dropped.set(key, {
      source,
      reason,
      count: saturatingAdd(existing?.count ?? 0, increment),
    })
  }
}

function rendererKey(owner: RendererOwner): string {
  return `${owner.id}:${owner.generation}`
}

function isRenderContainmentBatch(
  value: unknown,
): value is RenderContainmentDiagnosticBatch {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['version', 'session', 'events', 'dropped'])
  ) {
    return false
  }
  const session = value['session']
  const events = value['events']
  const dropped = value['dropped']
  return (
    value['version'] === RENDERER_DIAGNOSTIC_VERSION &&
    isRecord(session) &&
    exactKeys(session, ['version', 'ownerGeneration', 'sessionId']) &&
    session['version'] === RENDERER_DIAGNOSTIC_VERSION &&
    Number.isSafeInteger(session['ownerGeneration']) &&
    Number(session['ownerGeneration']) > 0 &&
    isDiagnosticOpaqueId(session['sessionId']) &&
    Array.isArray(events) &&
    events.length <= MAX_RENDERER_DIAGNOSTIC_BATCH_EVENTS &&
    events.every(
      (event: unknown) =>
        isRecord(event) &&
        exactKeys(event, ['version', 'occurrenceId']) &&
        event['version'] === RENDERER_DIAGNOSTIC_VERSION &&
        isDiagnosticOpaqueId(event['occurrenceId']),
    ) &&
    isRecord(dropped) &&
    exactKeys(dropped, ['invalid', 'queue', 'rate', 'unavailable']) &&
    Object.values(dropped).every((count) => isSafeCount(count))
  )
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => keys.includes(key))
}

function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function writerDropped(
  status: DiagnosticJournalStatus | undefined,
): DiagnosticDroppedCount[] {
  if (!status) return []
  return (
    Object.entries(status.dropped) as Array<
      [keyof DiagnosticJournalStatus['dropped'], number]
    >
  ).map(([reason, count]) => ({
    source: 'diagnostic-writer',
    reason: `writer-${reason}` as DiagnosticDropReason,
    count,
  }))
}

function saturatingAdd(current: number, increment: number): number {
  return Math.min(SATURATING_COUNT, current + increment)
}
