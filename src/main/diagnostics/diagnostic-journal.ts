import { randomUUID } from 'node:crypto'

export const DIAGNOSTIC_SEGMENT_BYTES = 1024 * 1024
export const DIAGNOSTIC_SEGMENT_COUNT = 4
export const DIAGNOSTIC_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
export const DIAGNOSTIC_EVENT_BYTES = 1024

const DIAGNOSTIC_QUEUE_EVENTS = 64
const STORAGE_TIMEOUT_MS = 250
const SATURATING_COUNT = Number.MAX_SAFE_INTEGER

export type DiagnosticHostKind = 'local' | 'ssh'
export type DiagnosticLaunchMode = 'fresh' | 'resume'
export type ApplicationDiagnosticKind =
  | 'application-starting'
  | 'application-ready'
  | 'application-shutdown-starting'
  | 'application-shutdown-completed'
  | 'application-startup-failed'
  | 'application-shutdown-failed'

export type RuntimeDiagnosticEvent =
  | { readonly kind: ApplicationDiagnosticKind }
  | {
      readonly kind: 'pty-spawned' | 'pty-spawn-failed'
      readonly hostKind: DiagnosticHostKind
      readonly launchMode: DiagnosticLaunchMode
    }
  | {
      readonly kind: 'pty-exited'
      readonly hostKind: DiagnosticHostKind
      readonly launchMode: DiagnosticLaunchMode
      readonly exitKind: 'clean' | 'error' | 'signal'
      readonly lifetime: 'under-30s' | 'under-5m' | '5m-or-more'
    }
  | {
      readonly kind: 'terminal-session-registry-load-failed'
      readonly reason: 'read-failed' | 'invalid-json' | 'invalid-schema'
    }
  | { readonly kind: 'terminal-session-registry-persist-failed' }
  | {
      readonly kind: 'host-control-failed'
      readonly operation: 'connect' | 'disconnect'
      readonly hostKind: DiagnosticHostKind
    }

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
    invalid: number
    queue: number
    oversized: number
    storage: number
  }>
}

interface PendingEvent {
  readonly event: RuntimeDiagnosticEvent
  readonly occurredAtMs: number
}

export interface DiagnosticJournalOptions {
  readonly segmentBytes?: number
  readonly segmentCount?: number
  readonly retentionMs?: number
  readonly queueEvents?: number
  readonly storageTimeoutMs?: number
  readonly now?: () => number
  readonly correlation?: () => string
}

/** A droppable, asynchronous JSONL sink for closed main-process diagnostic events. */
export class DiagnosticJournal {
  private readonly segmentBytes: number
  private readonly segmentCount: number
  private readonly retentionMs: number
  private readonly queueEvents: number
  private readonly storageTimeoutMs: number
  private readonly now: () => number
  private readonly correlation: () => string
  private readonly queue: PendingEvent[] = []
  private readonly dropped = { invalid: 0, queue: 0, oversized: 0, storage: 0 }
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
    this.correlation = options.correlation ?? randomUUID
  }

  record(event: RuntimeDiagnosticEvent): void {
    if (!this.accepting || this.sinkFailed) return
    if (this.queue.length >= this.queueEvents) {
      this.incrementDropped('queue')
      return
    }
    this.queue.push({ event, occurredAtMs: this.now() })
    this.scheduleDrain()
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

    for (const item of pending) {
      const line = serializeEvent(item, this.correlation())
      if (line === undefined) {
        this.incrementDropped('invalid')
        this.inFlightEvents--
        continue
      }
      const lineBytes = Buffer.byteLength(line, 'utf8')
      if (lineBytes > DIAGNOSTIC_EVENT_BYTES || lineBytes > this.segmentBytes) {
        this.incrementDropped('oversized')
        this.inFlightEvents--
        continue
      }
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

function serializeEvent(item: PendingEvent, correlation: string): string | undefined {
  const base = {
    version: 1,
    occurredAt: new Date(item.occurredAtMs).toISOString(),
    kind: item.event.kind,
    owner: ownerFor(item.event.kind),
    ownerGeneration: 1,
    severity: severityFor(item.event.kind),
    correlation,
  } as const
  let stored: Record<string, unknown>
  switch (item.event.kind) {
    case 'pty-spawned':
    case 'pty-spawn-failed':
      stored = {
        ...base,
        hostKind: item.event.hostKind,
        launchMode: item.event.launchMode,
      }
      break
    case 'pty-exited':
      stored = {
        ...base,
        hostKind: item.event.hostKind,
        launchMode: item.event.launchMode,
        exitKind: item.event.exitKind,
        lifetime: item.event.lifetime,
      }
      break
    case 'terminal-session-registry-load-failed':
      stored = { ...base, reason: item.event.reason }
      break
    case 'host-control-failed':
      stored = {
        ...base,
        operation: item.event.operation,
        hostKind: item.event.hostKind,
      }
      break
    default:
      stored = base
  }
  return isStoredDiagnosticEvent(stored) ? `${JSON.stringify(stored)}\n` : undefined
}

function ownerFor(kind: RuntimeDiagnosticEvent['kind']): string {
  if (kind.startsWith('application-')) return 'application'
  if (kind.startsWith('pty-')) return 'pty-supervisor'
  if (kind.startsWith('terminal-session-registry-')) {
    return 'terminal-session-registry'
  }
  return 'project-coordinator'
}

function severityFor(kind: RuntimeDiagnosticEvent['kind']): string {
  if (kind.endsWith('-failed')) return 'error'
  if (kind === 'pty-exited') return 'info'
  return 'info'
}

function retainValidEvents(content: string, cutoff: number): string {
  let retained = ''
  for (const line of content.split('\n')) {
    if (!line || Buffer.byteLength(line, 'utf8') > DIAGNOSTIC_EVENT_BYTES) continue
    try {
      const value: unknown = JSON.parse(line)
      if (!isStoredDiagnosticEvent(value)) continue
      if (Date.parse(value.occurredAt) < cutoff) continue
      retained += `${line}\n`
    } catch {
      // Existing journal material is untrusted and fails closed per ADR-016.
    }
  }
  return retained
}

function isStoredDiagnosticEvent(
  value: unknown,
): value is Record<string, unknown> & { occurredAt: string } {
  if (!isRecord(value) || value['version'] !== 1 || value['ownerGeneration'] !== 1) {
    return false
  }
  const kind = value['kind']
  if (
    typeof kind !== 'string' ||
    !DIAGNOSTIC_KINDS.has(kind as RuntimeDiagnosticEvent['kind'])
  ) {
    return false
  }
  if (
    value['owner'] !== ownerFor(kind as RuntimeDiagnosticEvent['kind']) ||
    value['severity'] !== severityFor(kind as RuntimeDiagnosticEvent['kind']) ||
    !isIsoTime(value['occurredAt']) ||
    !isCorrelation(value['correlation'])
  ) {
    return false
  }

  const keys = new Set(Object.keys(value))
  for (const common of COMMON_KEYS) keys.delete(common)
  if (kind === 'pty-spawned' || kind === 'pty-spawn-failed') {
    return exactFields(keys, ['hostKind', 'launchMode']) && isPtyFields(value)
  }
  if (kind === 'pty-exited') {
    return (
      exactFields(keys, ['hostKind', 'launchMode', 'exitKind', 'lifetime']) &&
      isPtyFields(value) &&
      ['clean', 'error', 'signal'].includes(String(value['exitKind'])) &&
      ['under-30s', 'under-5m', '5m-or-more'].includes(String(value['lifetime']))
    )
  }
  if (kind === 'terminal-session-registry-load-failed') {
    return (
      exactFields(keys, ['reason']) &&
      ['read-failed', 'invalid-json', 'invalid-schema'].includes(String(value['reason']))
    )
  }
  if (kind === 'host-control-failed') {
    return (
      exactFields(keys, ['operation', 'hostKind']) &&
      ['connect', 'disconnect'].includes(String(value['operation'])) &&
      isHostKind(value['hostKind'])
    )
  }
  return keys.size === 0
}

const COMMON_KEYS = [
  'version',
  'occurredAt',
  'kind',
  'owner',
  'ownerGeneration',
  'severity',
  'correlation',
] as const

const DIAGNOSTIC_KINDS = new Set<RuntimeDiagnosticEvent['kind']>([
  'application-starting',
  'application-ready',
  'application-shutdown-starting',
  'application-shutdown-completed',
  'application-startup-failed',
  'application-shutdown-failed',
  'pty-spawned',
  'pty-spawn-failed',
  'pty-exited',
  'terminal-session-registry-load-failed',
  'terminal-session-registry-persist-failed',
  'host-control-failed',
])

function exactFields(actual: ReadonlySet<string>, expected: readonly string[]): boolean {
  return actual.size === expected.length && expected.every((key) => actual.has(key))
}

function isPtyFields(value: Record<string, unknown>): boolean {
  return (
    isHostKind(value['hostKind']) &&
    ['fresh', 'resume'].includes(String(value['launchMode']))
  )
}

function isHostKind(value: unknown): value is DiagnosticHostKind {
  return value === 'local' || value === 'ssh'
}

function isIsoTime(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function isCorrelation(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
