import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

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
  const main = processes.find((process) => process.pid === rootPid)
  if (
    !main ||
    main.state.includes('Z') ||
    (main.command !== expectedMain && !main.command.startsWith(`${expectedMain} `))
  ) {
    return false
  }
  return processDescendants(processes, rootPid).some(
    (process) =>
      !process.state.includes('Z') && process.command.includes('--type=renderer'),
  )
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

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
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
): Promise<void> {
  if (!child.pid) return
  signalProcessGroup(child.pid, signal)
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

  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeRoot,
    PATH: options.path,
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

  const child = spawn(options.command, ['.', `--user-data-dir=${userDataRoot}`], {
    cwd: options.projectRoot,
    detached: true,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let appOutput = ''
  let childExit: {
    readonly code: number | null
    readonly signal: NodeJS.Signals | null
  } | null = null
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
  child.once('close', (code, signal) => {
    childExit = { code, signal }
  })
  let interruptedBy: NodeJS.Signals | null = null
  const interruptHandlers = new Map<NodeJS.Signals, () => void>()
  for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM'] as const) {
    const handler = (): void => {
      interruptedBy = signal
      if (child.pid) signalProcessGroup(child.pid, 'SIGTERM')
    }
    interruptHandlers.set(signal, handler)
    process.once(signal, handler)
  }

  let failure: Error | undefined
  try {
    if (!child.pid) throw new Error('Installed hvir did not expose a process id')
    const ready = await waitFor(async () => {
      if (interruptedBy)
        throw new Error(`Installed startup interrupted by ${interruptedBy}`)
      if (spawnFailure) throw spawnFailure
      if (childExit) return false
      return installedStartupReady(await processTable(), child.pid!, options.expectedMain)
    }, STARTUP_TIMEOUT_MS)
    if (!ready) {
      const observedExit = childExit as {
        readonly code: number | null
        readonly signal: NodeJS.Signals | null
      } | null
      const outcome = observedExit
        ? `exited (${observedExit.code ?? observedExit.signal ?? 'unknown'})`
        : 'did not expose a live renderer'
      throw new Error(`Installed hvir ordinary startup ${outcome}`)
    }
    await stopProcessGroup(child, 'SIGTERM', SHUTDOWN_TIMEOUT_MS)
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
    failure = probeError(error)
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
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
