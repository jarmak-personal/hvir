import {
  spawn,
  execFileSync,
  type SpawnOptions,
  type ChildProcess,
  type ChildProcessByStdio,
  type SpawnOptionsWithStdioTuple,
  type StdioNull,
  type StdioPipe,
} from 'node:child_process'
import type { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  renameSync,
} from 'node:fs'
import { userInfo, constants } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { lockSync } from 'proper-lockfile'

const DEFAULT_WAIT_MS = 2 * 60 * 60 * 1000
const GRACE_MS = 15_000
const SIGNALS = ['SIGHUP', 'SIGINT', 'SIGTERM'] as const
const lockTarget = join(userInfo().homedir, '.cache/hvir-contributor/electron-smoke')
let lockDirectory = process.env.HVIR_SMOKE_LOCK_DIRECTORY ?? `${lockTarget}.lock`
interface Owner {
  pid: number
  token: string
}

function alive(pid: number, group = false): boolean {
  if (group) {
    // An orphaned zombie cannot execute Electron work. kill(-pgid, 0) alone
    // reports such groups as live on Linux (and can report EPERM on macOS).
    const rows = execFileSync('/bin/ps', ['-axo', 'pgid=,stat='], { encoding: 'utf8' })
    return rows
      .trim()
      .split('\n')
      .some((row) => {
        const [pgid, state] = row.trim().split(/\s+/)
        if (!pgid || !state || !/^[0-9]+$/.test(pgid))
          throw recovery('Invalid process-group evidence')
        return Number(pgid) === pid && !state.startsWith('Z')
      })
  }
  try {
    process.kill(group ? -pid : pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

function owner(): Owner {
  const value = JSON.parse(
    readFileSync(join(lockDirectory, 'owner.json'), 'utf8'),
  ) as Partial<Owner>
  if (
    !Number.isSafeInteger(value.pid) ||
    (value.pid ?? 0) <= 0 ||
    typeof value.token !== 'string'
  ) {
    throw recovery('Invalid smoke owner evidence')
  }
  return value as Owner
}

export function hasSmokeRunLease(): boolean {
  if (!process.env.HVIR_SMOKE_LEASE) return false
  const current = owner()
  if (current.token !== process.env.HVIR_SMOKE_LEASE || !alive(current.pid)) {
    throw new Error(
      `Smoke lock owner is unavailable; explicit recovery required at ${lockDirectory}`,
    )
  }
  return true
}

// Write intent before spawning: death between spawn and recording its PID must
// leave an uncertain record, never an apparently safe lock to reclaim.
export function spawnSmokeProcess(
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe>,
): ChildProcessByStdio<null, Readable, Readable>
export function spawnSmokeProcess(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess
export function spawnSmokeProcess(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  if (!hasSmokeRunLease()) return spawn(command, [...args], options)
  if (options.detached !== true)
    throw new Error('Owned smoke processes require a dedicated process group')
  const record = join(lockDirectory, `group-${randomUUID()}.json`)
  writeFileSync(record, 'null\n', { flag: 'wx' })
  const child = spawn(command, [...args], options)
  if (child.pid) {
    const pid = child.pid
    writeFileSync(record, JSON.stringify(pid))
    child.once('close', () => {
      // Retire completed identities before a long repeated run can reuse a PID.
      // On uncertain evidence, retain the record for the owner's final check.
      try {
        if (!alive(pid, true)) unlinkSync(record)
      } catch {
        /* retain */
      }
    })
  } else unlinkSync(record)
  return child
}

function groups(allowPending = false): number[] {
  return readdirSync(lockDirectory)
    .filter((name) => name.startsWith('group-'))
    .flatMap((name) => {
      let pid: unknown
      try {
        pid = JSON.parse(readFileSync(join(lockDirectory, name), 'utf8'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        if (allowPending) return []
        throw error
      }
      if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
        if (allowPending) return []
        throw new Error(
          'Smoke process launch was interrupted before its identity was recorded',
        )
      }
      return [pid]
    })
}

function recovery(reason: string): Error {
  return new Error(
    `${reason}. Smoke lock retained at ${lockDirectory}; confirm all prior smoke process groups have stopped and remove this exact directory before retrying. Do not remove a live owner's lock.`,
  )
}

function signalGroups(signal: NodeJS.Signals): void {
  for (const pid of groups(true)) {
    try {
      process.kill(-pid, signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH' && alive(pid, true))
        throw error
    }
  }
}

function waitLimit(): number {
  const value = process.env.HVIR_SMOKE_LOCK_WAIT_MS
  if (value === undefined) return DEFAULT_WAIT_MS
  if (
    !/^[0-9]+$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) <= 0
  ) {
    throw new Error('HVIR_SMOKE_LOCK_WAIT_MS must be a positive integer in milliseconds')
  }
  return Number(value)
}

async function acquire(signal: AbortSignal, target: string): Promise<() => void> {
  const limit = waitLimit()
  mkdirSync(lockDirectory, { recursive: true, mode: 0o700 })
  const started = performance.now()
  let lastReport = -Infinity
  let missingOwnerEvidence = false
  while (true) {
    signal.throwIfAborted()
    const elapsed = performance.now() - started
    if (elapsed >= limit) {
      if (missingOwnerEvidence)
        throw recovery(
          '[smoke:lock] Acquisition timed out with a held gate and no owner evidence; Electron was not started',
        )
      throw new Error(
        `[smoke:lock] Acquisition timed out after ${Math.round(elapsed / 1000)}s; Electron was not started`,
      )
    }
    try {
      // Never reclaim on heartbeat age. The stable gate directory is separate
      // from process evidence so journal writes cannot change its heartbeat.
      return lockSync(target, {
        realpath: false,
        lockfilePath: join(lockDirectory, 'gate'),
        stale: Number.MAX_SAFE_INTEGER,
        update: 10_000,
        onCompromised: () => {
          throw recovery('Smoke lock ownership was compromised')
        },
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ELOCKED') throw error
    }
    missingOwnerEvidence = !existsSync(join(lockDirectory, 'owner.json'))
    if (!missingOwnerEvidence) {
      let current: Owner
      try {
        current = owner()
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw recovery('Smoke owner evidence is incomplete')
      }
      if (!alive(current.pid))
        throw recovery('Previous smoke launcher died; child termination is unproven')
    }
    if (elapsed - lastReport >= 60_000) {
      console.error(
        `[smoke:lock] Waiting for another smoke run (${Math.floor(elapsed / 1000)}s elapsed); keep this invocation alive`,
      )
      if (missingOwnerEvidence)
        console.error(recovery('Held smoke gate has no owner evidence').message)
      lastReport = elapsed
    }
    await delay(Math.min(1800 + Math.random() * 400, limit - elapsed), undefined, {
      signal,
    })
  }
}

async function stopRemainingGroups(): Promise<void> {
  const remaining = (): boolean => groups().some((pid) => alive(pid, true))
  if (!remaining()) return
  signalGroups('SIGTERM')
  const deadline = performance.now() + GRACE_MS
  while (remaining() && performance.now() < deadline) await delay(100)
  if (!remaining()) return
  signalGroups('SIGKILL')
  const forcedDeadline = performance.now() + 1000
  while (remaining() && performance.now() < forcedDeadline) await delay(50)
  if (remaining()) throw recovery('Could not confirm smoke process termination')
}

async function finishSmokeRun(release: (() => void) | undefined): Promise<void> {
  try {
    await stopRemainingGroups()
  } catch (error) {
    throw recovery(error instanceof Error ? error.message : 'Smoke cleanup was unproven')
  }
  // Cleanup evidence first; removing the gate remains the atomic handoff.
  for (const name of readdirSync(lockDirectory)) {
    if (name !== 'gate') unlinkSync(join(lockDirectory, name))
  }
  delete process.env.HVIR_SMOKE_LEASE
  release?.()
}

export async function runSmokeLocked(
  command: string,
  args: readonly string[],
  target = lockTarget,
): Promise<void> {
  lockDirectory = `${target}.lock`
  if (process.platform === 'win32')
    throw new Error('Smoke locking requires POSIX process groups')
  const cancellation = new AbortController()
  let acquired = false
  let child: ChildProcess | undefined
  const handlers = SIGNALS.map((signal) => {
    const handler = (): void => {
      if (!cancellation.signal.aborted) cancellation.abort(signal)
      // The direct launcher owns its signal semantics, grace period and failure
      // artifact. Sweeping its groups here could kill it before evidence flushes.
      child?.kill(signal)
    }
    process.on(signal, handler)
    return [signal, handler] as const
  })
  let release: (() => void) | undefined
  try {
    release = await acquire(cancellation.signal, target)
    cancellation.signal.throwIfAborted()
    // proper-lockfile can remove its gate on unexpected process exit. Durable
    // owner evidence still fences admission until explicit recovery.
    if (existsSync(join(lockDirectory, 'owner.json'))) {
      throw recovery(
        'Previous smoke ownership evidence remains; child termination is unproven',
      )
    }
    const token = randomUUID()
    writeFileSync(
      join(lockDirectory, 'owner-pending.json'),
      JSON.stringify({ pid: process.pid, token }),
      { flag: 'wx' },
    )
    renameSync(
      join(lockDirectory, 'owner-pending.json'),
      join(lockDirectory, 'owner.json'),
    )
    process.env.HVIR_SMOKE_LEASE = token
    process.env.HVIR_SMOKE_LOCK_DIRECTORY = lockDirectory
    acquired = true
    const launched = spawnSmokeProcess(command, args, {
      detached: true,
      stdio: 'inherit',
      env: process.env,
    })
    child = launched
    const outcome = await new Promise<{
      code: number | null
      signal: NodeJS.Signals | null
    }>((resolveOutcome, reject) => {
      launched.once('error', reject)
      launched.once('close', (code, signal) => resolveOutcome({ code, signal }))
    })
    process.exitCode =
      outcome.code ??
      (outcome.signal ? 128 + (constants.signals[outcome.signal] ?? 1) : 1)
  } finally {
    try {
      if (acquired) await finishSmokeRun(release)
      else release?.()
    } finally {
      for (const [signal, handler] of handlers) process.off(signal, handler)
    }
  }
}

// CLI owners re-enter under the supervising process. Nested launchers share the
// verified lease, including isolation's intentionally parallel successors.
export async function withSmokeRunLock(main: () => Promise<void>): Promise<void> {
  if (hasSmokeRunLease()) return main()
  return runSmokeLocked(process.execPath, process.argv.slice(1))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2)
  if (!command) throw new Error('Usage: smoke-run-lock.mts <command> [args...]')
  const action =
    command === '--check-lease'
      ? Promise.resolve().then(() => {
          if (!hasSmokeRunLease()) throw new Error('Missing smoke lease')
        })
      : runSmokeLocked(command, args)
  void action.catch((error: unknown) => {
    console.error('[smoke:lock]', error instanceof Error ? error.message : 'cancelled')
    process.exitCode = 1
  })
}
