import {
  parseStoredDiagnosticEvent,
  type SerializedDiagnosticEvent,
  type StoredDiagnosticEvent,
} from './diagnostic-event'
import type { DurableDiagnosticEvidence } from './diagnostic-report-evidence'

export type {
  ApplicationDiagnosticKind,
  DiagnosticHostKind,
  DiagnosticLaunchMode,
  RuntimeDiagnosticEvent,
} from './diagnostic-event'

export const DIAGNOSTIC_SEGMENT_BYTES = 1024 * 1024
export const DIAGNOSTIC_SEGMENT_COUNT = 4
export const DIAGNOSTIC_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
export const DIAGNOSTIC_EVENT_BYTES = 1024

const DIAGNOSTIC_QUEUE_EVENTS = 64
const STORAGE_TIMEOUT_MS = 250
const SATURATING_COUNT = Number.MAX_SAFE_INTEGER

export interface DiagnosticSegmentMetadata {
  readonly size: number
  readonly mtimeMs: number
}

export interface DiagnosticJournalStorage {
  readonly location: string
  inspectSegment(index: number): Promise<DiagnosticSegmentMetadata | undefined>
  readSegment(index: number, maxBytes: number): Promise<string | undefined>
  writeSegment(index: number, content: string): Promise<void>
  removeSegment(index: number): Promise<void>
}

export interface DiagnosticJournalStatus {
  readonly location: string
  readonly sink: 'available' | 'failed'
  readonly dropped: Readonly<{
    queue: number
    storage: number
  }>
}

export interface DiagnosticJournalOptions {
  readonly segmentBytes?: number
  readonly segmentCount?: number
  readonly retentionMs?: number
  readonly queueEvents?: number
  readonly storageTimeoutMs?: number
  readonly now?: () => number
}

/** A droppable, asynchronous JSONL sink for closed main-process diagnostic events. */
export class DiagnosticJournal {
  private readonly segmentBytes: number
  private readonly segmentCount: number
  private readonly retentionMs: number
  private readonly queueEvents: number
  private readonly storageTimeoutMs: number
  private readonly now: () => number
  private readonly queue: SerializedDiagnosticEvent[] = []
  private readonly dropped = { queue: 0, storage: 0 }
  private activeSegment = ''
  private initialized = false
  private initializing?: Promise<void>
  private accepting = true
  private sinkFailed = false
  private durablePartial = false
  private generation = 0
  private scheduled?: ReturnType<typeof setTimeout>
  private draining?: Promise<void>
  private resetting?: Promise<void>
  private inFlightEvents = 0

  constructor(
    private readonly storage: DiagnosticJournalStorage,
    options: DiagnosticJournalOptions = {},
  ) {
    this.segmentBytes = options.segmentBytes ?? DIAGNOSTIC_SEGMENT_BYTES
    this.segmentCount = options.segmentCount ?? DIAGNOSTIC_SEGMENT_COUNT
    this.retentionMs = options.retentionMs ?? DIAGNOSTIC_RETENTION_MS
    this.queueEvents = options.queueEvents ?? DIAGNOSTIC_QUEUE_EVENTS
    this.storageTimeoutMs = options.storageTimeoutMs ?? STORAGE_TIMEOUT_MS
    this.now = options.now ?? Date.now
  }

  record(line: SerializedDiagnosticEvent): boolean {
    if (!this.accepting) return false
    if (this.sinkFailed) {
      this.incrementDropped('storage')
      return false
    }
    if (this.queue.length >= this.queueEvents) {
      this.incrementDropped('queue')
      return false
    }
    this.queue.push(line)
    this.scheduleDrain()
    return true
  }

  status(): DiagnosticJournalStatus {
    return {
      location: this.storage.location,
      sink: this.sinkFailed ? 'failed' : 'available',
      dropped: { ...this.dropped },
    }
  }

  /** Best-effort and bounded: a slow diagnostics disk can never hold shutdown. */
  async flush(timeoutMs = this.storageTimeoutMs + 50): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!this.sinkFailed) {
      if (this.scheduled) {
        clearTimeout(this.scheduled)
        this.scheduled = undefined
      }
      this.startDrain()
      const draining = this.draining
      if (!draining) return
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0 || !(await settleWithin(draining, remainingMs))) return
    }
  }

  async dispose(timeoutMs = this.storageTimeoutMs + 50): Promise<void> {
    if (!this.accepting) {
      await this.flush(timeoutMs)
      return
    }
    this.accepting = false
    await this.flush(timeoutMs)
  }

  async reset(): Promise<void> {
    if (this.resetting) return this.resetting
    this.generation++
    if (this.scheduled) {
      clearTimeout(this.scheduled)
      this.scheduled = undefined
    }
    this.queue.length = 0
    const draining = this.draining
    const initializing = this.initializing
    const operation = this.resetAfterDrain(draining, initializing).catch(
      (error: unknown) => {
        this.failStorage()
        throw error
      },
    )
    this.resetting = operation.finally(() => {
      this.resetting = undefined
      if (this.queue.length > 0 && !this.sinkFailed) this.scheduleDrain()
    })
    return this.resetting
  }

  async readReportEvidence(): Promise<DurableDiagnosticEvidence> {
    const generation = this.generation
    if (this.sinkFailed) return unavailableEvidence()
    try {
      const segments = new Map<number, string>()
      const cutoff = this.now() - this.retentionMs
      let partial = this.durablePartial
      for (let index = 0; index < this.segmentCount; index++) {
        const metadata = await this.storageCall(this.storage.inspectSegment(index))
        if (!metadata || metadata.mtimeMs < cutoff) continue
        if (metadata.size > this.segmentBytes) {
          partial = true
          continue
        }
        const content = await this.storageCall(
          this.storage.readSegment(index, this.segmentBytes),
        )
        if (content === undefined) partial = true
        else segments.set(index, content)
      }
      partial ||= this.durablePartial
      if (generation !== this.generation) return unavailableEvidence()
      if (segments.size === 0) {
        return {
          availability: partial ? 'partial' : 'available',
          events: [],
        }
      }
      const highest = Math.max(...segments.keys())
      for (let index = 0; index <= highest; index++) {
        if (!segments.has(index)) partial = true
      }
      const events: StoredDiagnosticEvent[] = []
      for (let index = highest; index >= 0; index--) {
        const content = segments.get(index)
        if (content === undefined) continue
        const parsed = retainValidEvents(content, Number.NEGATIVE_INFINITY)
        events.push(...parsed.events)
        partial ||= parsed.rejected
      }
      events.sort((left, right) => {
        return Date.parse(left.occurredAt) - Date.parse(right.occurredAt)
      })
      return {
        availability: partial ? 'partial' : 'available',
        events,
      }
    } catch {
      return unavailableEvidence()
    }
  }

  private scheduleDrain(): void {
    if (this.scheduled || this.draining || this.resetting) return
    this.scheduled = setTimeout(() => {
      this.scheduled = undefined
      this.startDrain()
    }, 0)
  }

  private startDrain(): void {
    if (this.draining || this.resetting || this.sinkFailed || this.queue.length === 0)
      return
    this.draining = this.drain()
      .catch(() => this.failStorage())
      .finally(() => {
        this.draining = undefined
        if (this.queue.length > 0 && !this.sinkFailed) this.scheduleDrain()
      })
  }

  private async drain(): Promise<void> {
    await this.ensureInitialized()
    const pending = this.queue.splice(0)
    this.inFlightEvents = pending.length
    let changed = false

    for (const line of pending) {
      const lineBytes = Buffer.byteLength(line, 'utf8')
      if (Buffer.byteLength(this.activeSegment, 'utf8') + lineBytes > this.segmentBytes) {
        await this.rotate()
      }
      this.activeSegment += line
      changed = true
      this.inFlightEvents--
    }

    if (changed) await this.storageCall(this.storage.writeSegment(0, this.activeSegment))
  }

  private ensureInitialized(): Promise<void> {
    if (this.initialized) return Promise.resolve()
    if (!this.initializing) {
      this.initializing = this.initialize()
        .then(() => {
          this.initialized = true
        })
        .finally(() => {
          this.initializing = undefined
        })
    }
    return this.initializing
  }

  private async initialize(): Promise<void> {
    const cutoff = this.now() - this.retentionMs
    for (let index = 0; index < this.segmentCount; index++) {
      const metadata = await this.storageCall(this.storage.inspectSegment(index))
      if (!metadata) continue
      if (metadata.size > this.segmentBytes || metadata.mtimeMs < cutoff) {
        if (metadata.size > this.segmentBytes) this.durablePartial = true
        await this.storageCall(this.storage.removeSegment(index))
        continue
      }
      const existing = await this.storageCall(
        this.storage.readSegment(index, this.segmentBytes),
      )
      if (existing === undefined) {
        this.durablePartial = true
        await this.storageCall(this.storage.removeSegment(index))
        continue
      }
      const retained = retainValidEvents(existing, cutoff)
      this.durablePartial ||= retained.rejected
      if (retained.content.length === 0) {
        await this.storageCall(this.storage.removeSegment(index))
        continue
      }
      if (retained.content !== existing) {
        await this.storageCall(this.storage.writeSegment(index, retained.content))
      }
      if (index === 0) this.activeSegment = retained.content
    }
  }

  private async rotate(): Promise<void> {
    for (let index = this.segmentCount - 2; index >= 0; index--) {
      const destination = index + 1
      const source =
        index === 0
          ? this.activeSegment
          : await this.storageCall(this.storage.readSegment(index, this.segmentBytes))
      if (source) {
        await this.storageCall(this.storage.writeSegment(destination, source))
      } else {
        await this.storageCall(this.storage.removeSegment(destination))
      }
    }
    this.activeSegment = ''
  }

  private async resetAfterDrain(
    draining: Promise<void> | undefined,
    initializing: Promise<void> | undefined,
  ): Promise<void> {
    await Promise.all([draining, initializing])
    for (let index = 0; index < this.segmentCount; index++) {
      await this.storageCall(this.storage.removeSegment(index))
    }
    this.activeSegment = ''
    this.initialized = true
    this.durablePartial = false
    this.sinkFailed = false
    this.dropped.queue = 0
    this.dropped.storage = 0
  }

  private async storageCall<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Diagnostics storage timed out')),
            this.storageTimeoutMs,
          )
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private failStorage(): void {
    if (this.sinkFailed) return
    this.sinkFailed = true
    this.dropped.storage = saturatingAdd(
      this.dropped.storage,
      this.inFlightEvents + this.queue.length,
    )
    this.inFlightEvents = 0
    this.queue.length = 0
  }

  private incrementDropped(reason: keyof typeof this.dropped): void {
    this.dropped[reason] = saturatingAdd(this.dropped[reason], 1)
  }
}

function retainValidEvents(
  content: string,
  cutoff: number,
): {
  readonly content: string
  readonly events: readonly StoredDiagnosticEvent[]
  readonly rejected: boolean
} {
  let retained = ''
  const events: StoredDiagnosticEvent[] = []
  let rejected = false
  const lines = content.split('\n')
  if (content.endsWith('\n')) lines.pop()
  else if (lines.length > 0) {
    lines.pop()
    rejected = content.length > 0
  }
  for (const line of lines) {
    if (!line || Buffer.byteLength(line, 'utf8') > DIAGNOSTIC_EVENT_BYTES) {
      rejected = true
      continue
    }
    try {
      const value: unknown = JSON.parse(line)
      const event = parseStoredDiagnosticEvent(value)
      if (!event) {
        rejected = true
        continue
      }
      if (Date.parse(event.occurredAt) < cutoff) continue
      retained += `${line}\n`
      events.push(event)
    } catch {
      // Existing journal material is untrusted and fails closed per ADR-016.
      rejected = true
    }
  }
  return { content: retained, events, rejected }
}

function unavailableEvidence(): DurableDiagnosticEvidence {
  return { availability: 'unavailable', events: [] }
}

function saturatingAdd(current: number, increment: number): number {
  return Math.min(SATURATING_COUNT, current + increment)
}

async function settleWithin(
  operation: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
