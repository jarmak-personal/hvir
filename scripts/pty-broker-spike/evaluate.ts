// The evaluation coordinator isolates each count in a fresh Electron-as-Node process.
// eslint-disable-next-line no-restricted-imports
import { spawn } from 'node:child_process'
// Issue #215 owns an isolated local-process benchmark, outside ProjectHost.
// eslint-disable-next-line no-restricted-imports
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The direct baseline and spike broker are the two physical-PTY edges under evaluation.
// eslint-disable-next-line no-restricted-imports
import { type IPty, spawn as spawnPty } from 'node-pty'

import {
  attachmentAuthority,
  sessionAuthority,
  startSpikeBroker,
  type SpikeBrokerClient,
} from './client.ts'
import type {
  BrokerAttachmentAuthority,
  BrokerEvent,
  BrokerSpawnResult,
} from './protocol.ts'

const syntheticHarness = fileURLToPath(new URL('./synthetic-harness.ts', import.meta.url))
const evaluationEntry = fileURLToPath(import.meta.url)
const terminalCounts = [1, 4, 12] as const
const roundTripSamples = 24
const resizeSamples = 8
const throughputBytes = 512 * 1024

interface Quantiles {
  readonly p50: number
  readonly p95: number
  readonly p99: number
}

interface PathMeasurement {
  readonly terminals: number
  readonly roundTripMs: Quantiles
  readonly resizeMs: Quantiles
  readonly outputMiBPerSecond: number
  readonly ownerBaselineRssMiB: number
  readonly ownerIncrementalRssMiB: number
  readonly ownerCpuPercentDuringSamples: number
}

interface DirectSession {
  readonly pty: IPty
  readonly probe: OutputProbe
  readonly exit: Promise<void>
}

interface BrokerSession {
  readonly authority: BrokerAttachmentAuthority
  readonly probe: OutputProbe
}

class OutputProbe {
  private retained = ''
  private readonly waiters = new Set<{
    readonly expected: string
    readonly resolve: () => void
    readonly reject: (error: Error) => void
    readonly timer: ReturnType<typeof setTimeout>
  }>()

  feed(data: string): void {
    this.retained = `${this.retained}${data}`.slice(-1024 * 1024)
    for (const waiter of [...this.waiters]) {
      if (!this.retained.includes(waiter.expected)) continue
      clearTimeout(waiter.timer)
      this.waiters.delete(waiter)
      waiter.resolve()
    }
  }

  reset(): void {
    this.retained = ''
  }

  waitFor(expected: string, timeoutMs = 5_000): Promise<void> {
    if (this.retained.includes(expected)) return Promise.resolve()
    return new Promise((resolveWait, reject) => {
      const waiter = {
        expected,
        resolve: resolveWait,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter)
          reject(new Error('Synthetic output deadline expired'))
        }, timeoutMs),
      }
      this.waiters.add(waiter)
    })
  }

  dispose(): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('Synthetic output probe disposed'))
    }
    this.waiters.clear()
    this.retained = ''
  }
}

async function main(): Promise<void> {
  if (!process.versions.electron || process.env['ELECTRON_RUN_AS_NODE'] !== '1') {
    throw new Error('Run the PTY broker evaluation through the repository package script')
  }
  const [mode, kind, countValue] = process.argv.slice(2)
  if (mode === '--measurement') {
    if (kind === 'direct' || kind === 'broker') {
      const count = Number(countValue)
      if (!terminalCounts.includes(count as (typeof terminalCounts)[number])) {
        throw new Error('Invalid isolated terminal count')
      }
      const result =
        kind === 'direct' ? await measureDirect(count) : await measureBroker(count)
      process.stdout.write(`${JSON.stringify(result)}\n`)
      return
    }
    if (kind === 'reconciliation') {
      process.stdout.write(`${JSON.stringify(await measureReconciliation())}\n`)
      return
    }
    throw new Error('Invalid isolated measurement kind')
  }
  const direct: PathMeasurement[] = []
  const broker: PathMeasurement[] = []
  for (const count of terminalCounts) {
    direct.push(await isolatedMeasurement<PathMeasurement>('direct', count))
    broker.push(await isolatedMeasurement<PathMeasurement>('broker', count))
  }
  const reconciliation = await isolatedMeasurement<{
    readonly zero: Quantiles
    readonly one: Quantiles
    readonly twenty: Quantiles
  }>('reconciliation')
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        platform: process.platform,
        architecture: process.arch,
        electron: process.versions.electron,
        node: process.versions.node,
        samplesPerTerminalCount: roundTripSamples,
        throughputBytes,
        direct,
        broker,
        reconciliationMs: reconciliation,
      },
      null,
      2,
    )}\n`,
  )
}

function isolatedMeasurement<T>(
  kind: 'direct' | 'broker' | 'reconciliation',
  count?: number,
): Promise<T> {
  return new Promise((resolveMeasurement, reject) => {
    const child = spawn(
      process.execPath,
      [
        evaluationEntry,
        '--measurement',
        kind,
        ...(count === undefined ? [] : [String(count)]),
      ],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (data: string) => {
      stdout = `${stdout}${data}`.slice(-2 * 1024 * 1024)
    })
    child.stderr.on('data', (data: string) => {
      stderr = `${stderr}${data}`.slice(-16 * 1024)
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code !== 0) {
        reject(
          new Error(
            `Isolated ${kind} measurement failed ` +
              `(terminals=${count ?? 'n/a'}, code=${code ?? 'none'}, ` +
              `signal=${signal ?? 'none'}): ${stderr.trim()}`,
          ),
        )
        return
      }
      try {
        resolveMeasurement(JSON.parse(stdout) as T)
      } catch (error) {
        reject(
          new Error(`Isolated ${kind} measurement returned invalid JSON`, {
            cause: error,
          }),
        )
      }
    })
  })
}

async function measureDirect(terminals: number): Promise<PathMeasurement> {
  const scratch = await mkdtemp(join(tmpdir(), 'hvir-pty-direct-eval-'))
  const sessions: DirectSession[] = []
  const baselineRss = process.memoryUsage().rss
  const baselineCpu = process.cpuUsage()
  const startedAt = performance.now()
  try {
    for (let index = 0; index < terminals; index++) {
      const probe = new OutputProbe()
      const pty = spawnPty(
        process.execPath,
        syntheticArgs(scratch, `direct-${index}`, 50),
        {
          cwd: process.cwd(),
          env: process.env,
          cols: 80,
          rows: 24,
          name: 'xterm-256color',
        },
      )
      let resolveExit = (): void => undefined
      const exit = new Promise<void>((resolvePromise) => {
        resolveExit = resolvePromise
      })
      pty.onData((data) => probe.feed(data))
      pty.onExit(() => resolveExit())
      sessions.push({ pty, probe, exit })
      await waitForFile(join(scratch, `direct-${index}.process.json`))
    }
    const afterSpawnRss = process.memoryUsage().rss
    const roundTrips = await directRoundTrips(sessions)
    const resizes = await directResizes(sessions[0]!)
    const throughput = await directThroughput(sessions[0]!)
    const elapsedMs = performance.now() - startedAt
    const cpu = process.cpuUsage(baselineCpu)
    return {
      terminals,
      roundTripMs: quantiles(roundTrips),
      resizeMs: quantiles(resizes),
      outputMiBPerSecond: rounded(throughputBytes / (1024 * 1024) / (throughput / 1000)),
      ownerBaselineRssMiB: mebibytes(baselineRss),
      ownerIncrementalRssMiB: mebibytes(Math.max(0, afterSpawnRss - baselineRss)),
      ownerCpuPercentDuringSamples: cpuPercent(cpu, elapsedMs),
    }
  } finally {
    await Promise.allSettled(sessions.map((session) => terminateDirect(session)))
    for (const session of sessions) session.probe.dispose()
    await rm(scratch, { recursive: true, force: true })
  }
}

async function measureBroker(terminals: number): Promise<PathMeasurement> {
  const scratch = await mkdtemp(join(tmpdir(), 'hvir-pty-broker-eval-'))
  const handle = await startSpikeBroker({
    perSessionReplayBytes: 64 * 1024,
    globalReplayBytes: 1024 * 1024,
    clientQueueBytes: 2 * 1024 * 1024,
    defaultLeaseMs: 10_000,
    terminationGraceMs: 250,
    tombstoneMs: 50,
  })
  const client = await handle.connect()
  const sessions: BrokerSession[] = []
  const probes = new Map<string, OutputProbe>()
  const disposeEvents = client.onEvent((event) => routeBrokerData(event, probes))
  try {
    const baseline = await client.status()
    const startedAt = performance.now()
    for (let index = 0; index < terminals; index++) {
      const spawned = await client.spawn({
        file: process.execPath,
        args: syntheticArgs(scratch, `broker-${index}`, 50),
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        leaseMs: 10_000,
      })
      const probe = new OutputProbe()
      probes.set(spawned.sessionId, probe)
      sessions.push({ authority: attachmentAuthority(spawned), probe })
      await waitForFile(join(scratch, `broker-${index}.process.json`))
    }
    const afterSpawn = await client.status()
    const roundTrips = await brokerRoundTrips(client, sessions)
    const resizes = await brokerResizes(client, sessions[0]!)
    const throughput = await brokerThroughput(client, sessions[0]!)
    const finished = await client.status()
    const elapsedMs = performance.now() - startedAt
    const cpuMicros =
      finished.cpuUserMicros +
      finished.cpuSystemMicros -
      baseline.cpuUserMicros -
      baseline.cpuSystemMicros
    return {
      terminals,
      roundTripMs: quantiles(roundTrips),
      resizeMs: quantiles(resizes),
      outputMiBPerSecond: rounded(throughputBytes / (1024 * 1024) / (throughput / 1000)),
      ownerBaselineRssMiB: mebibytes(baseline.rssBytes),
      ownerIncrementalRssMiB: mebibytes(
        Math.max(0, afterSpawn.rssBytes - baseline.rssBytes),
      ),
      ownerCpuPercentDuringSamples: rounded((cpuMicros / (elapsedMs * 1000)) * 100),
    }
  } finally {
    disposeEvents()
    await Promise.allSettled(
      sessions.map((session) => client.terminate(session.authority)),
    )
    for (const session of sessions) session.probe.dispose()
    await client.close().catch(() => undefined)
    await handle.cleanup()
    await rm(scratch, { recursive: true, force: true })
  }
}

async function measureReconciliation(): Promise<{
  readonly zero: Quantiles
  readonly one: Quantiles
  readonly twenty: Quantiles
}> {
  const scratch = await mkdtemp(join(tmpdir(), 'hvir-pty-reconcile-eval-'))
  const handle = await startSpikeBroker({
    globalReplayBytes: 2 * 1024 * 1024,
    clientQueueBytes: 256 * 1024,
    defaultLeaseMs: 10_000,
    terminationGraceMs: 250,
    tombstoneMs: 50,
  })
  let client = await handle.connect()
  const sessions: BrokerSpawnResult[] = []
  try {
    await client.close()
    client = await handle.connect()
    const zero = await listLatencyQuantiles(client, 0)
    sessions.push(
      await client.spawn({
        file: process.execPath,
        args: syntheticArgs(scratch, 'reconcile-0', 50),
        cwd: process.cwd(),
        leaseMs: 10_000,
      }),
    )
    await client.close()
    client = await handle.connect()
    const one = await listLatencyQuantiles(client, 1)
    for (let index = 1; index < 20; index++) {
      sessions.push(
        await client.spawn({
          file: process.execPath,
          args: syntheticArgs(scratch, `reconcile-${index}`, 50),
          cwd: process.cwd(),
          leaseMs: 10_000,
        }),
      )
    }
    await client.close()
    client = await handle.connect()
    const twenty = await listLatencyQuantiles(client, 20)
    return { zero, one, twenty }
  } finally {
    for (const session of sessions) {
      try {
        const attached = await client.attach(sessionAuthority(session))
        await client.terminate(attachmentAuthority(attached))
      } catch {
        // Broker shutdown below remains the exact cleanup backstop for failed samples.
      }
    }
    await client.close().catch(() => undefined)
    await handle.cleanup()
    await rm(scratch, { recursive: true, force: true })
  }
}

async function directRoundTrips(sessions: readonly DirectSession[]): Promise<number[]> {
  const measurements: number[] = []
  for (let sample = 0; sample < roundTripSamples; sample++) {
    const session = sessions[sample % sessions.length]!
    const nonce = `d-${sample}-${Math.random().toString(36).slice(2)}`
    const pending = session.probe.waitFor(`pong ${nonce}`)
    const startedAt = performance.now()
    session.pty.write(`ping ${nonce}\n`)
    await pending
    measurements.push(performance.now() - startedAt)
  }
  return measurements
}

async function brokerRoundTrips(
  client: SpikeBrokerClient,
  sessions: readonly BrokerSession[],
): Promise<number[]> {
  const measurements: number[] = []
  for (let sample = 0; sample < roundTripSamples; sample++) {
    const session = sessions[sample % sessions.length]!
    const nonce = `b-${sample}-${Math.random().toString(36).slice(2)}`
    const pending = session.probe.waitFor(`pong ${nonce}`)
    const startedAt = performance.now()
    await client.write(session.authority, `ping ${nonce}\n`)
    await pending
    measurements.push(performance.now() - startedAt)
  }
  return measurements
}

async function directResizes(session: DirectSession): Promise<number[]> {
  const measurements: number[] = []
  for (let sample = 0; sample < resizeSamples; sample++) {
    const cols = 91 + sample
    const rows = 31 + sample
    const pending = session.probe.waitFor(`size:${cols}x${rows}`)
    const startedAt = performance.now()
    session.pty.resize(cols, rows)
    await pending
    measurements.push(performance.now() - startedAt)
  }
  return measurements
}

async function brokerResizes(
  client: SpikeBrokerClient,
  session: BrokerSession,
): Promise<number[]> {
  const measurements: number[] = []
  for (let sample = 0; sample < resizeSamples; sample++) {
    const cols = 101 + sample
    const rows = 41 + sample
    const pending = session.probe.waitFor(`size:${cols}x${rows}`)
    const startedAt = performance.now()
    await client.resize(session.authority, cols, rows)
    await pending
    measurements.push(performance.now() - startedAt)
  }
  return measurements
}

async function directThroughput(session: DirectSession): Promise<number> {
  session.probe.reset()
  const pending = session.probe.waitFor('flood-end', 10_000)
  const startedAt = performance.now()
  session.pty.write(`flood ${throughputBytes}\n`)
  await pending
  return performance.now() - startedAt
}

async function brokerThroughput(
  client: SpikeBrokerClient,
  session: BrokerSession,
): Promise<number> {
  session.probe.reset()
  const pending = session.probe.waitFor('flood-end', 10_000)
  const startedAt = performance.now()
  await client.write(session.authority, `flood ${throughputBytes}\n`)
  await pending
  return performance.now() - startedAt
}

function routeBrokerData(
  event: BrokerEvent,
  probes: ReadonlyMap<string, OutputProbe>,
): void {
  if (event.event === 'data') probes.get(event.sessionId)?.feed(event.data)
}

function syntheticArgs(scratch: string, name: string, delayMs: number): string[] {
  return [
    syntheticHarness,
    '--marker',
    join(scratch, `${name}.marker`),
    '--process-record',
    join(scratch, `${name}.process.json`),
    '--delay-ms',
    String(delayMs),
  ]
}

async function terminateDirect(session: DirectSession): Promise<void> {
  signalGroup(session.pty.pid, 'SIGTERM')
  if (!(await beforeDeadline(session.exit, 500))) {
    signalGroup(session.pty.pid, 'SIGKILL')
    await beforeDeadline(session.exit, 500)
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
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
}

async function beforeDeadline(event: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      event.then(() => true),
      new Promise<false>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      await stat(path)
      return
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      ) {
        throw error
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
  }
  throw new Error('Synthetic process record was not created')
}

async function listLatencyQuantiles(
  client: SpikeBrokerClient,
  expectedCount: number,
): Promise<Quantiles> {
  const measurements: number[] = []
  for (let sample = 0; sample < 20; sample++) {
    const startedAt = performance.now()
    const sessions = await client.list()
    measurements.push(performance.now() - startedAt)
    if (sessions.length !== expectedCount) {
      throw new Error('Broker reconciliation returned an unexpected session count')
    }
  }
  return quantiles(measurements)
}

function quantiles(values: readonly number[]): Quantiles {
  if (values.length === 0) throw new Error('Quantiles require at least one value')
  const sorted = [...values].sort((left, right) => left - right)
  return {
    p50: rounded(percentile(sorted, 0.5)),
    p95: rounded(percentile(sorted, 0.95)),
    p99: rounded(percentile(sorted, 0.99)),
  }
}

function percentile(sorted: readonly number[], percentileValue: number): number {
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(sorted.length * percentileValue) - 1,
  )
  return sorted[index]!
}

function cpuPercent(usage: NodeJS.CpuUsage, elapsedMilliseconds: number): number {
  return rounded(((usage.user + usage.system) / (elapsedMilliseconds * 1000)) * 100)
}

function mebibytes(bytes: number): number {
  return rounded(bytes / (1024 * 1024))
}

function rounded(value: number): number {
  return Math.round(value * 1000) / 1000
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
  process.stderr.write(`PTY broker evaluation failed: ${message}\n`)
  process.exitCode = 1
})
