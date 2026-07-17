import { appendFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  buildTelemetryHubScript,
  HarnessTelemetryHub,
  type HarnessTelemetrySubscription,
} from '../src/main/harness/harness-telemetry-hub'
import {
  asHarnessProviderId,
  contextHarnessSnapshot,
  type HarnessTelemetry,
} from '../src/shared'
import type { ExecStreamHandle, ProjectHost } from '../src/main/project-host'
import { LocalHost } from '../src/main/project-host'
import { LOCAL_HOST_ID } from '../src/shared'

interface FakeStream {
  readonly handle: ExecStreamHandle
  readonly writes: string[]
  readonly end: ReturnType<typeof vi.fn>
  stdout(value: string): void
  fail(error: Error): void
}

describe('HarnessTelemetryHub', () => {
  it('coalesces 12 subscriptions into one versioned adapter stream', async () => {
    const stream = fakeStream()
    const execStream = vi.fn<ProjectHost['execStream']>(() => stream.handle)
    const hub = telemetryHub(execStream)
    const stops = Array.from({ length: 12 }, (_, index) =>
      hub.subscribe(subscription(index)),
    )

    await vi.waitFor(() => expect(stream.writes).toHaveLength(13))

    expect(execStream).toHaveBeenCalledOnce()
    expect(stream.writes[0]).toBe('R\t1\t12\n')
    expect(stream.writes.slice(1)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`\t${uuid(0)}\t${uuid(0)}\t`),
        expect.stringContaining(`\t${uuid(11)}\t${uuid(11)}\t`),
      ]),
    )

    for (const stop of stops) void stop()
    expect(stream.end).toHaveBeenCalledOnce()
  })

  it('routes split/coalesced frames and isolates stale or cross-session records', async () => {
    const stream = fakeStream()
    const execStream = vi.fn<ProjectHost['execStream']>(() => stream.handle)
    const hub = telemetryHub(execStream)
    const firstEmit = vi.fn<(value: HarnessTelemetry | undefined) => void>()
    const secondEmit = vi.fn<(value: HarnessTelemetry | undefined) => void>()
    const first = subscription(1, firstEmit)
    const second = subscription(2, secondEmit)
    const stopFirst = hub.subscribe(first)
    const stopSecond = hub.subscribe(second)
    await vi.waitFor(() => expect(stream.writes).toHaveLength(3))
    const epoch = execStream.mock.calls[0]?.[1].at(-1)
    if (!epoch) throw new Error('Expected telemetry hub epoch argument')
    const generation = stream.writes[0]?.split('\t')[1]
    const valid = frame(epoch, generation, first.subscriptionId, first.sessionId, 41)
    const stale = frame(epoch, '0', first.subscriptionId, first.sessionId, 1)
    const crossed = frame(epoch, generation, first.subscriptionId, second.sessionId, 2)
    const malformed = `E\t${epoch}\t${generation}\t${second.subscriptionId}\t${second.sessionId}\t%%%\n`

    stream.stdout(valid.slice(0, 17))
    stream.stdout(`${valid.slice(17)}${stale}${crossed}${malformed}`)

    expect(firstEmit).toHaveBeenCalledOnce()
    expectSnapshot(firstEmit.mock.calls.at(-1)?.[0], 41, first.sessionId)
    expect(secondEmit).not.toHaveBeenCalled()
    void stopFirst()
    void stopSecond()
  })

  it('reconciles unsubscribe without restarting and rehydrates after stream failure', async () => {
    const streams = [fakeStream(), fakeStream()]
    const execStream = vi
      .fn<ProjectHost['execStream']>()
      .mockReturnValueOnce(streams[0]!.handle)
      .mockReturnValueOnce(streams[1]!.handle)
    const hub = telemetryHub(execStream)
    const stopFirst = hub.subscribe(subscription(3))
    const remainingEmit = vi.fn<(value: HarnessTelemetry | undefined) => void>()
    const remaining = subscription(4, remainingEmit)
    const stopSecond = hub.subscribe(remaining)
    await vi.waitFor(() => expect(streams[0]!.writes).toHaveLength(3))

    void stopFirst()
    await vi.waitFor(() => expect(streams[0]!.writes).toHaveLength(5))
    expect(streams[0]!.writes[3]).toBe('R\t2\t1\n')
    expect(execStream).toHaveBeenCalledOnce()

    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    streams[0]!.fail(new Error('transport lost'))
    expect(remainingEmit).toHaveBeenCalledWith(undefined)
    await vi.waitFor(() => expect(execStream).toHaveBeenCalledTimes(2), {
      timeout: 1_000,
    })
    await vi.waitFor(() => expect(streams[1]!.writes).toHaveLength(2))

    expect(streams[1]!.writes[0]).toBe('R\t3\t1\n')
    expect(streams[1]!.writes[1]).toContain(`\t${uuid(4)}\t${uuid(4)}\t`)
    const epoch = execStream.mock.calls[1]?.[1].at(-1)
    if (!epoch) throw new Error('Expected restarted telemetry hub epoch')
    streams[1]!.stdout(
      frame(epoch, '1', remaining.subscriptionId, remaining.sessionId, 8),
    )
    expect(remainingEmit).toHaveBeenLastCalledWith(undefined)
    streams[1]!.stdout(
      frame(epoch, '3', remaining.subscriptionId, remaining.sessionId, 9),
    )
    expectSnapshot(remainingEmit.mock.calls.at(-1)?.[0], 9, remaining.sessionId)
    void stopSecond()
    warning.mockRestore()
  })

  it('accepts an admitted subscription frame while a newer reconcile is in flight', async () => {
    const stream = fakeStream()
    const execStream = vi.fn<ProjectHost['execStream']>(() => stream.handle)
    const hub = telemetryHub(execStream)
    const firstEmit = vi.fn<(value: HarnessTelemetry | undefined) => void>()
    const first = subscription(5, firstEmit)
    const stopFirst = hub.subscribe(first)
    await vi.waitFor(() => expect(stream.writes).toHaveLength(2))

    const secondEmit = vi.fn<(value: HarnessTelemetry | undefined) => void>()
    const second = subscription(6, secondEmit)
    const stopSecond = hub.subscribe(second)
    await vi.waitFor(() => expect(stream.writes).toHaveLength(5))
    const epoch = execStream.mock.calls[0]?.[1].at(-1)
    if (!epoch) throw new Error('Expected telemetry hub epoch argument')

    stream.stdout(frame(epoch, '1', first.subscriptionId, first.sessionId, 17))
    stream.stdout(frame(epoch, '1', second.subscriptionId, second.sessionId, 99))

    expectSnapshot(firstEmit.mock.calls.at(-1)?.[0], 17, first.sessionId)
    expect(secondEmit).not.toHaveBeenCalled()
    void stopFirst()
    void stopSecond()
  })

  it('releases a killed follower write lock without stalling survivors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hvir-telemetry-lock-'))
    const firstPath = join(directory, 'first.jsonl')
    const secondPath = join(directory, 'second.jsonl')
    await writeFile(firstPath, '')
    await writeFile(secondPath, '')
    const host = new LocalHost()
    await host.connect()
    const script = buildTelemetryHubScript({
      prepareFollower: `
        follower_source=$(decode_base64 "$follower_resource") || exit 1
      `,
      acceptRecord: `
        if [ "$line" = hold ]; then
          acquire_frame_lock || continue
          : >"$follower_source.locked"
          sleep 30
          release_frame_lock
        else
          emit_frame "$line"
        fi
      `,
    })
    const hub = new HarnessTelemetryHub(host, {
      providerId: 'lock-test',
      remoteScript: script,
      parse: (record) => {
        const value = JSON.parse(record) as { used: number }
        return snapshot(value.used)
      },
    })
    const stopFirst = hub.subscribe({
      ...subscription(7),
      resource: firstPath,
    })
    const survivorEmit = vi.fn<(value: HarnessTelemetry | undefined) => void>()
    const stopSecond = hub.subscribe({
      ...subscription(8, survivorEmit),
      resource: secondPath,
    })
    try {
      await appendFile(firstPath, 'hold\n')
      await vi.waitFor(
        () => expect(fileExists(`${firstPath}.locked`)).resolves.toBe(true),
        {
          timeout: 4_000,
        },
      )

      void stopFirst()
      await appendFile(secondPath, '{"used":23}\n')

      await vi.waitFor(
        () => {
          expectSnapshot(survivorEmit.mock.calls.at(-1)?.[0], 23, uuid(8))
        },
        { timeout: 4_000 },
      )
    } finally {
      void stopSecond()
      await host.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

function telemetryHub(execStream: ProjectHost['execStream']): HarnessTelemetryHub {
  const host = {
    hostId: LOCAL_HOST_ID,
    execStream,
  } as unknown as ProjectHost
  return new HarnessTelemetryHub(host, {
    providerId: 'test',
    remoteScript: 'test helper',
    parse: (record) => {
      try {
        const value = JSON.parse(record) as { used?: unknown }
        return typeof value.used === 'number' ? snapshot(value.used) : null
      } catch {
        return null
      }
    },
  })
}

function snapshot(usedTokens: number) {
  return contextHarnessSnapshot({
    providerId: asHarnessProviderId('test'),
    provenance: 'test fixture',
    context: { usedTokens },
    observedAt: 1,
  })
}

function expectSnapshot(
  telemetry: HarnessTelemetry | undefined,
  usedTokens: number,
  sessionId: string,
): void {
  expect(telemetry?.version).toBe(1)
  expect(telemetry?.facets.session).toEqual({
    status: 'available',
    value: { id: sessionId, state: 'active' },
  })
  expect(telemetry?.facets.context).toEqual({
    status: 'available',
    value: { usedTokens },
  })
}

function subscription(index: number, emit = vi.fn()): HarnessTelemetrySubscription {
  return {
    subscriptionId: uuid(index),
    sessionId: uuid(index),
    resource: `/tmp/session-${index}.jsonl`,
    signal: new AbortController().signal,
    emit,
  }
}

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
}

function frame(
  epoch: string,
  generation: string | undefined,
  subscriptionId: string,
  sessionId: string,
  used: number,
): string {
  const payload = Buffer.from(JSON.stringify({ used }), 'utf8').toString('base64')
  return `E\t${epoch}\t${generation}\t${subscriptionId}\t${sessionId}\t${payload}\n`
}

function fakeStream(): FakeStream {
  const stdoutListeners = new Set<(value: string) => void>()
  const errorListeners = new Set<(error: Error) => void>()
  const exitListeners = new Set<
    (result: { code: number | null; signal: string | null }) => void
  >()
  const writes: string[] = []
  const end = vi.fn(() => {
    queueMicrotask(() => {
      for (const callback of exitListeners) callback({ code: 0, signal: null })
    })
    return Promise.resolve()
  })
  const handle: ExecStreamHandle = {
    onStdout: (callback) => subscribe(stdoutListeners, callback),
    onStderr: () => () => undefined,
    onError: (callback) => subscribe(errorListeners, callback),
    onExit: (callback) => subscribe(exitListeners, callback),
    write: (value) => {
      writes.push(value)
      return Promise.resolve()
    },
    end,
    kill: () => undefined,
    dispose: () => undefined,
  }
  return {
    handle,
    writes,
    end,
    stdout(value) {
      for (const callback of stdoutListeners) callback(value)
    },
    fail(error) {
      for (const callback of errorListeners) callback(error)
    },
  }
}

function subscribe<T>(listeners: Set<(value: T) => void>, callback: (value: T) => void) {
  listeners.add(callback)
  return () => {
    listeners.delete(callback)
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
