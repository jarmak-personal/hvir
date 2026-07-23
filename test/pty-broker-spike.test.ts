import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { BoundedReplayStore } from '../scripts/pty-broker-spike/bounded-replay.ts'
import { clientFrameDisposition } from '../scripts/pty-broker-spike/client-queue.ts'
import {
  BrokerRequestError,
  SpikeBrokerClient,
  attachmentAuthority,
  sessionAuthority,
  startSpikeBroker,
  waitForBrokerEvent,
  waitForProcessExit,
  type SpikeBrokerHandle,
} from '../scripts/pty-broker-spike/client.ts'
import {
  BROKER_PROTOCOL_VERSION,
  BrokerProtocolError,
  parseBrokerRequest,
  type BrokerSpawnResult,
} from '../scripts/pty-broker-spike/protocol.ts'

const syntheticHarness = fileURLToPath(
  new URL('../scripts/pty-broker-spike/synthetic-harness.ts', import.meta.url),
)
const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  const failures: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'PTY broker spike cleanup failed')
  }
})

describe('bounded broker replay policy', () => {
  it('enforces per-session and global byte caps while retaining newest chunks', () => {
    const replay = new BoundedReplayStore(10, 14)
    replay.append('one', 1, 'aaaaaa')
    replay.append('one', 2, 'bbbbbb')
    replay.append('two', 1, 'cccccc')

    expect(replay.status('one')).toEqual({ bytes: 6, droppedBytes: 6 })
    expect(replay.snapshot('one')).toEqual({
      chunks: [{ sequence: 2, data: 'bbbbbb' }],
      bytes: 6,
      droppedBytes: 6,
    })
    expect(replay.status('two')).toEqual({ bytes: 6, droppedBytes: 0 })
    expect(replay.totalBytes()).toBe(12)

    replay.append('two', 2, 'dddddd')
    expect(replay.totalBytes()).toBeLessThanOrEqual(14)
    expect(
      replay.status('one').droppedBytes + replay.status('two').droppedBytes,
    ).toBeGreaterThanOrEqual(12)
    expect(replay.snapshot('two', 1).chunks).toEqual([{ sequence: 2, data: 'dddddd' }])
  })

  it('bounds a single oversized chunk and exposes truncation', () => {
    const replay = new BoundedReplayStore(8, 16)
    replay.append('session', 1, '0123456789')

    const snapshot = replay.snapshot('session')
    expect(snapshot.bytes).toBeLessThanOrEqual(8)
    expect(snapshot.droppedBytes).toBeGreaterThanOrEqual(2)
    expect(snapshot.chunks[0]?.data).toContain('23456789')
  })
})

describe('bounded broker client queue policy', () => {
  it('drops PTY data and disconnects control before exceeding the cap', () => {
    expect(clientFrameDisposition(3_000, 1_000, 4_096, true)).toBe('send')
    expect(clientFrameDisposition(3_500, 1_000, 4_096, true)).toBe('drop')
    expect(clientFrameDisposition(3_500, 1_000, 4_096, false)).toBe('disconnect')
    expect(clientFrameDisposition(0, 8_192, 4_096, true)).toBe('drop')
  })
})

describe('broker protocol boundary', () => {
  it('rejects incompatible protocol versions before dispatch', () => {
    expect(() =>
      parseBrokerRequest(
        JSON.stringify({
          version: BROKER_PROTOCOL_VERSION + 1,
          type: 'request',
          requestId: 'request-1',
          brokerToken: 'a'.repeat(43),
          operation: 'status',
          body: {},
        }),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<BrokerProtocolError>>({
        code: 'INCOMPATIBLE_PROTOCOL',
      }),
    )
  })
})

describe.sequential('detached local PTY broker spike', () => {
  it('survives owner loss, reattaches the same PTY, and fences the stale epoch', async () => {
    const scratch = await ownedScratch()
    const handle = await ownedBroker({
      defaultLeaseMs: 3_000,
      terminationGraceMs: 200,
      tombstoneMs: 50,
    })
    const first = await handle.connect()
    const session = await spawnSynthetic(first, scratch, 3_000, 350)
    const pids = await processRecord(scratch)

    first.crash()
    await eventually(async () => {
      const observer = await handle.connect()
      try {
        const status = (await observer.list()).find(
          (candidate) => candidate.sessionId === session.sessionId,
        )
        return status?.orphanDeadline !== undefined
      } finally {
        await observer.close()
      }
    })
    await eventually(() => fileExists(join(scratch, 'marker')))

    const second = await handle.connect()
    const reattached = await second.attach(sessionAuthority(session))
    expect(reattached.pid).toBe(session.pid)
    expect(reattached.epoch).toBeGreaterThan(session.epoch)

    await expect(
      second.write(attachmentAuthority(session), 'ping stale\n'),
    ).rejects.toMatchObject({ code: 'STALE_ATTACHMENT' })

    const pong = waitForBrokerEvent(
      second,
      (event) =>
        event.event === 'data' &&
        event.sessionId === session.sessionId &&
        event.epoch === reattached.epoch &&
        event.data.includes('pong current'),
    )
    await second.write(attachmentAuthority(reattached), 'ping current\n')
    await pong

    const resized = waitForBrokerEvent(
      second,
      (event) =>
        event.event === 'data' &&
        event.sessionId === session.sessionId &&
        event.data.includes('size:101x37'),
    )
    await second.resize(attachmentAuthority(reattached), 101, 37)
    await resized

    const revoked = waitForBrokerEvent(
      second,
      (event) =>
        event.event === 'revoked' &&
        event.sessionId === session.sessionId &&
        event.epoch === reattached.epoch,
    )
    const third = await handle.connect()
    const claimed = await third.attach(sessionAuthority(session))
    await revoked
    expect(claimed.epoch).toBeGreaterThan(reattached.epoch)
    await expect(
      second.write(attachmentAuthority(reattached), 'ping stale-writer\n'),
    ).rejects.toMatchObject({ code: 'STALE_ATTACHMENT' })
    await expect(
      second.resize(attachmentAuthority(reattached), 102, 38),
    ).rejects.toMatchObject({ code: 'STALE_ATTACHMENT' })
    await expect(second.terminate(attachmentAuthority(reattached))).rejects.toMatchObject(
      { code: 'STALE_ATTACHMENT' },
    )

    let staleObserverReceivedClaimedOutput = false
    const disposeStaleObserver = second.onEvent((event) => {
      if (
        event.event === 'data' &&
        event.sessionId === session.sessionId &&
        event.data.includes('pong claimed')
      ) {
        staleObserverReceivedClaimedOutput = true
      }
    })
    const claimedPong = waitForBrokerEvent(
      third,
      (event) =>
        event.event === 'data' &&
        event.sessionId === session.sessionId &&
        event.epoch === claimed.epoch &&
        event.data.includes('pong claimed'),
    )
    await third.write(attachmentAuthority(claimed), 'ping claimed\n')
    await claimedPong
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
    expect(staleObserverReceivedClaimedOutput).toBe(false)
    disposeStaleObserver()

    await third.terminate(attachmentAuthority(claimed))
    expect(await waitForProcessExit(pids.leaderPid)).toBe(true)
    expect(await waitForProcessExit(pids.grandchildPid)).toBe(true)
    await second.close()
    await third.close()
  }, 20_000)

  it('expires an orphan lease and reaps the complete owned process group', async () => {
    const scratch = await ownedScratch()
    const handle = await ownedBroker({
      defaultLeaseMs: 150,
      terminationGraceMs: 150,
      tombstoneMs: 50,
      idleExitMs: 50,
    })
    const client = await handle.connect()
    const session = await spawnSynthetic(client, scratch, 150, 5_000)
    const pids = await processRecord(scratch)

    client.crash()
    expect(session.pid).toBe(pids.leaderPid)
    expect(await waitForProcessExit(pids.leaderPid, 5_000)).toBe(true)
    expect(await waitForProcessExit(pids.grandchildPid, 5_000)).toBe(true)
    expect(await waitForProcessExit(handle.pid, 5_000)).toBe(true)
    expect(await fileExists(handle.socketPath)).toBe(false)
  }, 15_000)

  it('bounds detached replay and reports discarded output without blocking the child', async () => {
    const scratch = await ownedScratch()
    const handle = await ownedBroker({
      perSessionReplayBytes: 4 * 1024,
      globalReplayBytes: 8 * 1024,
      clientQueueBytes: 16 * 1024,
      defaultLeaseMs: 3_000,
      terminationGraceMs: 200,
      tombstoneMs: 50,
    })
    const first = await handle.connect()
    const session = await spawnSynthetic(first, scratch, 3_000, 100)
    await first.write(attachmentAuthority(session), `flood ${64 * 1024}\n`)
    first.crash()

    const second = await handle.connect()
    await eventually(async () => {
      const status = (await second.list()).find(
        (candidate) => candidate.sessionId === session.sessionId,
      )
      return Boolean(
        status && status.replayBytes <= 4 * 1024 && status.replayDroppedBytes > 0,
      )
    })
    const reattached = await second.attach(sessionAuthority(session))
    expect(reattached.replayBytes).toBeLessThanOrEqual(4 * 1024)
    expect(reattached.replayDroppedBytes).toBeGreaterThan(0)

    const overflowDeltas: number[] = []
    const disposeOverflow = second.onEvent((event) => {
      if (
        event.event === 'overflow' &&
        event.sessionId === session.sessionId &&
        event.epoch === reattached.epoch &&
        event.scope === 'replay'
      ) {
        overflowDeltas.push(event.droppedBytes)
      }
    })
    const secondFlood = waitForBrokerEvent(
      second,
      (event) => event.event === 'data' && event.data.includes('flood-end'),
    )
    await second.write(attachmentAuthority(reattached), `flood ${8 * 1024}\n`)
    await secondFlood
    const pong = waitForBrokerEvent(
      second,
      (event) => event.event === 'data' && event.data.includes('pong after-flood'),
    )
    await second.write(attachmentAuthority(reattached), 'ping after-flood\n')
    await pong
    const statusAfterPing = (await second.list()).find(
      (candidate) => candidate.sessionId === session.sessionId,
    )
    const newlyDropped =
      (statusAfterPing?.replayDroppedBytes ?? 0) - reattached.replayDroppedBytes
    expect(newlyDropped).toBeGreaterThan(0)
    expect(overflowDeltas.reduce((total, bytes) => total + bytes, 0)).toBe(newlyDropped)
    disposeOverflow()
    await second.terminate(attachmentAuthority(reattached))
    await second.close()
  }, 15_000)

  it('turns a disconnect during spawn into a bounded orphan or no session', async () => {
    const scratch = await ownedScratch()
    const handle = await ownedBroker({
      defaultLeaseMs: 125,
      terminationGraceMs: 125,
      tombstoneMs: 50,
      idleExitMs: 500,
    })
    const client = await handle.connect()
    const pendingSpawn = client
      .spawn({
        file: process.execPath,
        args: [
          syntheticHarness,
          '--marker',
          join(scratch, 'marker'),
          '--process-record',
          join(scratch, 'process.json'),
          '--delay-ms',
          '5000',
        ],
        cwd: process.cwd(),
        leaseMs: 125,
      })
      .catch(() => undefined)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1))
    client.crash()
    await pendingSpawn

    const observer = await handle.connect()
    const observed = await observer.list()
    for (const session of observed) {
      if (session.state === 'live') expect(session.orphanDeadline).toBeDefined()
    }
    await eventually(async () => {
      const current = await observer.list()
      return current.every((session) => session.state !== 'live')
    })
    if (await fileExists(join(scratch, 'process.json'))) {
      const pids = await processRecord(scratch)
      expect(await waitForProcessExit(pids.leaderPid)).toBe(true)
      expect(await waitForProcessExit(pids.grandchildPid)).toBe(true)
    }
    await observer.close()
  }, 15_000)

  it('rejects session allocation beyond the configured global capacity', async () => {
    const scratch = await ownedScratch()
    const handle = await ownedBroker({
      maxSessions: 1,
      defaultLeaseMs: 3_000,
      terminationGraceMs: 150,
      tombstoneMs: 50,
    })
    const client = await handle.connect()
    const session = await spawnSynthetic(client, scratch, 3_000, 100)
    await expect(
      client.spawn({
        file: process.execPath,
        args: [
          syntheticHarness,
          '--marker',
          join(scratch, 'second.marker'),
          '--process-record',
          join(scratch, 'second.process.json'),
          '--delay-ms',
          '100',
        ],
        cwd: process.cwd(),
      }),
    ).rejects.toMatchObject({ code: 'CAPACITY' })
    await client.terminate(attachmentAuthority(session))
    await client.close()
  }, 10_000)

  it('uses a private endpoint and accepts no unauthenticated control request', async () => {
    const handle = await ownedBroker()
    const directory = await stat(handle.runtimeDirectory)
    const socket = await stat(handle.socketPath)
    expect(directory.mode & 0o077).toBe(0)
    expect(socket.mode & 0o077).toBe(0)
    expect(await readdir(handle.runtimeDirectory)).toEqual(['broker.sock'])

    const unauthenticated = await SpikeBrokerClient.connect(
      handle.socketPath,
      'x'.repeat(43),
    )
    await expect(unauthenticated.status()).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
    } satisfies Partial<BrokerRequestError>)
    await unauthenticated.close()
  }, 10_000)

  it('reaps the complete owned process group during graceful broker shutdown', async () => {
    const scratch = await ownedScratch()
    const handle = await ownedBroker({
      defaultLeaseMs: 3_000,
      terminationGraceMs: 150,
    })
    const client = await handle.connect()
    await spawnSynthetic(client, scratch, 3_000, 5_000)
    const pids = await processRecord(scratch)

    process.kill(handle.pid, 'SIGTERM')
    expect(await waitForProcessExit(handle.pid, 5_000)).toBe(true)
    expect(await waitForProcessExit(pids.leaderPid, 5_000)).toBe(true)
    expect(await waitForProcessExit(pids.grandchildPid, 5_000)).toBe(true)
    expect(await fileExists(handle.socketPath)).toBe(false)
    client.crash()
  }, 15_000)

  it('rejects a late spawn while graceful broker shutdown is in progress', async () => {
    const scratch = await ownedScratch()
    const handle = await ownedBroker({
      defaultLeaseMs: 3_000,
      terminationGraceMs: 1_000,
    })
    const client = await handle.connect()
    await client.spawn({
      file: process.execPath,
      args: [
        syntheticHarness,
        '--marker',
        join(scratch, 'marker'),
        '--process-record',
        join(scratch, 'process.json'),
        '--delay-ms',
        '5000',
        '--ignore-sigterm',
        'true',
      ],
      cwd: process.cwd(),
      leaseMs: 3_000,
    })
    const pids = await processRecord(scratch)

    process.kill(handle.pid, 'SIGTERM')
    await eventually(async () => {
      try {
        const probe = await handle.connect()
        await probe.close()
        return false
      } catch {
        return true
      }
    })
    await expect(
      client.spawn({
        file: process.execPath,
        args: [
          syntheticHarness,
          '--marker',
          join(scratch, 'late.marker'),
          '--process-record',
          join(scratch, 'late.process.json'),
          '--delay-ms',
          '100',
        ],
        cwd: process.cwd(),
        leaseMs: 3_000,
      }),
    ).rejects.toMatchObject({ code: 'BROKER_SHUTTING_DOWN' })

    expect(await waitForProcessExit(handle.pid, 5_000)).toBe(true)
    expect(await waitForProcessExit(pids.leaderPid, 5_000)).toBe(true)
    expect(await waitForProcessExit(pids.grandchildPid, 5_000)).toBe(true)
    expect(await fileExists(join(scratch, 'late.process.json'))).toBe(false)
    client.crash()
  }, 15_000)

  it('records platform-specific process-tree behavior when the broker is killed', async () => {
    const scratch = await ownedScratch()
    const handle = await ownedBroker({
      defaultLeaseMs: 3_000,
      terminationGraceMs: 150,
    })
    const client = await handle.connect()
    await spawnSynthetic(client, scratch, 3_000, 5_000)
    const pids = await processRecord(scratch)
    cleanups.push(() => killExactOwnedGroup(pids.leaderPid, pids.grandchildPid))

    process.kill(handle.pid, 'SIGKILL')
    expect(await waitForProcessExit(handle.pid, 5_000)).toBe(true)
    expect(await waitForProcessExit(pids.leaderPid, 5_000)).toBe(true)
    const grandchildExited = await waitForProcessExit(pids.grandchildPid, 500)
    if (process.platform === 'darwin') {
      // Negative macOS evidence: PTY closure kills the leader but not the
      // non-terminal grandchild in the exact owned process group.
      expect(grandchildExited).toBe(false)
    } else if (process.platform === 'linux') {
      expect(grandchildExited).toBe(true)
    }
    client.crash()
  }, 15_000)
})

async function ownedBroker(
  limits: Parameters<typeof startSpikeBroker>[0] = {},
): Promise<SpikeBrokerHandle> {
  const handle = await startSpikeBroker(limits)
  cleanups.push(() => handle.cleanup())
  return handle
}

async function ownedScratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'hvir-pty-spike-test-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  return directory
}

async function spawnSynthetic(
  client: SpikeBrokerClient,
  scratch: string,
  leaseMs: number,
  delayMs: number,
): Promise<BrokerSpawnResult> {
  const session = await client.spawn({
    file: process.execPath,
    args: [
      syntheticHarness,
      '--marker',
      join(scratch, 'marker'),
      '--process-record',
      join(scratch, 'process.json'),
      '--delay-ms',
      String(delayMs),
    ],
    cwd: process.cwd(),
    leaseMs,
  })
  await eventually(() => fileExists(join(scratch, 'process.json')))
  return session
}

async function processRecord(
  scratch: string,
): Promise<{ readonly leaderPid: number; readonly grandchildPid: number }> {
  const deadline = Date.now() + 5_000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const record = JSON.parse(
        await readFile(join(scratch, 'process.json'), 'utf8'),
      ) as Partial<{ readonly leaderPid: number; readonly grandchildPid: number }>
      const { leaderPid, grandchildPid } = record
      if (
        typeof leaderPid === 'number' &&
        Number.isSafeInteger(leaderPid) &&
        leaderPid > 1 &&
        typeof grandchildPid === 'number' &&
        Number.isSafeInteger(grandchildPid) &&
        grandchildPid > 1
      ) {
        return { leaderPid, grandchildPid }
      }
      lastError = new Error('Synthetic process record did not contain valid PIDs')
    } catch (error) {
      lastError = error
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10))
  }
  throw new Error('Synthetic process record was not complete before its deadline', {
    cause: lastError,
  })
}

async function eventually(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
  }
  throw new Error('Condition did not become true before its deadline')
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return false
    }
    throw error
  }
}

async function killExactOwnedGroup(
  leaderPid: number,
  expectedGrandchildPid: number,
): Promise<void> {
  try {
    process.kill(-leaderPid, 'SIGKILL')
  } catch (error) {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      error.code !== 'ESRCH'
    ) {
      throw error
    }
  }
  await Promise.all([
    waitForProcessExit(leaderPid),
    waitForProcessExit(expectedGrandchildPid),
  ])
}
