import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DiagnosticJournal,
  type DiagnosticJournalStorage,
  type DiagnosticSegmentMetadata,
  type RuntimeDiagnosticEvent,
} from '../src/main/diagnostics/diagnostic-journal'
import { RuntimeDiagnostics } from '../src/main/diagnostics/runtime-diagnostics'

const NOW = Date.parse('2026-07-22T12:00:00.000Z')
const CORRELATION = '019c0000-0000-7000-8000-000000000020'
const SENSITIVE = '/secret/project TOKEN=hvir-private terminal prompt text'

class MemoryStorage implements DiagnosticJournalStorage {
  readonly location = '/local/app-data/runtime-diagnostics.jsonl'
  readonly segments = new Map<number, { content: string; mtimeMs: number }>()

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
    this.segments.delete(index)
    return Promise.resolve()
  }
}

describe('DiagnosticJournal', () => {
  it('serializes only closed fields and separates actionable failure kinds', async () => {
    const storage = new MemoryStorage()
    const journal = new DiagnosticJournal(storage, {
      now: () => NOW,
      correlation: () => CORRELATION,
    })

    journal.record({ kind: 'application-startup-failed' })
    journal.record({
      kind: 'pty-spawn-failed',
      hostKind: 'ssh',
      launchMode: 'resume',
      cwd: SENSITIVE,
      error: SENSITIVE,
    } as RuntimeDiagnosticEvent)
    journal.record({
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
      correlation: () => CORRELATION,
      segmentBytes: 420,
    })

    for (let index = 0; index < 20; index++) {
      journal.record({ kind: 'application-ready' })
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
    const storage = new MemoryStorage()
    let storageStarted = false
    storage.inspectSegment = () => {
      storageStarted = true
      return new Promise(() => undefined)
    }
    const journal = new DiagnosticJournal(storage, {
      now: () => NOW,
      correlation: () => CORRELATION,
      storageTimeoutMs: 10,
    })

    journal.record({ kind: 'application-starting' })
    expect(storageStarted).toBe(false)
    const started = performance.now()
    await journal.dispose(40)

    expect(performance.now() - started).toBeLessThan(150)
    expect(journal.status()).toMatchObject({
      sink: 'failed',
      dropped: { storage: 1 },
    })
  })

  it('bounds its admission queue while a sink has not drained', () => {
    const storage = new MemoryStorage()
    const journal = new DiagnosticJournal(storage, {
      now: () => NOW,
      correlation: () => CORRELATION,
    })

    for (let index = 0; index < 70; index++) {
      journal.record({ kind: 'application-ready' })
    }

    expect(journal.status().dropped.queue).toBe(6)
  })

  it('fails closed when a runtime caller bypasses a diagnostic enum', async () => {
    const storage = new MemoryStorage()
    const journal = new DiagnosticJournal(storage, {
      now: () => NOW,
      correlation: () => CORRELATION,
    })

    journal.record({
      kind: 'pty-spawn-failed',
      hostKind: SENSITIVE,
      launchMode: 'fresh',
    } as unknown as RuntimeDiagnosticEvent)
    await journal.flush()

    expect(storage.segments.size).toBe(0)
    expect(journal.status().dropped.invalid).toBe(1)
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
    const journal = new DiagnosticJournal(storage, {
      now: () => NOW,
      correlation: () => CORRELATION,
    })

    journal.record({ kind: 'application-ready' })
    await vi.waitFor(() => expect(releaseFirstWrite).toBeTypeOf('function'))
    journal.record({ kind: 'application-startup-failed' })
    const disposing = journal.dispose()
    releaseFirstWrite?.()
    await disposing

    const content = storage.segments.get(0)?.content ?? ''
    expect(content).toContain('"kind":"application-ready"')
    expect(content).toContain('"kind":"application-startup-failed"')
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
})

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
