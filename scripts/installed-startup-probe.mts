import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { exerciseInstalledHarnessDialogs } from './installed-harness-dialog-probe.mts'

const execFileAsync = promisify(execFile)
const STARTUP_TIMEOUT_MS = 30_000
const SHUTDOWN_TIMEOUT_MS = 10_000
const OBSERVATION_POLL_MS = 100
const SMOKE_SIDE_EFFECTS = [
  '.hvir-smoke-native-profile.json',
  '.hvir-smoke-login-shell',
] as const

export interface ProcessRecord {
  readonly pid: number
  readonly parentPid: number
  readonly processGroupId: number
  readonly state: string
  readonly command: string
}

export interface InstalledStartupObservation {
  readonly ready: boolean
  readonly main: 'live' | 'missing' | 'unexpected' | 'zombie'
  readonly renderer: 'live' | 'missing'
}

export function parseProcessTable(output: string): readonly ProcessRecord[] {
  return output
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      processGroupId: Number(match[3]),
      state: match[4]!,
      command: match[5]!,
    }))
}

export function processDescendants(
  processes: readonly ProcessRecord[],
  rootPid: number,
): readonly ProcessRecord[] {
  const ownedPids = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const process of processes) {
      if (ownedPids.has(process.parentPid) && !ownedPids.has(process.pid)) {
        ownedPids.add(process.pid)
        changed = true
      }
    }
  }
  return processes.filter(
    (process) => process.pid !== rootPid && ownedPids.has(process.pid),
  )
}

export function installedStartupReady(
  processes: readonly ProcessRecord[],
  rootPid: number,
  expectedMain: string,
): boolean {
  return observeInstalledStartup(processes, rootPid, expectedMain).ready
}

export function observeInstalledStartup(
  processes: readonly ProcessRecord[],
  rootPid: number,
  expectedMain: string,
): InstalledStartupObservation {
  const main = processes.find((process) => process.pid === rootPid)
  const mainState = !main
    ? 'missing'
    : main.state.includes('Z')
      ? 'zombie'
      : main.command !== expectedMain && !main.command.startsWith(`${expectedMain} `)
        ? 'unexpected'
        : 'live'
  const rendererState = processDescendants(processes, rootPid).some(
    (process) =>
      !process.state.includes('Z') && process.command.includes('--type=renderer'),
  )
    ? 'live'
    : 'missing'
  return {
    ready: mainState === 'live' && rendererState === 'live',
    main: mainState,
    renderer: rendererState,
  }
}

async function processTable(): Promise<readonly ProcessRecord[]> {
  const { stdout } = await execFileAsync('/bin/ps', [
    '-axo',
    'pid=,ppid=,pgid=,stat=,command=',
  ])
  return parseProcessTable(stdout)
}

async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs
  do {
    if (await condition()) return true
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, OBSERVATION_POLL_MS))
  } while (performance.now() < deadline)
  return false
}

export async function runWithInstalledStartupLiveness<T>(
  operation: () => Promise<T>,
  assertAlive: () => Promise<void>,
  pollMs = OBSERVATION_POLL_MS,
): Promise<T> {
  await assertAlive()
  return await new Promise<T>((resolveOperation, rejectOperation) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const settle = (complete: () => void): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      complete()
    }
    const observe = async (): Promise<void> => {
      try {
        await assertAlive()
      } catch (error) {
        settle(() => rejectOperation(probeError(error)))
        return
      }
      if (!settled) timer = setTimeout(() => void observe(), pollMs)
    }
    timer = setTimeout(() => void observe(), pollMs)
    void Promise.resolve()
      .then(operation)
      .then(
        (result) => settle(() => resolveOperation(result)),
        (error: unknown) => settle(() => rejectOperation(probeError(error))),
      )
  })
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

function probeError(reason: unknown): Error {
  if (reason instanceof Error) return reason
  return new Error(typeof reason === 'string' ? reason : 'Installed startup probe failed')
}

async function processGroupExists(processGroupId: number): Promise<boolean> {
  return (await processTable()).some(
    (process) =>
      process.processGroupId === processGroupId && !process.state.includes('Z'),
  )
}

async function stopProcessGroup(
  child: ChildProcess,
  signal: NodeJS.Signals,
  timeoutMs: number,
  requireLiveGroup = false,
  onSignalled?: () => void,
): Promise<void> {
  if (!child.pid) {
    if (requireLiveGroup) {
      throw new Error(`Installed hvir did not remain live for deliberate ${signal}`)
    }
    return
  }
  const signalled = signalProcessGroup(child.pid, signal)
  if (!signalled) {
    if (requireLiveGroup) {
      throw new Error(`Installed hvir exited before deliberate ${signal}`)
    }
    return
  }
  onSignalled?.()
  if (
    !(await waitFor(
      () => processGroupExists(child.pid!).then((exists) => !exists),
      timeoutMs,
    ))
  ) {
    throw new Error(`Installed hvir process group survived ${signal}`)
  }
}

interface StartupProbeOptions {
  readonly command: string
  readonly expectedMain: string
  readonly projectRoot: string
  readonly runtimeRoot: string
  readonly path: string
  readonly exerciseHarnessDialogs: boolean
  readonly disableGpu: boolean
}

interface ChildExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

function observedChildExit(
  child: ChildProcess,
  exit: ChildExit | null,
): ChildExit | null {
  if (exit) return exit
  if (child.exitCode === null && child.signalCode === null) return null
  return { code: child.exitCode, signal: child.signalCode }
}

function describeChildExit(exit: ChildExit | null): string {
  if (!exit) return 'child running'
  if (exit.code !== null) return `child exited with code ${exit.code}`
  return `child exited from ${exit.signal ?? 'an unknown signal'}`
}

function describeObservation(observation: InstalledStartupObservation): string {
  return `main ${observation.main}; renderer ${observation.renderer}`
}

async function runInstalledStartupProbe(options: StartupProbeOptions): Promise<void> {
  if (existsSync(options.runtimeRoot)) {
    throw new Error(`Installed startup root already exists: ${options.runtimeRoot}`)
  }
  const homeRoot = join(options.runtimeRoot, 'home')
  const configRoot = join(options.runtimeRoot, 'config')
  const cacheRoot = join(options.runtimeRoot, 'cache')
  const userDataRoot = join(options.runtimeRoot, 'user-data')
  mkdirSync(homeRoot, { recursive: true })
  mkdirSync(configRoot)
  mkdirSync(cacheRoot)
  mkdirSync(userDataRoot)
  const providerBin = options.exerciseHarnessDialogs
    ? createHarnessProbeFixture(homeRoot)
    : undefined

  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeRoot,
    PATH: providerBin ? `${providerBin}:${options.path}` : options.path,
    HVIR_SMOKE: '1',
    HVIR_SMOKE_SCENARIO: 'pty-native',
    ...(process.platform === 'linux'
      ? { XDG_CONFIG_HOME: configRoot, XDG_CACHE_HOME: cacheRoot }
      : {}),
  }
  for (const name of [
    'ELECTRON_RENDERER_URL',
    'ELECTRON_RUN_AS_NODE',
    'NODE_OPTIONS',
    'NODE_PATH',
  ]) {
    delete environment[name]
  }

  const child = spawn(
    options.command,
    [
      '.',
      `--user-data-dir=${userDataRoot}`,
      ...(options.disableGpu ? ['--disable-gpu'] : []),
      ...(options.exerciseHarnessDialogs
        ? ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0']
        : []),
    ],
    {
      cwd: options.projectRoot,
      detached: true,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let appOutput = ''
  let childExit: ChildExit | null = null
  let spawnFailure: Error | undefined
  child.once('error', (error) => {
    spawnFailure = error
  })
  const observe = (chunk: Buffer): void => {
    const text = chunk.toString('utf8')
    appOutput = `${appOutput}${text}`.slice(-4_096)
    process.stderr.write(text)
  }
  child.stdout?.on('data', observe)
  child.stderr?.on('data', observe)
  child.once('exit', (code, signal) => {
    childExit = { code, signal }
  })
  let interruptedBy: NodeJS.Signals | null = null
  const interruptHandlers = new Map<NodeJS.Signals, () => void>()
  for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM'] as const) {
    const handler = (): void => {
      interruptedBy = signal
      if (child.pid) void signalProcessGroup(child.pid, 'SIGTERM')
    }
    interruptHandlers.set(signal, handler)
    process.once(signal, handler)
  }

  let failure: Error | undefined
  let deliberateShutdownStarted = false
  try {
    if (!child.pid) throw new Error('Installed hvir did not expose a process id')
    let lastObservation: InstalledStartupObservation | undefined
    const observeInstalledProcess = async (): Promise<InstalledStartupObservation> => {
      lastObservation = observeInstalledStartup(
        await processTable(),
        child.pid!,
        options.expectedMain,
      )
      return lastObservation
    }
    const assertInstalledProcessAlive = async (): Promise<void> => {
      if (interruptedBy) {
        throw new Error(`Installed startup interrupted by ${interruptedBy}`)
      }
      if (spawnFailure) throw spawnFailure
      const exit = observedChildExit(child, childExit)
      if (exit) {
        throw new Error(
          `Installed hvir ${describeChildExit(exit)} before deliberate shutdown`,
        )
      }
      const observation = await observeInstalledProcess()
      if (!observation.ready) {
        throw new Error(
          `Installed hvir lost ordinary startup liveness before deliberate shutdown (${describeObservation(observation)})`,
        )
      }
    }
    const ready = await waitFor(async () => {
      if (interruptedBy)
        throw new Error(`Installed startup interrupted by ${interruptedBy}`)
      if (spawnFailure) throw spawnFailure
      if (childExit) return false
      return (await observeInstalledProcess()).ready
    }, STARTUP_TIMEOUT_MS)
    if (!ready) {
      const exit = observedChildExit(child, childExit)
      const outcome = exit
        ? describeChildExit(exit)
        : `did not expose a live renderer (${describeObservation(
            lastObservation ?? (await observeInstalledProcess()),
          )})`
      throw new Error(`Installed hvir ordinary startup ${outcome}`)
    }
    if (options.exerciseHarnessDialogs) {
      const evidence = await runWithInstalledStartupLiveness(
        () =>
          exerciseInstalledHarnessDialogs(() =>
            Promise.resolve(
              readFileSync(join(userDataRoot, 'DevToolsActivePort'), 'utf8'),
            ),
          ),
        assertInstalledProcessAlive,
      )
      console.log(`Installed harness dialogs OK (${evidence})`)
    }
    await assertInstalledProcessAlive()
    await stopProcessGroup(child, 'SIGTERM', SHUTDOWN_TIMEOUT_MS, true, () => {
      deliberateShutdownStarted = true
    })
    if (appOutput.includes('HVIR_SMOKE_OK')) {
      throw new Error('Installed hvir entered the smoke runner')
    }
    const smokeSideEffect = SMOKE_SIDE_EFFECTS.find((path) =>
      existsSync(join(options.projectRoot, path)),
    )
    if (smokeSideEffect) {
      throw new Error(`Installed hvir created smoke side effect ${smokeSideEffect}`)
    }
    console.log(
      'Observed package-owned main + live renderer; smoke activation stayed absent; process group stopped.',
    )
  } catch (error) {
    const original = probeError(error)
    let diagnostic = describeChildExit(observedChildExit(child, childExit))
    if (child.pid) {
      try {
        diagnostic = `${diagnostic}; ${describeObservation(
          observeInstalledStartup(await processTable(), child.pid, options.expectedMain),
        )}`
      } catch {
        diagnostic = `${diagnostic}; process table unavailable`
      }
    }
    failure = new Error(
      `${original.message}; installed process status ${deliberateShutdownStarted ? 'after' : 'before'} deliberate shutdown began: ${diagnostic}`,
      { cause: original },
    )
  } finally {
    for (const [signal, handler] of interruptHandlers) {
      process.off(signal, handler)
    }
    if (child.pid && (await processGroupExists(child.pid))) {
      try {
        await stopProcessGroup(child, 'SIGKILL', SHUTDOWN_TIMEOUT_MS)
      } catch (cleanupError) {
        if (!failure) failure = probeError(cleanupError)
        else
          console.error(
            'Installed startup cleanup failed after the original acceptance failure.',
          )
      }
    }
  }
  if (failure) throw failure
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      command: { type: 'string' },
      'expected-main': { type: 'string' },
      'project-root': { type: 'string' },
      'runtime-root': { type: 'string' },
      path: { type: 'string' },
      'exercise-harness-dialogs': { type: 'boolean' },
      'disable-gpu': { type: 'boolean' },
    },
    strict: true,
  })
  if (
    !values.command ||
    !values['expected-main'] ||
    !values['project-root'] ||
    !values['runtime-root'] ||
    !values.path
  ) {
    throw new Error(
      '--command, --expected-main, --project-root, --runtime-root, and --path are required',
    )
  }
  await runInstalledStartupProbe({
    command: resolve(values.command),
    expectedMain: resolve(values['expected-main']),
    projectRoot: resolve(values['project-root']),
    runtimeRoot: resolve(values['runtime-root']),
    path: values.path,
    exerciseHarnessDialogs: values['exercise-harness-dialogs'] === true,
    disableGpu: values['disable-gpu'] === true,
  })
}

function createHarnessProbeFixture(homeRoot: string): string {
  const providerBin = join(homeRoot, 'provider-bin')
  mkdirSync(providerBin)
  writeFileSync(
    join(homeRoot, '.bash_profile'),
    'export PATH="$HOME/provider-bin:/usr/sbin:/usr/bin:/sbin:/bin"\n',
  )
  const executable = join(providerBin, 'claude')
  writeFileSync(
    executable,
    '#!/bin/sh\nif [ "${1:-}" = "--version" ]; then\n  sleep 2\n  printf "claude 9.9.9\\n"\nfi\n',
  )
  chmodSync(executable, 0o755)
  return providerBin
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
