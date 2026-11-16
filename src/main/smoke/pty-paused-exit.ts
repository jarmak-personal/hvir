import { createHash } from 'node:crypto'

import type { HostPath } from '../../shared'
import { plainShellProvider } from '../harness/harness-provider'
import type { ProjectHost, PtyExit } from '../project-host'
import type { PtyPreparedTerminal } from '../pty/pty-contract'
import type { ManagedPty, PtySupervisor } from '../pty/pty-supervisor'

const PREFIX = 'HVIR_1120_PREFIX_' + '0123456789abcdef'.repeat(8)
// Qualify a small final write while application consumption is paused.
// Larger unadmitted producer-exit tails are outside this fixture's evidence.
const TAIL = 'é🙂'.repeat(32) + 'HVIR_1120_FINAL_7e298c1d'
const BODY = PREFIX + TAIL
const BODY_HASH = createHash('sha256').update(BODY).digest('hex')
const HOLD_MS = 500
const OWNER = 0
type Mode = 'admitted' | 'unadmitted' | 'failed' | 'close'

/** The installed node-pty native onexit marks inputClosed before the paused
 * readable tail settles. This public fact witnesses physical exit independently
 * of the supervisor's later decoded-output/public-exit boundary. */
export async function verifyPausedPtyExit(
  host: ProjectHost,
  supervisor: PtySupervisor,
  root: HostPath,
): Promise<void> {
  const descriptors = libuvDescriptorCount
  const ttyResources = () =>
    process.getActiveResourcesInfo().filter((name) => name === 'TTYWrap').length
  const baseline = {
    libuvDescriptors: descriptors(),
    ttyResources: ttyResources(),
    sessions: supervisor.list().length,
  }
  const results = []
  // Every scheduled cycle must pass; repetition is not a retry policy.
  for (let cycle = 0; cycle < 2; cycle++) {
    for (const mode of ['admitted', 'unadmitted', 'failed', 'close'] as const) {
      results.push(await verifyCase(mode, cycle, host, supervisor, root))
      const deadline = Date.now() + 3000
      while (
        descriptors() !== baseline.libuvDescriptors ||
        ttyResources() !== baseline.ttyResources
      ) {
        if (Date.now() >= deadline)
          throw new Error(`Paused PTY resources did not quiesce: ${mode}/${cycle}`)
        await new Promise<void>((resolve) => setTimeout(resolve, 10))
      }
      if (supervisor.list().length !== baseline.sessions)
        throw new Error(`Paused PTY session remained supervised: ${mode}/${cycle}`)
    }
  }
  console.log(
    'HVIR_PTY_PAUSED_EXIT_OK ' +
      JSON.stringify({
        cases: results,
        baseline,
        after: {
          libuvDescriptors: descriptors(),
          ttyResources: ttyResources(),
          sessions: supervisor.list().length,
        },
        realSupervisorAndInstalledLocalPty: true,
        nativeConsumerSimulated: true,
        fixtureTailBytes: Buffer.byteLength(TAIL),
        largeUnadmittedProducerExitQualified: false,
        hardwareQualified: false,
      }),
  )
}

/** Observe numeric descriptors retained by Node's real libuv handles. Keep no
 * full diagnostic report (which also contains environment and process details).
 * /dev/fd cannot be enumerated with LocalHost's typed readdir on macOS: its
 * ephemeral directory descriptor may close before Node's fallback lstat. */
function libuvDescriptorCount(): number {
  const report = process.report.getReport()
  if (!('libuv' in report) || !Array.isArray(report.libuv))
    throw new Error('Paused PTY libuv descriptor observation unavailable')
  return report.libuv.filter(
    (entry: unknown) =>
      typeof entry === 'object' &&
      entry !== null &&
      'fd' in entry &&
      typeof entry.fd === 'number' &&
      entry.fd >= 0,
  ).length
}

async function verifyCase(
  mode: Mode,
  cycle: number,
  host: ProjectHost,
  supervisor: PtySupervisor,
  root: HostPath,
) {
  const id = `paused-exit-${mode}-${cycle}`
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const deadline = Date.now() + 10000
  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        timers.delete(timer)
        resolve()
      }, ms)
      timers.add(timer)
    })
  const until = async (condition: () => boolean, phase: string) => {
    while (!condition()) {
      if (Date.now() >= deadline) throw new Error(`Paused PTY ${id} timed out: ${phase}`)
      await wait(10)
    }
  }
  let release!: () => void, refuse!: (error: Error) => void
  const held = new Promise<void>((resolve, reject) => {
    release = resolve
    refuse = reject
  })
  // A fixture failure can precede the first native call.
  void held.catch(() => undefined)
  let writer: Parameters<PtyPreparedTerminal['connect']>[0] | undefined
  let active = 0,
    maximumActive = 0,
    maximumBatch = 0,
    disposed = 0,
    failures = 0,
    nativeExits = 0,
    publicExits = 0,
    nativeBytes = 0,
    decodedBytes = 0
  let physicalExit: PtyExit | undefined
  const nativeHash = createHash('sha256'),
    decodedHash = createHash('sha256')
  const injected = new Error('paused-pty-native-feed-injected-failure')
  const native: PtyPreparedTerminal = {
    columns: 80,
    rows: 24,
    connect(value) {
      writer = value
    },
    async output(text) {
      maximumActive = Math.max(maximumActive, ++active)
      maximumBatch = Math.max(maximumBatch, Buffer.byteLength(text))
      try {
        // PTY read chunking is not the contract. In the admitted case let any
        // earlier chunks finish, then hold the chunk completing the known body.
        if (
          mode !== 'admitted' ||
          nativeBytes + Buffer.byteLength(text) >= Buffer.byteLength(BODY)
        )
          await held
        nativeHash.update(text)
        nativeBytes += Buffer.byteLength(text)
      } finally {
        active--
      }
    },
    exited() {
      nativeExits++
      return Promise.resolve()
    },
    failed(error) {
      if (error !== injected) throw error
      failures++
    },
    dispose() {
      if (active) throw new Error('Paused PTY disposed before physical native completion')
      disposed++
      return Promise.resolve()
    },
  }
  let terminal: ManagedPty | undefined
  let detach: (() => void | Promise<void>) | undefined
  const stopExit = supervisor.onExit((info, exit) => {
    if (info.id !== id) return
    publicExits++
    physicalExit = exit
  })
  const cancellation = new AbortController()
  const cancelTimer = setTimeout(() => cancellation.abort(), 10000)
  timers.add(cancelTimer)
  let inputClosedObserved = false
  let sourceExitDuringHold: number | null = null
  try {
    terminal = await supervisor.spawn({
      host,
      provider: plainShellProvider,
      cwd: root,
      workspaceRoot: root,
      ownerId: OWNER,
      sessionId: id,
      signal: cancellation.signal,
      prepareTerminal: () => Promise.resolve(native),
      launchSpec: {
        file: process.execPath,
        args: [
          '-e',
          `process.stdin.setRawMode(true);process.stdin.resume();` +
            (mode === 'admitted'
              ? `process.stdout.write(${JSON.stringify(BODY)},()=>process.exit(0))`
              : `process.stdin.once('data',()=>process.stdout.write(${JSON.stringify(TAIL)},()=>process.exit(0)));process.stdout.write(${JSON.stringify(PREFIX)})`),
        ],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      },
    })
    detach = supervisor.attach(id, OWNER, {
      onData(text) {
        decodedHash.update(text)
        decodedBytes += Buffer.byteLength(text)
      },
    })
    await until(
      () =>
        active === 1 && (mode !== 'admitted' || decodedBytes === Buffer.byteLength(BODY)),
      'held admitted feed',
    )
    const admittedBytes = decodedBytes
    const completedNativeBytes = nativeBytes
    const heldResources = {
      libuvDescriptors: libuvDescriptorCount(),
      ttyResources: process.getActiveResourcesInfo().filter((name) => name === 'TTYWrap')
        .length,
    }
    if (!admittedBytes || (mode !== 'admitted' && admittedBytes > PREFIX.length))
      throw new Error(`Paused PTY unexpected admitted prefix: ${mode}`)
    if (mode === 'close') {
      supervisor.disposeSession(id, OWNER)
      if (writer?.live || disposed || supervisor.get(id))
        throw new Error('Paused PTY close did not revoke before pending feed cleanup')
      await wait(HOLD_MS)
      if (disposed || nativeExits || failures)
        throw new Error('Paused PTY close fabricated native completion')
      release()
      await until(() => disposed === 1, 'explicit close native cleanup')
    } else {
      if (mode !== 'admitted') supervisor.write(id, OWNER, 'finish')
      await until(() => writer?.live === false, 'physical input closure')
      inputClosedObserved = true
      assertChildReaped(terminal.pid)
      // Deliberately hold after real physical exit longer than the former 200ms
      // unconditional node-pty guard. The unadmitted cases retain unread bytes;
      // the admitted case may already have EOF, but must retain its native call.
      await wait(HOLD_MS)
      sourceExitDuringHold = publicExits
      if (
        decodedBytes !== admittedBytes ||
        nativeBytes !== completedNativeBytes ||
        active !== 1 ||
        nativeExits ||
        (mode !== 'admitted' && (publicExits || !supervisor.get(id)))
      )
        throw new Error(
          `Paused PTY held-tail mismatch: ${mode} ` +
            JSON.stringify({
              decodedBytes,
              admittedBytes,
              nativeBytes,
              completedNativeBytes,
              active,
              publicExits,
              nativeExits,
              supervised: !!supervisor.get(id),
            }),
        )
      if (mode === 'failed') refuse(injected)
      else release()
      await until(() => publicExits === 1 && nativeExits === 1, 'drained public exit')
      if (physicalExit?.exitCode !== 0 || supervisor.get(id))
        throw new Error(`Paused PTY natural exit did not settle: ${mode}`)
      const bodyBytes = Buffer.byteLength(BODY)
      if (
        decodedBytes !== bodyBytes ||
        decodedHash.digest('hex') !== BODY_HASH ||
        (mode === 'failed'
          ? failures !== 1 || nativeBytes !== 0
          : failures !== 0 ||
            nativeBytes !== bodyBytes ||
            nativeHash.digest('hex') !== BODY_HASH)
      )
        throw new Error(`Paused PTY exact-tail outcome mismatch: ${mode}`)
      // Natural exit retains read-only native history; its state owner, rather
      // than the supervisor's live-PTY registry, owns this final explicit close.
      await native.dispose()
    }
    if (maximumActive !== 1 || maximumBatch > 128 * 1024 || disposed !== 1)
      throw new Error(`Paused PTY bounded consumer/cleanup mismatch: ${mode}`)
    await until(() => !childAlive(terminal!.pid), 'owned child reaped')
    return {
      mode,
      cycle,
      admittedAtPhysicalExit: mode === 'close' ? null : admittedBytes,
      unadmittedAtPhysicalExit:
        mode === 'close' ? null : Buffer.byteLength(BODY) - admittedBytes,
      inputClosedObserved,
      sourceExitDuringHold,
      heldAfterPhysicalExitMs: mode === 'close' ? null : HOLD_MS,
      decodedBytes,
      nativeBytes,
      expectedBodySha256: BODY_HASH,
      heldResources,
      parserFailed: failures === 1,
      exactFixtureBodyPreserved: mode === 'admitted' || mode === 'unadmitted',
      maximumBatch,
      maximumActive,
      nativeDisposed: disposed,
      ownedChildReaped: true,
    }
  } finally {
    release()
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    await detach?.()
    await stopExit()
    if (supervisor.get(id)) supervisor.disposeSession(id, OWNER)
    // A preceding assertion can fail while the physical native call is pending.
    // Let its exact completion run before settling this fixture's state owner.
    while (active) await new Promise<void>((resolve) => setTimeout(resolve, 0))
    if (!disposed) await native.dispose()
  }
}

function childAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}
function assertChildReaped(pid: number): void {
  if (childAlive(pid)) throw new Error('Paused PTY physical input closure preceded reap')
}
