import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DiagnosticJournal,
  type DiagnosticJournalStorage,
  type DiagnosticSegmentMetadata,
} from '../src/main/diagnostics/diagnostic-journal'
import {
  materializeDiagnosticEvent,
  serializeStoredDiagnosticEvent,
  type RuntimeDiagnosticEvent,
} from '../src/main/diagnostics/diagnostic-event'
import { DiagnosticIntake } from '../src/main/diagnostics/diagnostic-intake'
import { RuntimeDiagnostics } from '../src/main/diagnostics/runtime-diagnostics'

const NOW = Date.parse('2026-07-22T12:00:00.000Z')
const CORRELATION = '019c0000-0000-7000-8000-000000000020'
const SENSITIVE = '/secret/project TOKEN=hvir-private terminal prompt text'

class MemoryStorage implements DiagnosticJournalStorage {
  readonly location = '/local/app-data/runtime-diagnostics.jsonl'
  readonly segments = new Map<number, { content: string; mtimeMs: number }>()
  removeFailures = 0

  inspectSegment(index: number): Promise<DiagnosticSegmentMetadata | undefined> {
    const segment = this.segments.get(index)
    return Promise.resolve(
      segment
        ? { size: Buffer.byteLength(segment.content, 'utf8'), mtimeMs: segment.mtimeMs }
        : undefined,
    )
  }

  readSegment(index: number, maxBytes: number): Promise<string | undefined> {
    const content = this.segments.get(index)?.content
    return Promise.resolve(
      content !== undefined && Buffer.byteLength(content, 'utf8') <= maxBytes
        ? content
        : undefined,
    )
  }

  writeSegment(index: number, content: string): Promise<void> {
    this.segments.set(index, { content, mtimeMs: NOW })
    return Promise.resolve()
  }

  removeSegment(index: number): Promise<void> {
    if (this.removeFailures > 0) {
      this.removeFailures--
      return Promise.reject(new Error('storage unavailable'))
    }
    this.segments.delete(index)
    return Promise.resolve()
  }
}

describe('DiagnosticJournal', () => {
  afterEach(() => vi.useRealTimers())

  it('serializes only closed fields and separates actionable failure kinds', async () => {
    const storage = new MemoryStorage()
    const journal = new DiagnosticJournal(storage)
    const intake = new DiagnosticIntake({
      writer: journal,
      now: () => NOW,
      correlation: () => CORRELATION,
    })

    intake.record({ kind: 'application-startup-failed' })
    intake.record({
      kind: 'pty-spawn-failed',
      hostKind: 'ssh',
      launchMode: 'resume',
      cwd: SENSITIVE,
      error: SENSITIVE,
    } as RuntimeDiagnosticEvent)
    intake.record({
      kind: 'terminal-session-registry-load-failed',
      reason: 'invalid-json',
    })
    await journal.flush()

    const content = storage.segments.get(0)?.content ?? ''
    const events = content
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(events.map((event) => event['kind'])).toEqual([
      'application-startup-failed',
      'pty-spawn-failed',
      'terminal-session-registry-load-failed',
    ])
    expect(events[1]).toEqual({
      version: 1,
      occurredAt: '2026-07-22T12:00:00.000Z',
      kind: 'pty-spawn-failed',
      owner: 'pty-supervisor',
      ownerGeneration: 1,
      severity: 'error',
      correlation: CORRELATION,
      hostKind: 'ssh',
      launchMode: 'resume',
    })
    expect(content).not.toContain(SENSITIVE)
    expect(content.split('\n').every((line) => Buffer.byteLength(line) <= 1024)).toBe(
      true,
    )
  })

  it('rotates at the configured bound and removes expired or unknown material', async () => {
    const storage = new MemoryStorage()
    storage.segments.set(2, {
      content: `${storedApplicationEvent('2026-07-01T00:00:00.000Z')}\n`,
      mtimeMs: NOW,
    })
    storage.segments.set(3, {
      content: `${JSON.stringify({ secret: SENSITIVE })}\n`,
      mtimeMs: NOW,
    })
    const journal = new DiagnosticJournal(storage, {
      now: () => NOW,
      segmentBytes: 420,
    })

    for (let index = 0; index < 20; index++) {
      record(journal, { kind: 'application-ready' })
    }
    await journal.flush()

    expect(storage.segments.size).toBe(4)
    for (const { content } of storage.segments.values()) {
      expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(420)
      expect(content).not.toContain(SENSITIVE)
      expect(content).not.toContain('2026-07-01')
    }
  })

  it('drops a slow storage sink without delaying callers or shutdown', async () => {
    vi.useFakeTimers({ now: NOW })
    const storage = new MemoryStorage()
    let storageStarted = false
    storage.inspectSegment = () => {
      storageStarted = true
      return new Promise(() => undefined)
    }
    const journal = new DiagnosticJournal(storage, {
      now: () => NOW,
      storageTimeoutMs: 10,
    })

    record(journal, { kind: 'application-starting' })
    expect(storageStarted).toBe(false)
    let disposalSettled = false
    const disposal = journal.dispose(40).then(() => {
      disposalSettled = true
    })
    expect(storageStarted).toBe(true)
    expect(disposalSettled).toBe(false)

    await vi.advanceTimersByTimeAsync(10)
    await disposal

    expect(disposalSettled).toBe(true)
    expect(journal.status()).toMatchObject({
      sink: 'failed',
      dropped: { storage: 1 },
    })
  })

  it('bounds its admission queue while a sink has not drained', () => {
    const storage = new MemoryStorage()
    const journal = new DiagnosticJournal(storage, { now: () => NOW })

    for (let index = 0; index < 70; index++) {
      record(journal, { kind: 'application-ready' })
    }

    expect(journal.status().dropped.queue).toBe(6)
  })

  it('deletes every segment and starts a fresh journal generation', async () => {
    const storage = new MemoryStorage()
    const journal = new DiagnosticJournal(storage, { now: () => NOW })
    record(journal, { kind: 'application-starting' })
    await journal.flush()
    expect(storage.segments.get(0)?.content).toContain('application-starting')

    await journal.reset()

    expect(storage.segments.size).toBe(0)
    expect(journal.status()).toMatchObject({
      sink: 'available',
      dropped: { queue: 0, storage: 0 },
    })
    record(journal, { kind: 'application-ready' })
    await journal.flush()
    expect(storage.segments.get(0)?.content).toContain('application-ready')
    expect(storage.segments.get(0)?.content).not.toContain('application-starting')
  })

  it('reports failed deletion and permits an idempotent retry', async () => {
    const storage = new MemoryStorage()
    const journal = new DiagnosticJournal(storage, { now: () => NOW })
    record(journal, { kind: 'application-starting' })
    await journal.flush()
    storage.removeFailures = 1

    await expect(journal.reset()).rejects.toThrow('storage unavailable')
    expect(journal.status().sink).toBe('failed')
    await journal.reset()

    expect(storage.segments.size).toBe(0)
    expect(journal.status().sink).toBe('available')
  })

  it('fails closed when a runtime caller bypasses a diagnostic enum', async () => {
    const storage = new MemoryStorage()
    const journal = new DiagnosticJournal(storage)
    const intake = new DiagnosticIntake({
      writer: journal,
      now: () => NOW,
      correlation: () => CORRELATION,
    })

    intake.record({
      kind: 'pty-spawn-failed',
      hostKind: SENSITIVE,
      launchMode: 'fresh',
    } as unknown as RuntimeDiagnosticEvent)
    await journal.flush()

    expect(storage.segments.size).toBe(0)
    expect(intake.snapshot().dropped).toContainEqual({
      source: 'pty-supervisor',
      reason: 'invalid',
      count: 1,
    })
  })

  it('flushes a failure queued behind an active write before disposal', async () => {
    const storage = new MemoryStorage()
    const write = storage.writeSegment.bind(storage)
    let releaseFirstWrite: (() => void) | undefined
    let writes = 0
    storage.writeSegment = async (index, content) => {
      writes++
      if (writes === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstWrite = resolve
        })
      }
      await write(index, content)
    }
    const journal = new DiagnosticJournal(storage, { now: () => NOW })

    record(journal, { kind: 'application-ready' })
    await vi.waitFor(() => expect(releaseFirstWrite).toBeTypeOf('function'))
    record(journal, { kind: 'application-startup-failed' })
    const disposing = journal.dispose()
    releaseFirstWrite?.()
    await disposing

    const content = storage.segments.get(0)?.content ?? ''
    expect(content).toContain('"kind":"application-ready"')
    expect(content).toContain('"kind":"application-startup-failed"')
  })

  it('reads bounded segments chronologically and reports rejected durable material as partial', async () => {
    const storage = new MemoryStorage()
    const older = storedApplicationEvent('2026-07-22T10:00:00.000Z')
    const newer = storedApplicationEvent('2026-07-22T11:00:00.000Z')
    storage.segments.set(2, { content: `${older}\n`, mtimeMs: NOW })
    storage.segments.set(0, {
      content:
        `${JSON.stringify({ version: 99, secret: SENSITIVE })}\n` +
        `${JSON.stringify({ ...JSON.parse(newer), correlation: SENSITIVE })}\n` +
        `${newer}\n{"version":`,
      mtimeMs: NOW,
    })
    const journal = new DiagnosticJournal(storage, { now: () => NOW })

    const evidence = await journal.readReportEvidence()

    expect(evidence.availability).toBe('partial')
    expect(evidence.events.map((event) => event.occurredAt)).toEqual([
      '2026-07-22T10:00:00.000Z',
      '2026-07-22T11:00:00.000Z',
    ])
    expect(JSON.stringify(evidence)).not.toContain(SENSITIVE)
    expect(storage.segments.get(0)?.content).toContain(SENSITIVE)
  })

  it('revokes a durable read already in flight when the journal resets', async () => {
    const storage = new MemoryStorage()
    storage.segments.set(0, {
      content: `${storedApplicationEvent('2026-07-22T11:00:00.000Z')}\n`,
      mtimeMs: NOW,
    })
    const readSegment = storage.readSegment.bind(storage)
    let reads = 0
    let releaseRead!: () => void
    let markReadStarted!: () => void
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve
    })
    const waitForRelease = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    storage.readSegment = async (index, maxBytes) => {
      const content = await readSegment(index, maxBytes)
      reads++
      if (reads === 1) {
        markReadStarted()
        await waitForRelease
      }
      return content
    }
    const journal = new DiagnosticJournal(storage, { now: () => NOW })

    const reading = journal.readReportEvidence()
    await readStarted
    const resetting = journal.reset()
    releaseRead()

    expect(await reading).toEqual({ availability: 'unavailable', events: [] })
    await resetting
    expect(storage.segments.size).toBe(0)
  })
})

describe('RuntimeDiagnostics local storage', () => {
  let directory: string | undefined

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  it('writes local and SSH evidence to one app-local ProjectHost-backed journal', async () => {
    directory = await mkdtemp(join(tmpdir(), 'hvir-diagnostics-'))
    const diagnostics = RuntimeDiagnostics.create(directory, true)

    diagnostics.recordApplication('application-starting')
    diagnostics.recordPty({
      kind: 'pty-spawn-failed',
      hostKind: 'ssh',
      launchMode: 'fresh',
    })
    diagnostics.recordHostControl({ operation: 'connect', hostKind: 'ssh' })
    await diagnostics.dispose()

    const location = join(directory, 'runtime-diagnostics.jsonl')
    const content = await readFile(location, 'utf8')
    expect(diagnostics.status()?.location).toBe(location)
    expect(content).toContain('"kind":"application-starting"')
    expect(content).toContain('"kind":"pty-spawn-failed"')
    expect(content).toContain('"kind":"host-control-failed"')
    expect(content.match(/"hostKind":"ssh"/g)).toHaveLength(2)
  })

  it('exposes the local bound and deletes recent, health, and durable evidence', async () => {
    directory = await mkdtemp(join(tmpdir(), 'hvir-diagnostics-delete-'))
    const diagnostics = RuntimeDiagnostics.create(directory, true)
    diagnostics.recordApplication('application-starting')
    diagnostics.recordWindowHealth({
      kind: 'renderer-unresponsive',
      ownerId: 7,
      ownerGeneration: 2,
      occurrenceId: '019c0000-0000-7000-8000-000000000021',
    })
    await vi.waitFor(async () => {
      expect(
        await readFile(join(directory!, 'runtime-diagnostics.jsonl'), 'utf8'),
      ).toContain('renderer-unresponsive')
    })

    expect(diagnostics.evidenceState()).toMatchObject({
      availability: 'durable',
      recent: { maxEvents: 256, maxBytes: 248 * 1024 },
      journal: {
        location: join(directory, 'runtime-diagnostics.jsonl'),
        maxSegments: 4,
        maxSegmentBytes: 1024 * 1024,
        retentionHours: 168,
      },
    })
    expect(diagnostics.snapshot().events).not.toHaveLength(0)
    expect(diagnostics.healthSnapshot().items).toHaveLength(1)

    expect(await diagnostics.deleteEvidence()).toMatchObject({
      ok: true,
      outcome: 'deleted',
    })
    expect(diagnostics.snapshot()).toEqual({ version: 1, events: [], dropped: [] })
    expect(diagnostics.healthSnapshot().items).toEqual([])
    await expect(
      readFile(join(directory, 'runtime-diagnostics.jsonl'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await diagnostics.deleteEvidence()).toMatchObject({ ok: true })
    await diagnostics.dispose()
  })

  it('prepares a two-lifetime report snapshot from retained local evidence', async () => {
    directory = await mkdtemp(join(tmpdir(), 'hvir-diagnostics-lifetimes-'))
    const lifetimeA = RuntimeDiagnostics.create(directory, true)
    lifetimeA.recordApplication('application-starting')
    lifetimeA.recordWindowHealth({
      kind: 'renderer-unresponsive',
      ownerId: 7,
      ownerGeneration: 1,
      occurrenceId: '019c0000-0000-7000-8000-000000000031',
    })
    lifetimeA.recordWindowHealth({
      kind: 'workbench-health-recovered',
      ownerId: 7,
      ownerGeneration: 1,
      occurrenceId: '019c0000-0000-7000-8000-000000000031',
      outcome: 'reload-selected',
    })
    lifetimeA.recordApplication('application-shutdown-completed')
    await lifetimeA.dispose()

    const lifetimeB = RuntimeDiagnostics.create(directory, true)
    lifetimeB.recordApplication('application-starting')
    lifetimeB.recordApplication('application-ready')
    const prepared = await lifetimeB.prepareReportSnapshot()

    expect(prepared?.diagnostics.scopes).toEqual({
      currentLifetime: { availability: 'included', eventCount: 2 },
      precedingLifetime: { availability: 'included', eventCount: 4 },
    })
    expect(
      prepared?.diagnostics.events.map(({ scope, event }) => [scope, event.kind]),
    ).toEqual([
      ['preceding-lifetime', 'application-starting'],
      ['preceding-lifetime', 'renderer-unresponsive'],
      ['preceding-lifetime', 'workbench-health-recovered'],
      ['preceding-lifetime', 'application-shutdown-completed'],
      ['current-lifetime', 'application-starting'],
      ['current-lifetime', 'application-ready'],
    ])
    await lifetimeB.dispose()
  })
})

function record(journal: DiagnosticJournal, event: RuntimeDiagnosticEvent): void {
  const stored = materializeDiagnosticEvent(event, {
    occurredAtMs: NOW,
    correlation: CORRELATION,
  })
  const line = stored ? serializeStoredDiagnosticEvent(stored) : undefined
  if (!line) throw new Error('Test event must satisfy the diagnostic schema')
  journal.record(line)
}

function storedApplicationEvent(occurredAt: string): string {
  return JSON.stringify({
    version: 1,
    occurredAt,
    kind: 'application-ready',
    owner: 'application',
    ownerGeneration: 1,
    severity: 'info',
    correlation: CORRELATION,
  })
}
