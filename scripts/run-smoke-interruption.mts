import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, readFile, realpath, rm } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import type {
  SmokeInterruptionCheckpointEvidence,
  SmokeInterruptionCheckpointName,
} from '../src/main/smoke/interruption-checkpoint'
import { isSmokeInterruptionUuid } from '../src/main/smoke/interruption-identity.mts'

export const SMOKE_OWNERSHIP_MARKER = '.hvir-smoke-owner'
export const SMOKE_OWNERSHIP_MARKER_VALUE = 'hvir-smoke-owned-root-v1\n'

type IsolationScenario = 'pty-native' | 'git-workflow' | 'web-pane'
type IsolationAction = 'observe' | 'fail' | 'pause'

interface InvocationOptions {
  readonly scenario: IsolationScenario
  readonly checkpoint: SmokeInterruptionCheckpointName
  readonly action: IsolationAction
  readonly predecessorToken?: string
  readonly predecessorPaneId?: string
}

interface ProcessOutcome {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
}

type CheckpointRecord = SmokeInterruptionCheckpointEvidence & {
  readonly schema: 1
  readonly runToken: string
}

interface InvocationHandle {
  readonly scenario: IsolationScenario
  readonly runToken: string
  readonly pid: number
  readonly root: Promise<string>
  readonly checkpoint: Promise<CheckpointRecord>
  readonly outcome: Promise<ProcessOutcome>
  readonly disposed: readonly string[]
  readonly tail: readonly string[]
  readonly signal: (signal: NodeJS.Signals) => void
  readonly killGroup: (signal: NodeJS.Signals) => void
}

interface InvocationResult {
  readonly scenario: IsolationScenario
  readonly runToken: string
  readonly pid: number
  readonly root: string
  readonly checkpoint: CheckpointRecord
  readonly outcome: ProcessOutcome
  readonly disposed: readonly string[]
  readonly tail: readonly string[]
}

const ROOT_PREFIX = '[smoke:isolation:owned-root]\t'
const CHECKPOINT_PREFIX = '[smoke:isolation:checkpoint] '
const DISPOSED_PREFIX = '[smoke:isolation:disposed] '
const MAX_TAIL_LINES = 80
const PROCESS_TIMEOUT_MS = 120_000

export function isolationProcessTimeoutError(
  scenario: IsolationScenario,
  tail: readonly string[],
): Error {
  return new Error(
    `${scenario} isolation process timed out; tail=${JSON.stringify(
      tail.slice(-20).map((line) => line.slice(0, 500)),
    )}`,
  )
}

export async function cleanupOwnedSmokeRoot(
  root: string,
  temporaryParent: string,
): Promise<void> {
  const canonicalParent = await realpath(temporaryParent)
  if (resolve(root) !== root || dirname(root) !== canonicalParent) {
    throw new Error(`Refusing stale smoke cleanup outside ${canonicalParent}`)
  }
  if (!/^hvir-smoke\.[A-Za-z0-9]+$/.test(basename(root))) {
    throw new Error('Refusing stale smoke cleanup for an unexpected root name')
  }
  const rootStat = await lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Refusing stale smoke cleanup for a non-directory root')
  }
  const marker = join(root, SMOKE_OWNERSHIP_MARKER)
  const markerStat = await lstat(marker)
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
    throw new Error('Refusing stale smoke cleanup without a regular ownership marker')
  }
  if ((await readFile(marker, 'utf8')) !== SMOKE_OWNERSHIP_MARKER_VALUE) {
    throw new Error('Refusing stale smoke cleanup with an invalid ownership marker')
  }
  await rm(root, { recursive: true })
}

export function parseSmokeCheckpointLine(line: string): CheckpointRecord | undefined {
  if (!line.startsWith(CHECKPOINT_PREFIX)) return undefined
  const value: unknown = JSON.parse(line.slice(CHECKPOINT_PREFIX.length))
  if (
    !isRecord(value) ||
    value.schema !== 1 ||
    !isSmokeInterruptionUuid(value.runToken)
  ) {
    throw new Error('Invalid smoke checkpoint envelope')
  }
  const name = value.name
  if (name === 'profile-pty-ready') {
    requireKeys(value, [
      'name',
      'predecessorProfileObserved',
      'profileCount',
      'ptyCount',
      'runToken',
      'schema',
    ])
    requireCount(value.profileCount, 'profileCount')
    requireCount(value.ptyCount, 'ptyCount')
    requireBoolean(value.predecessorProfileObserved, 'predecessorProfileObserved')
  } else if (name === 'renderer-watch-ready') {
    requireKeys(value, [
      'name',
      'ownerGeneration',
      'predecessorSelectionObserved',
      'runToken',
      'schema',
      'watcherActive',
    ])
    requireCount(value.ownerGeneration, 'ownerGeneration')
    requireBoolean(value.watcherActive, 'watcherActive')
    requireBoolean(value.predecessorSelectionObserved, 'predecessorSelectionObserved')
  } else if (name === 'web-route-ready') {
    requireKeys(value, [
      'loopbackPort',
      'name',
      'ownerGeneration',
      'paneId',
      'predecessorRouteObserved',
      'predecessorSelectionObserved',
      'ptyCount',
      'routeOpen',
      'runToken',
      'schema',
    ])
    requireCount(value.ownerGeneration, 'ownerGeneration')
    requireCount(value.ptyCount, 'ptyCount')
    requirePort(value.loopbackPort)
    if (!isSmokeInterruptionUuid(value.paneId)) {
      throw new Error('Invalid checkpoint paneId')
    }
    requireBoolean(value.routeOpen, 'routeOpen')
    requireBoolean(value.predecessorRouteObserved, 'predecessorRouteObserved')
    requireBoolean(value.predecessorSelectionObserved, 'predecessorSelectionObserved')
  } else {
    throw new Error('Unknown smoke checkpoint record')
  }
  return value as unknown as CheckpointRecord
}

async function main(): Promise<void> {
  if (process.platform === 'win32') {
    throw new Error('Smoke interruption isolation requires POSIX process groups')
  }
  const temporaryParent = await realpath(tmpdir())
  const liveHandles = new Set<InvocationHandle>()
  const observedRoots = new Set<string>()
  let forceKilledRoot: string | undefined
  try {
    const failedPty = await controlledPredecessor(
      {
        scenario: 'pty-native',
        checkpoint: 'profile-pty-ready',
        action: 'fail',
      },
      liveHandles,
    )
    observedRoots.add(failedPty.root)
    assertOutcome(failedPty, 1, null)
    assertTailContains(failedPty, 'Controlled smoke failure at checkpoint')
    assertOrderedResources(failedPty.disposed, [
      'PTY supervisor',
      'harness profile fixture',
      'local host',
    ])
    await waitForMissing(failedPty.root)
    await waitForProcessGroupGone(failedPty.pid)

    const additionalSignals = [
      ['SIGHUP', 129],
      ['SIGINT', 130],
    ] as const
    for (const [signal, exitCode] of additionalSignals) {
      const interruptedPty = await signalledPredecessor(
        {
          scenario: 'pty-native',
          checkpoint: 'profile-pty-ready',
          action: 'pause',
        },
        signal,
        liveHandles,
      )
      observedRoots.add(interruptedPty.root)
      assertOutcome(interruptedPty, exitCode, null)
      assertTailContains(interruptedPty, 'Smoke interrupted by SIGTERM')
      assertOrderedResources(interruptedPty.disposed, [
        'PTY supervisor',
        'harness profile fixture',
        'local host',
      ])
      await waitForMissing(interruptedPty.root)
      await waitForProcessGroupGone(interruptedPty.pid)
    }

    const interruptedGit = await signalledPredecessor(
      {
        scenario: 'git-workflow',
        checkpoint: 'renderer-watch-ready',
        action: 'pause',
      },
      'SIGTERM',
      liveHandles,
    )
    observedRoots.add(interruptedGit.root)
    assertOutcome(interruptedGit, 143, null)
    assertTailContains(interruptedGit, 'Smoke interrupted by SIGTERM')
    assertOrderedResources(interruptedGit.disposed, [
      'IPC authority router',
      'smoke window',
      'supervised terminals',
      'project watch',
      'local host',
    ])
    await waitForMissing(interruptedGit.root)
    await waitForProcessGroupGone(interruptedGit.pid)

    const killedWeb = await forceKilledPredecessor(
      {
        scenario: 'web-pane',
        checkpoint: 'web-route-ready',
        action: 'pause',
      },
      liveHandles,
    )
    observedRoots.add(killedWeb.root)
    forceKilledRoot = killedWeb.root
    if (killedWeb.outcome.signal !== 'SIGKILL') {
      throw processFailure(killedWeb, 'force-killed predecessor did not report SIGKILL')
    }
    if (killedWeb.disposed.length !== 0) {
      throw processFailure(killedWeb, 'SIGKILL incorrectly claimed in-process cleanup')
    }
    await waitForProcessGroupGone(killedWeb.pid)
    if (killedWeb.checkpoint.name !== 'web-route-ready') {
      throw processFailure(killedWeb, 'web predecessor reached the wrong checkpoint')
    }
    await waitForPortClosed(killedWeb.checkpoint.loopbackPort)
    await validateOwnedSmokeRoot(killedWeb.root, temporaryParent)

    const predecessors = [failedPty, interruptedGit, killedWeb] as const
    const successors = await Promise.all(
      predecessors.map(async (predecessor) => {
        const handle = startInvocation({
          scenario: predecessor.scenario,
          checkpoint: predecessor.checkpoint.name,
          action: 'observe',
          predecessorToken: predecessor.runToken,
          ...(predecessor.checkpoint.name === 'web-route-ready'
            ? { predecessorPaneId: predecessor.checkpoint.paneId }
            : {}),
        })
        liveHandles.add(handle)
        try {
          return await collectInvocation(handle)
        } finally {
          liveHandles.delete(handle)
        }
      }),
    )
    for (const successor of successors) {
      if (observedRoots.has(successor.root)) {
        throw processFailure(successor, 'successor reused a predecessor root')
      }
      observedRoots.add(successor.root)
      assertOutcome(successor, 0, null)
      assertSuccessorIsolation(successor)
      await waitForMissing(successor.root)
    }
    if (observedRoots.size !== 5 + successors.length) {
      throw new Error('Smoke interruption proof reused an invocation root')
    }

    await cleanupOwnedSmokeRoot(killedWeb.root, temporaryParent)
    forceKilledRoot = undefined
    await waitForMissing(killedWeb.root)
    console.log(
      '[smoke:isolation:summary] failure + HUP/INT/TERM/KILL predecessors + 3 parallel clean successors passed',
    )
  } finally {
    for (const handle of liveHandles) handle.killGroup('SIGKILL')
    if (forceKilledRoot) {
      await cleanupOwnedSmokeRoot(forceKilledRoot, temporaryParent).catch((error) =>
        console.error('[smoke:isolation:cleanup-fail]', error),
      )
    }
  }
}

async function controlledPredecessor(
  options: InvocationOptions,
  liveHandles: Set<InvocationHandle>,
): Promise<InvocationResult> {
  const handle = startInvocation(options)
  liveHandles.add(handle)
  try {
    return await collectInvocation(handle)
  } finally {
    liveHandles.delete(handle)
  }
}

async function signalledPredecessor(
  options: InvocationOptions,
  signal: NodeJS.Signals,
  liveHandles: Set<InvocationHandle>,
): Promise<InvocationResult> {
  const handle = startInvocation(options)
  liveHandles.add(handle)
  try {
    await Promise.all([handle.root, handle.checkpoint])
    handle.signal(signal)
    return await collectInvocation(handle)
  } finally {
    liveHandles.delete(handle)
  }
}

async function forceKilledPredecessor(
  options: InvocationOptions,
  liveHandles: Set<InvocationHandle>,
): Promise<InvocationResult> {
  const handle = startInvocation(options)
  liveHandles.add(handle)
  try {
    await Promise.all([handle.root, handle.checkpoint])
    handle.killGroup('SIGKILL')
    return await collectInvocation(handle)
  } finally {
    liveHandles.delete(handle)
  }
}

function startInvocation(options: InvocationOptions): InvocationHandle {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const runToken = randomUUID()
  const root = deferred<string>()
  const checkpoint = deferred<CheckpointRecord>()
  const disposed: string[] = []
  const tail: string[] = []
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HVIR_SMOKE_SCENARIO: options.scenario,
    HVIR_SMOKE_ISOLATION_RUN: runToken,
    HVIR_SMOKE_ISOLATION_CHECKPOINT: options.checkpoint,
    HVIR_SMOKE_ISOLATION_ACTION: options.action,
    ...(options.predecessorToken
      ? { HVIR_SMOKE_ISOLATION_PREDECESSOR: options.predecessorToken }
      : {}),
    ...(options.predecessorPaneId
      ? { HVIR_SMOKE_ISOLATION_PREDECESSOR_PANE: options.predecessorPaneId }
      : {}),
  }
  delete environment.HVIR_SMOKE_REPEAT
  const child = spawn('bash', [join(repositoryRoot, 'scripts/run-smoke.sh')], {
    cwd: repositoryRoot,
    detached: true,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (!child.pid || !child.stdout || !child.stderr) {
    throw new Error(`Failed to start isolated ${options.scenario} process`)
  }
  const outcome = new Promise<ProcessOutcome>((resolveOutcome, rejectOutcome) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const rejectInvocation = (reason: unknown): void => {
      if (settled) return
      settled = true
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      const error = reason instanceof Error ? reason : new Error(String(reason))
      root.reject(error)
      checkpoint.reject(error)
      killProcessGroup(child.pid!, 'SIGKILL')
      rejectOutcome(error)
    }
    const consume = (line: string): void => {
      try {
        tail.push(line.slice(0, 500))
        if (tail.length > MAX_TAIL_LINES) tail.shift()
        const ownedRoot = parseOwnedRootLine(line, runToken)
        if (ownedRoot) root.resolve(ownedRoot)
        const checkpointRecord = parseSmokeCheckpointLine(line)
        if (checkpointRecord) {
          if (checkpointRecord.runToken !== runToken) {
            rejectInvocation(
              new Error('Smoke checkpoint token did not match its process'),
            )
          } else {
            checkpoint.resolve(checkpointRecord)
          }
        }
        const disposedResource = parseDisposedLine(line, runToken)
        if (disposedResource) disposed.push(disposedResource)
      } catch (error) {
        rejectInvocation(error)
      }
    }
    createInterface({ input: child.stdout }).on('line', consume)
    createInterface({ input: child.stderr }).on('line', consume)
    timer = setTimeout(
      () => rejectInvocation(isolationProcessTimeoutError(options.scenario, tail)),
      PROCESS_TIMEOUT_MS,
    )
    child.once('error', (error) => {
      rejectInvocation(error)
    })
    child.once('close', (exitCode, signal) => {
      if (settled) return
      settled = true
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      const early = new Error(
        `${options.scenario} exited before emitting required isolation evidence`,
      )
      root.reject(early)
      checkpoint.reject(early)
      resolveOutcome({ exitCode, signal })
    })
  })
  void root.promise.catch(() => undefined)
  void checkpoint.promise.catch(() => undefined)
  void outcome.catch(() => undefined)
  return {
    scenario: options.scenario,
    runToken,
    pid: child.pid,
    root: root.promise,
    checkpoint: checkpoint.promise,
    outcome,
    disposed,
    tail,
    signal: (signal) => child.kill(signal),
    killGroup: (signal) => killProcessGroup(child.pid!, signal),
  }
}

async function collectInvocation(handle: InvocationHandle): Promise<InvocationResult> {
  const [root, checkpoint, outcome] = await Promise.all([
    handle.root,
    handle.checkpoint,
    handle.outcome,
  ])
  return {
    scenario: handle.scenario,
    runToken: handle.runToken,
    pid: handle.pid,
    root,
    checkpoint,
    outcome,
    disposed: [...handle.disposed],
    tail: [...handle.tail],
  }
}

async function validateOwnedSmokeRoot(
  root: string,
  temporaryParent: string,
): Promise<void> {
  const marker = join(root, SMOKE_OWNERSHIP_MARKER)
  const markerValue = await readFile(marker, 'utf8')
  if (dirname(root) !== temporaryParent || markerValue !== SMOKE_OWNERSHIP_MARKER_VALUE) {
    throw new Error('Force-killed smoke left an invalid owned root')
  }
}

function parseOwnedRootLine(line: string, runToken: string): string | undefined {
  if (!line.startsWith(ROOT_PREFIX)) return undefined
  const [reportedToken, root, extra] = line.slice(ROOT_PREFIX.length).split('\t')
  if (reportedToken !== runToken || !root || extra !== undefined) {
    throw new Error('Invalid owned-root evidence')
  }
  return root
}

function parseDisposedLine(line: string, runToken: string): string | undefined {
  if (!line.startsWith(DISPOSED_PREFIX)) return undefined
  const value: unknown = JSON.parse(line.slice(DISPOSED_PREFIX.length))
  if (
    !isRecord(value) ||
    value.schema !== 1 ||
    value.runToken !== runToken ||
    typeof value.resource !== 'string' ||
    value.resource.length < 1 ||
    value.resource.length > 80 ||
    Object.keys(value).sort().join(',') !== 'resource,runToken,schema'
  ) {
    throw new Error('Invalid smoke disposal evidence')
  }
  return value.resource
}

function assertSuccessorIsolation(result: InvocationResult): void {
  const checkpoint = result.checkpoint
  if (checkpoint.name === 'profile-pty-ready') {
    if (checkpoint.predecessorProfileObserved || checkpoint.ptyCount !== 1) {
      throw processFailure(result, 'clean PTY successor observed predecessor state')
    }
    return
  }
  if (checkpoint.name === 'renderer-watch-ready') {
    if (checkpoint.predecessorSelectionObserved || !checkpoint.watcherActive) {
      throw processFailure(result, 'clean renderer successor observed predecessor state')
    }
  } else {
    if (
      checkpoint.predecessorSelectionObserved ||
      checkpoint.predecessorRouteObserved ||
      !checkpoint.routeOpen ||
      checkpoint.ptyCount !== 1
    ) {
      throw processFailure(result, 'clean web successor observed predecessor authority')
    }
  }
}

function assertOutcome(
  result: InvocationResult,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
): void {
  if (result.outcome.exitCode !== exitCode || result.outcome.signal !== signal) {
    throw processFailure(
      result,
      `expected exit=${String(exitCode)} signal=${String(signal)}, received ` +
        `exit=${String(result.outcome.exitCode)} signal=${String(result.outcome.signal)}`,
    )
  }
}

function assertTailContains(result: InvocationResult, expected: string): void {
  if (!result.tail.some((line) => line.includes(expected))) {
    throw processFailure(result, `missing bounded failure evidence: ${expected}`)
  }
}

function assertOrderedResources(
  disposed: readonly string[],
  expected: readonly string[],
): void {
  let prior = -1
  for (const resource of expected) {
    const index = disposed.indexOf(resource)
    if (index <= prior) {
      throw new Error(
        `Smoke cleanup order omitted ${resource}: ${JSON.stringify(disposed)}`,
      )
    }
    prior = index
  }
}

async function waitForMissing(path: string): Promise<void> {
  await waitFor(async () => {
    try {
      await lstat(path)
      return false
    } catch (error) {
      return isMissing(error)
    }
  }, `Owned smoke root remained after cleanup: ${path}`)
}

async function waitForPortClosed(port: number): Promise<void> {
  await waitFor(
    async () => !(await canConnect(port)),
    `Force-killed loopback server remained reachable on port ${port}`,
  )
}

async function waitForProcessGroupGone(pid: number): Promise<void> {
  await waitFor(
    () => !processGroupExists(pid),
    `Smoke process group ${pid} remained live`,
  )
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    if (isMissingProcess(error)) return false
    throw error
  }
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolveConnection) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const finish = (connected: boolean): void => {
      socket.destroy()
      resolveConnection(connected)
    }
    socket.setTimeout(250, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25))
  }
}

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if (!isMissingProcess(error)) throw error
  }
}

function processFailure(result: InvocationResult, message: string): Error {
  return new Error(
    `${result.scenario}: ${message}; tail=${JSON.stringify(result.tail.slice(-20))}`,
  )
}

function requireKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) {
    throw new Error('Smoke checkpoint contained unreviewed fields')
  }
}

function requireCount(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Invalid checkpoint ${name}`)
  }
}

function requirePort(value: unknown): asserts value is number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > 65535
  ) {
    throw new Error('Invalid checkpoint loopbackPort')
  }
}

function requireBoolean(value: unknown, name: string): asserts value is boolean {
  if (typeof value !== 'boolean') throw new Error(`Invalid checkpoint ${name}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

function isMissingProcess(error: unknown): boolean {
  return isRecord(error) && error.code === 'ESRCH'
}

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
} {
  let settled = false
  let resolvePromise: (value: T) => void = () => undefined
  let rejectPromise: (error: unknown) => void = () => undefined
  const promise = new Promise<T>((resolveDeferred, rejectDeferred) => {
    resolvePromise = resolveDeferred
    rejectPromise = rejectDeferred
  })
  return {
    promise,
    resolve: (value) => {
      if (settled) return
      settled = true
      resolvePromise(value)
    },
    reject: (error) => {
      if (settled) return
      settled = true
      rejectPromise(error)
    },
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error('[smoke:isolation:fail]', error)
    process.exitCode = 1
  })
}
