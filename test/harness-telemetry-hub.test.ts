import { appendFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  buildTelemetryHubScript,
  HarnessTelemetryHub,
  type HarnessTelemetrySubscription,
} from '../src/main/harness/harness-telemetry-hub'
import type { HarnessTelemetryFollowerHealth } from '../src/main/harness/harness-telemetry-protocol'
import {
  asHarnessProviderId,
  contextHarnessSnapshot,
  contextStatusHarnessSnapshot,
  type HarnessTelemetry,
} from '../src/shared'
import type { Disposer, ExecStreamHandle, ProjectHost } from '../src/main/project-host'
import { LocalHost } from '../src/main/project-host'
import { LOCAL_HOST_ID } from '../src/shared'

interface FakeStream {
  readonly handle: ExecStreamHandle
  readonly writes: string[]
  readonly end: ReturnType<typeof vi.fn>
  readonly dispose: ReturnType<typeof vi.fn>
  stdout(value: string): void
  fail(error: Error): void
  exit(): void
  failAndExit(error: Error): void
  snapshotStdout(): (value: string) => void
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

  it('routes only admitted, correlated, bounded follower health', async () => {
    const stream = fakeStream()
    const execStream = vi.fn<ProjectHost['execStream']>(() => stream.handle)
    const hub = telemetryHub(execStream, true)
    const firstEmit = vi.fn<(value: HarnessTelemetry | undefined) => void>()
    const secondEmit = vi.fn<(value: HarnessTelemetry | undefined) => void>()
    const first = subscription(20, firstEmit)
    const second = subscription(21, secondEmit)
    const stopFirst = hub.subscribe(first)
    const stopSecond = hub.subscribe(second)
    await vi.waitFor(() => expect(stream.writes).toHaveLength(3))
    const epoch = execStream.mock.calls[0]?.[1].at(-1)
    if (!epoch) throw new Error('Expected telemetry hub epoch argument')
    const generation = stream.writes[0]?.split('\t')[1]

    stream.stdout(
      healthFrame(
        epoch,
        generation,
        first.subscriptionId,
        first.sessionId,
        'pending',
        'awaiting-source',
      ),
    )
    stream.stdout(
      healthFrame(
        epoch,
        '0',
        first.subscriptionId,
        first.sessionId,
        'unavailable',
        'follower-exited',
      ),
    )
    stream.stdout(
      healthFrame(
        epoch,
        generation,
        first.subscriptionId,
        second.sessionId,
        'unavailable',
        'resource-invalid',
      ),
    )
    stream.stdout(
      `H\t${epoch}\t${generation}\t${second.subscriptionId}\t${second.sessionId}\tunavailable\tremote-error-text\n`,
    )

    expect(firstEmit).toHaveBeenCalledOnce()
    expect(firstEmit.mock.calls[0]?.[0]?.facets.context).toEqual({
      status: 'pending',
      reason: 'awaiting-source',
    })
    expect(secondEmit).not.toHaveBeenCalled()
    void stopFirst()
    void stopSecond()
  })

  it('handles back-to-back helper error and exit once, then admits restart health', async () => {
    const streams = [fakeStream(), fakeStream()]
    const execStream = vi
      .fn<ProjectHost['execStream']>()
      .mockReturnValueOnce(streams[0]!.handle)
      .mockReturnValueOnce(streams[1]!.handle)
    const hub = telemetryHub(execStream, true)
    const emit = vi.fn<(value: HarnessTelemetry | undefined) => void>()
    const live = subscription(22, emit)
    const stop = hub.subscribe(live)
    await vi.waitFor(() => expect(streams[0]!.writes).toHaveLength(2))
    const oldStdout = streams[0]!.snapshotStdout()
    const oldEpoch = execStream.mock.calls[0]?.[1].at(-1)
    if (!oldEpoch) throw new Error('Expected initial telemetry hub epoch')
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    streams[0]!.failAndExit(new Error('transport lost'))

    expect(streams[0]!.dispose).toHaveBeenCalledOnce()
    expect(warning).toHaveBeenCalledOnce()
    expect(emit).toHaveBeenCalledOnce()
    expect(emit.mock.calls[0]?.[0]?.facets.context).toEqual({
      status: 'unavailable',
      reason: 'helper-exited',
    })
    await vi.waitFor(() => expect(execStream).toHaveBeenCalledTimes(2), {
      timeout: 1_000,
    })
    await vi.waitFor(() => expect(streams[1]!.writes).toHaveLength(2))
    const epoch = execStream.mock.calls[1]?.[1].at(-1)
    if (!epoch) throw new Error('Expected restarted telemetry hub epoch')

    oldStdout(
      healthFrame(
        oldEpoch,
        '1',
        live.subscriptionId,
        live.sessionId,
        'pending',
        'awaiting-source',
      ),
    )
    streams[1]!.stdout(
      healthFrame(
        epoch,
        '1',
        live.subscriptionId,
        live.sessionId,
        'pending',
        'awaiting-source',
      ),
    )
    expect(emit).toHaveBeenCalledOnce()
    streams[1]!.stdout(
      healthFrame(
        epoch,
        '2',
        live.subscriptionId,
        live.sessionId,
        'pending',
        'awaiting-source',
      ),
    )
    expect(emit.mock.calls[1]?.[0]?.facets.context).toEqual({
      status: 'pending',
      reason: 'awaiting-source',
    })

    void stop()
    warning.mockRestore()
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

  it('keeps an unexpected follower failure isolated and stops replacements quietly', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hvir-telemetry-health-'))
    const firstPath = join(directory, 'first.jsonl')
    const secondPath = join(directory, 'second.jsonl')
    const unrelatedPath = join(directory, 'unrelated.jsonl')
    await Promise.all([
      writeFile(firstPath, ''),
      writeFile(secondPath, ''),
      writeFile(unrelatedPath, ''),
    ])
    const host = new LocalHost()
    await host.connect()
    const script = buildTelemetryHubScript({
      prepareFollower: `
        [ "$follower_resource" != - ] || fail_follower resource-invalid
        follower_source=$(decode_base64 "$follower_resource") || fail_follower resource-invalid
        emit_follower_health pending awaiting-source || true
        [ "$follower_source" != unexpected ] || exit 7
      `,
      acceptRecord: '      emit_frame "$line"',
    })
    const hub = new HarnessTelemetryHub(host, {
      providerId: 'health-test',
      remoteScript: script,
      parse: () => null,
      followerHealth: (sessionId, health) => healthSnapshot(sessionId, health),
    })
    const failedEmit = vi.fn<(value: HarnessTelemetry | undefined) => void>()
    const survivorEmit = vi.fn<(value: HarnessTelemetry | undefined) => void>()
    const unrelatedEmit = vi.fn<(value: HarnessTelemetry | undefined) => void>()
    const failed = { ...subscription(23, failedEmit), resource: 'unexpected' }
    const survivor = { ...subscription(24, survivorEmit), resource: firstPath }
    const unrelated = { ...subscription(25, unrelatedEmit), resource: unrelatedPath }
    const stopFailed = hub.subscribe(failed)
    let stopSurvivor = hub.subscribe(survivor)
    let stopUnrelated: Disposer | undefined
    try {
      await vi.waitFor(
        () => {
          expect(failedEmit.mock.calls.map(([value]) => value?.facets.context)).toEqual([
            { status: 'pending', reason: 'awaiting-source' },
            { status: 'unavailable', reason: 'follower-exited' },
          ])
          expect(survivorEmit.mock.calls[0]?.[0]?.facets.context).toEqual({
            status: 'pending',
            reason: 'awaiting-source',
          })
        },
        { timeout: 4_000 },
      )

      stopUnrelated = hub.subscribe(unrelated)
      await vi.waitFor(
        () =>
          expect(unrelatedEmit.mock.calls[0]?.[0]?.facets.context).toEqual({
            status: 'pending',
            reason: 'awaiting-source',
          }),
        { timeout: 4_000 },
      )
      expect(failedEmit).toHaveBeenCalledTimes(2)

      void stopSurvivor()
      stopSurvivor = hub.subscribe({ ...survivor, resource: secondPath })
      await vi.waitFor(
        () =>
          expect(
            survivorEmit.mock.calls.filter(
              ([value]) => value?.facets.context.status === 'pending',
            ),
          ).toHaveLength(2),
        { timeout: 4_000 },
      )
      expect(
        survivorEmit.mock.calls.filter(
          ([value]) => value?.facets.context.status === 'unavailable',
        ),
      ).toHaveLength(0)

      void stopFailed()
      void stopSurvivor()
      void stopUnrelated?.()
      await vi.waitFor(() => expect(hub.size).toBe(0))
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(
        [...survivorEmit.mock.calls, ...unrelatedEmit.mock.calls].filter(
          ([value]) => value?.facets.context.status === 'unavailable',
        ),
      ).toHaveLength(0)
    } finally {
      void stopFailed()
      void stopSurvivor()
      void stopUnrelated?.()
      await host.dispose()
      await rm(directory, { recursive: true, force: true })
    }
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

function telemetryHub(
  execStream: ProjectHost['execStream'],
  withFollowerHealth = false,
): HarnessTelemetryHub {
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
    followerHealth: withFollowerHealth
      ? (sessionId, health) => healthSnapshot(sessionId, health)
      : undefined,
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

function healthSnapshot(
  sessionId: string,
  health: HarnessTelemetryFollowerHealth,
): HarnessTelemetry {
  return contextStatusHarnessSnapshot({
    providerId: asHarnessProviderId('test'),
    provenance: 'test follower lifecycle',
    sessionId,
    context: { status: health.status, reason: health.reason },
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

function healthFrame(
  epoch: string,
  generation: string | undefined,
  subscriptionId: string,
  sessionId: string,
  status: HarnessTelemetryFollowerHealth['status'],
  reason: HarnessTelemetryFollowerHealth['reason'],
): string {
  return `H\t${epoch}\t${generation}\t${subscriptionId}\t${sessionId}\t${status}\t${reason}\n`
}

function fakeStream(): FakeStream {
  const stdoutListeners = new Set<(value: string) => void>()
  const errorListeners = new Set<(error: Error) => void>()
  const exitListeners = new Set<
    (result: { code: number | null; signal: string | null }) => void
  >()
  const writes: string[] = []
  const dispose = vi.fn()
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
    dispose,
  }
  return {
    handle,
    writes,
    end,
    dispose,
    stdout(value) {
      for (const callback of stdoutListeners) callback(value)
    },
    fail(error) {
      for (const callback of errorListeners) callback(error)
    },
    exit() {
      for (const callback of exitListeners) callback({ code: 1, signal: null })
    },
    failAndExit(error) {
      const errors = [...errorListeners]
      const exits = [...exitListeners]
      for (const callback of errors) callback(error)
      for (const callback of exits) callback({ code: 1, signal: null })
    },
    snapshotStdout() {
      const callbacks = [...stdoutListeners]
      return (value) => {
        for (const callback of callbacks) callback(value)
      }
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
