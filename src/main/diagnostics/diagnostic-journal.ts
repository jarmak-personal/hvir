import {
  parseStoredDiagnosticEvent,
  type SerializedDiagnosticEvent,
} from './diagnostic-event'

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
  private accepting = true
  private sinkFailed = false
  private scheduled?: ReturnType<typeof setTimeout>
  private draining?: Promise<void>
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

  private scheduleDrain(): void {
    if (this.scheduled || this.draining) return
    this.scheduled = setTimeout(() => {
      this.scheduled = undefined
      this.startDrain()
    }, 0)
  }

  private startDrain(): void {
    if (this.draining || this.sinkFailed || this.queue.length === 0) return
    this.draining = this.drain()
      .catch(() => this.failStorage())
      .finally(() => {
        this.draining = undefined
        if (this.queue.length > 0 && !this.sinkFailed) this.scheduleDrain()
      })
  }

  private async drain(): Promise<void> {
    if (!this.initialized) await this.initialize()
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

  private async initialize(): Promise<void> {
    const cutoff = this.now() - this.retentionMs
    for (let index = 0; index < this.segmentCount; index++) {
      const metadata = await this.storageCall(this.storage.inspectSegment(index))
      if (!metadata) continue
      if (metadata.size > this.segmentBytes || metadata.mtimeMs < cutoff) {
        await this.storageCall(this.storage.removeSegment(index))
        continue
      }
      const existing = await this.storageCall(
        this.storage.readSegment(index, this.segmentBytes),
      )
      if (existing === undefined) {
        await this.storageCall(this.storage.removeSegment(index))
        continue
      }
      const retained = retainValidEvents(existing, cutoff)
      if (retained.length === 0) {
        await this.storageCall(this.storage.removeSegment(index))
        continue
      }
      if (retained !== existing) {
        await this.storageCall(this.storage.writeSegment(index, retained))
      }
      if (index === 0) this.activeSegment = retained
    }
    this.initialized = true
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

function retainValidEvents(content: string, cutoff: number): string {
  let retained = ''
  for (const line of content.split('\n')) {
    if (!line || Buffer.byteLength(line, 'utf8') > DIAGNOSTIC_EVENT_BYTES) continue
    try {
      const value: unknown = JSON.parse(line)
      const event = parseStoredDiagnosticEvent(value)
      if (!event || Date.parse(event.occurredAt) < cutoff) continue
      retained += `${line}\n`
    } catch {
      // Existing journal material is untrusted and fails closed per ADR-016.
    }
  }
  return retained
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
