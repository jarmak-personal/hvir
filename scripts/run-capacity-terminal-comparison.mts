import { randomUUID, createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, stat, writeFile, lstat, readdir, open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  invokeSmokeScenario,
  registerSmokeLauncherSignals,
  type SmokeScenarioInvocationOptions,
} from './run-smoke-scenarios.mts'
import { withSmokeRunLock } from './smoke-run-lock.mts'
import { verifyArtifact } from './native-terminal/artifacts.mts'
import {
  CAPACITY_TERMINAL_COMPARISON_ORDER,
  evaluateCapacityTerminalComparison,
  type CapacityTerminalComparisonEngine,
  type CapacityTerminalProcessResult,
} from '../src/main/smoke/capacity-terminal-comparison.ts'

export interface CapacityComparisonArguments {
  readonly output: string
  readonly nativeLibrary: string
  readonly refreshHz: number
}
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const forbiddenSelectors = [
  'HVIR_NATIVE_IMPORT_DIAGNOSTICS',
  'HVIR_NATIVE_IMPORT_DIAGNOSTIC_WINDOW',
  'HVIR_NATIVE_TERMINAL_TRACE_CONFIG',
  'HVIR_CAPACITY_OBSERVATION',
  'HVIR_NATIVE_TERMINAL',
  'NODE_OPTIONS',
  'ELECTRON_RUN_AS_NODE',
  'HVIR_DEVTOOLS',
  'HVIR_CDP_PORT',
  'HVIR_REMOTE_DEBUGGING_PORT',
  'ELECTRON_REMOTE_DEBUGGING_PORT',
]

function fail(code: string): never {
  throw new Error(code)
}

export function parseCapacityComparisonArguments(
  args: readonly string[],
): CapacityComparisonArguments {
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!
    const value = args[index + 1]
    if (
      !['--output', '--native-library', '--refresh-hz'].includes(key) ||
      value === undefined ||
      values.has(key)
    )
      fail('invalid-arguments')
    values.set(key, value)
  }
  const output = values.get('--output') ?? ''
  const nativeLibrary = values.get('--native-library') ?? ''
  const refresh = values.get('--refresh-hz') ?? ''
  const refreshHz = Number(refresh)
  if (
    !isAbsolute(output) ||
    !isAbsolute(nativeLibrary) ||
    !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(refresh) ||
    !Number.isFinite(refreshHz) ||
    refreshHz <= 0
  )
    fail('invalid-arguments')
  return { output, nativeLibrary, refreshHz }
}

export function capacityComparisonEnvironment(
  environment: NodeJS.ProcessEnv,
  options: CapacityComparisonArguments,
  runId: string,
  index: number,
): NodeJS.ProcessEnv {
  if (!Number.isInteger(index) || index < 0 || index >= 8) fail('invalid-process-index')
  if (forbiddenSelectors.some((key) => environment[key] !== undefined))
    fail('diagnostic-selector-present')
  if (
    environment.HVIR_NATIVE_TERMINAL_PRESENTATION !== undefined &&
    environment.HVIR_NATIVE_TERMINAL_PRESENTATION !== 'auto'
  )
    fail('invalid-presentation-selector')
  if (
    environment.HVIR_NATIVE_TERMINAL_OZONE !== undefined &&
    !['x11', 'wayland'].includes(environment.HVIR_NATIVE_TERMINAL_OZONE)
  )
    fail('invalid-ozone-selector')
  const child = { ...environment }
  for (const key of Object.keys(child)) {
    if (key.startsWith('HVIR_CAPACITY_COMPARISON_')) delete child[key]
  }
  delete child.HVIR_NATIVE_TERMINAL_LIBRARY
  delete child.HVIR_SMOKE_REPEAT
  delete child.HVIR_SMOKE_SCENARIO
  delete child.HVIR_SMOKE_ARTIFACT_DIR
  if (CAPACITY_TERMINAL_COMPARISON_ORDER[index] === 'native')
    child.HVIR_NATIVE_TERMINAL_LIBRARY = options.nativeLibrary
  return {
    ...child,
    HVIR_NATIVE_TERMINAL_PRESENTATION: 'auto',
    HVIR_CAPACITY_PERFORMANCE_GATE: 'controlled',
    HVIR_CAPACITY_COMPARISON_RUN_ID: runId,
    HVIR_CAPACITY_COMPARISON_INDEX: String(index),
    HVIR_CAPACITY_COMPARISON_RESULT: join(options.output, `process-${index}.json`),
    HVIR_CAPACITY_COMPARISON_REFRESH_HZ: String(options.refreshHz),
  }
}

type ChildOutcome = Awaited<ReturnType<typeof invokeSmokeScenario>>
interface InvocationSlot {
  readonly index: number
  readonly pair: number
  readonly engine: CapacityTerminalComparisonEngine
  status: 'pending' | 'running' | 'completed'
  outcome?: {
    readonly status: ChildOutcome['status']
    readonly exitCode?: number
    readonly signal?: NodeJS.Signals
    readonly durationMs?: number
    readonly failureEvidence?: ChildOutcome['failureEvidence']
    readonly failure?: 'child-failed' | 'child-invocation-failed'
  }
}
interface ComparisonRunOptions extends CapacityComparisonArguments {
  readonly sourceIdentity?: Awaited<ReturnType<typeof sourceIdentity>>
  readonly environment?: NodeJS.ProcessEnv
  readonly cwd?: string
  readonly interruptionSignal?: AbortSignal
  readonly registerSignalEscalation?: SmokeScenarioInvocationOptions['registerSignalEscalation']
}

/** Own scheduling and files here; process creation, containment and cleanup stay with smoke. */
export async function runCapacityTerminalComparison(
  options: ComparisonRunOptions,
  dependencies: {
    readonly invoke?: typeof invokeSmokeScenario
    readonly candidateUnchanged?: () => Promise<boolean>
  } = {},
) {
  const runId = randomUUID()
  const environment = options.environment ?? process.env
  // Validate selectors before creating an attempt, including when already interrupted.
  capacityComparisonEnvironment(environment, options, runId, 0)
  await mkdir(options.output) // exclusive: an earlier attempt is never overwritten
  if (options.sourceIdentity)
    await writeJson(join(options.output, 'source-identity.json'), options.sourceIdentity)
  const invoke = dependencies.invoke ?? invokeSmokeScenario
  const slots: InvocationSlot[] = CAPACITY_TERMINAL_COMPARISON_ORDER.map(
    (engine, index) => ({
      index,
      pair: Math.floor(index / 2),
      engine,
      status: 'pending',
    }),
  )
  const results: CapacityTerminalProcessResult[] = slots.map(
    ({ index, pair, engine }) => ({
      index,
      pair,
      engine,
      status: 'failed',
      failure: 'not-started',
    }),
  )
  let unsafeEnvironment = false
  const candidateUnchanged = async () => {
    try {
      return (await dependencies.candidateUnchanged?.()) ?? true
    } catch {
      return false
    }
  }
  const persist = async () => {
    await writeJson(join(options.output, 'invocation.json'), {
      runId,
      status: unsafeEnvironment
        ? 'unsafe-environment'
        : options.interruptionSignal?.aborted
          ? 'interrupted'
          : slots.every((slot) => slot.status === 'completed')
            ? 'completed'
            : 'running',
      slots,
    })
    await writeJson(
      join(options.output, 'comparison.json'),
      evaluateCapacityTerminalComparison(results),
    )
  }
  await persist()
  for (const slot of slots) {
    if (options.interruptionSignal?.aborted) break
    if (!(await candidateUnchanged())) {
      unsafeEnvironment = true
      break
    }
    slot.status = 'running'
    await persist()
    let outcome: ChildOutcome
    try {
      outcome = await invoke('capacity', slot.index + 1, 8, {
        cwd: options.cwd ?? repositoryRoot,
        environment: capacityComparisonEnvironment(
          environment,
          options,
          runId,
          slot.index,
        ),
        artifactDirectory: join(options.output, `failure-${slot.index}`),
        interruptionSignal: options.interruptionSignal,
        registerSignalEscalation: options.registerSignalEscalation,
      })
      slot.outcome = {
        status: outcome.status,
        ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
        ...(outcome.signal === undefined ? {} : { signal: outcome.signal }),
        ...(outcome.durationMs === undefined ? {} : { durationMs: outcome.durationMs }),
        ...(outcome.failureEvidence === undefined
          ? {}
          : { failureEvidence: outcome.failureEvidence }),
        ...(outcome.status === 'failed' ? { failure: 'child-failed' as const } : {}),
      }
    } catch {
      outcome = { status: 'failed' }
      slot.outcome = { status: 'failed', failure: 'child-invocation-failed' }
    }
    const { index, pair, engine } = slot
    unsafeEnvironment = !(await candidateUnchanged())
    let failure = outcome.status === 'failed' ? 'child-failed' : undefined
    if (unsafeEnvironment) failure = 'candidate-changed'
    let raw: unknown
    try {
      const path = join(options.output, `process-${index}.json`)
      if ((await stat(path)).size > 8 * 1024 * 1024) fail('result-too-large')
      raw = JSON.parse(await readFile(path, 'utf8')) as unknown
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('invalid-result')
      const record = raw as Record<string, unknown>
      if (
        record.index !== index ||
        record.pair !== pair ||
        record.engine !== engine ||
        !['passed', 'failed'].includes(String(record.status)) ||
        (record.status === 'passed' && record.runId !== runId) ||
        (record.status === 'failed' &&
          (typeof record.failure !== 'string' ||
            !/^[a-z0-9-]{1,120}$/.test(record.failure)))
      )
        fail('invalid-result')
      if (record.status === 'passed') {
        // Reuse the production schema policy without inventing a runner validator.
        const probe = slots.map((scheduled) =>
          scheduled.index === index
            ? raw
            : {
                index: scheduled.index,
                pair: scheduled.pair,
                engine: scheduled.engine,
                status: 'failed',
                failure: 'not-started',
              },
        )
        if (
          evaluateCapacityTerminalComparison(probe).blockers.some((blocker) =>
            blocker.startsWith(`process-${index}:`),
          )
        )
          fail('invalid-result')
      }
    } catch {
      failure ??= 'missing-or-invalid-process-result'
    }
    results[index] = failure
      ? { index, pair, engine, status: 'failed', failure }
      : (raw as CapacityTerminalProcessResult)
    slot.status = 'completed'
    await persist()
    if (unsafeEnvironment) break
  }
  await persist()
  return evaluateCapacityTerminalComparison(results)
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

/** Hash actual runtime bytes, including ignored chunks and bindings, outside sample timing.
 * Mirrors native artifact manifests: canonical relative paths, byte counts and SHA256 only. */
export async function captureCapacityComparisonBuildIdentity(root: string) {
  const digest = (value: string | Buffer) =>
    createHash('sha256').update(value).digest('hex')
  const definitions = [
    ['out/main', ['index.js']],
    ['out/preload', ['index.js']],
    ['out/renderer', ['index.html']],
    [
      'packages/native-terminal/build/Release',
      ['bindings.json', 'native_terminal_engine.node', 'native_terminal_resource.node'],
    ],
  ] as const
  const components: {
    path: string
    manifestSha256: string
    files: {
      path: string
      bytes: number
      sha256: string
    }[]
  }[] = []
  for (const [component, required] of definitions) {
    // Check every ancestor: a symlinked build directory must not escape the census.
    let ancestor = root
    for (const segment of component.split('/')) {
      ancestor = join(ancestor, segment)
      if (!(await lstat(ancestor)).isDirectory()) fail('invalid-runtime-build-directory')
    }
    const files: { path: string; bytes: number; sha256: string }[] = []
    const record = async (directory: string): Promise<void> => {
      for (const name of (await readdir(directory)).sort()) {
        const path = join(directory, name)
        const metadata = await lstat(path)
        if (metadata.isDirectory()) await record(path)
        else if (metadata.isFile()) {
          const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
          try {
            const before = await file.stat()
            if (!before.isFile()) fail('invalid-runtime-build-file')
            const bytes = await file.readFile()
            const after = await file.stat()
            if (
              before.ino !== after.ino ||
              before.size !== after.size ||
              before.mtimeMs !== after.mtimeMs ||
              before.ctimeMs !== after.ctimeMs ||
              bytes.length !== after.size
            )
              fail('runtime-build-changed-during-census')
            files.push({
              path: relative(root, path).split(sep).join('/'),
              bytes: bytes.length,
              sha256: digest(bytes),
            })
          } finally {
            await file.close()
          }
        } else fail('invalid-runtime-build-file')
      }
    }
    await record(join(root, component))
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    if (
      required.some((name) => !files.some((file) => file.path === `${component}/${name}`))
    )
      fail('missing-runtime-build-file')
    components.push({
      path: component,
      manifestSha256: digest(JSON.stringify(files)),
      files,
    })
  }
  return {
    frontendSha256: digest(
      JSON.stringify(
        components
          .slice(0, 3)
          .map(({ path, manifestSha256 }) => ({ path, manifestSha256 })),
      ),
    ),
    components,
  }
}

async function sourceIdentity(options: CapacityComparisonArguments) {
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  if (git('status', '--porcelain', '--untracked-files=normal'))
    fail('source-tree-not-clean')
  if (!(await stat(options.nativeLibrary)).isFile()) fail('native-library-not-file')
  const digest = async (path: string) =>
    createHash('sha256')
      .update(await readFile(path))
      .digest('hex')
  const lockfile = JSON.parse(
    await readFile(join(repositoryRoot, 'package-lock.json'), 'utf8'),
  ) as {
    packages?: Record<string, { version?: unknown }>
  }
  const webVersion = lockfile.packages?.['node_modules/ghostty-web']?.version
  if (typeof webVersion !== 'string' || !/^[a-z0-9.+_-]{1,120}$/i.test(webVersion))
    fail('invalid-web-artifact-version')
  const target = `${process.platform === 'darwin' ? 'macos' : process.platform}-${process.arch}`
  const sdk = await verifyArtifact(dirname(options.nativeLibrary), target)
  if (
    !sdk.files.some(
      (file) =>
        resolve(dirname(options.nativeLibrary), file.path) ===
        resolve(options.nativeLibrary),
    )
  )
    fail('native-library-not-in-manifest')
  return {
    sourceSha: git('rev-parse', 'HEAD'),
    webVersion,
    nativeSdk: {
      manifestSha256: await digest(join(dirname(options.nativeLibrary), 'manifest.json')),
      source: sdk.source,
      target: sdk.target,
      pinSha256: sdk.pinSha256,
      applicationVersion: sdk.applicationVersion,
      vtVersion: sdk.vtVersion,
      embedAbi: sdk.embedAbi,
      development: sdk.build.development === true,
      buildSha256: createHash('sha256').update(JSON.stringify(sdk.build)).digest('hex'),
    },
    lockfileSha256: await digest(join(repositoryRoot, 'package-lock.json')),
    runtimeBuild: await captureCapacityComparisonBuildIdentity(repositoryRoot),
    nativeLibrarySha256: await digest(options.nativeLibrary),
    nodeVersion: process.versions.node,
    platform: process.platform,
    architecture: process.arch,
    refreshHz: options.refreshHz,
    presentation: 'auto',
    ozone: process.env.HVIR_NATIVE_TERMINAL_OZONE ?? 'default',
  }
}

async function main(): Promise<void> {
  const options = parseCapacityComparisonArguments(process.argv.slice(2))
  const relativeOutput = relative(repositoryRoot, options.output)
  if (
    relativeOutput === '' ||
    (relativeOutput !== '..' &&
      !relativeOutput.startsWith(`..${sep}`) &&
      !isAbsolute(relativeOutput))
  )
    fail('output-must-be-outside-source-tree')
  const identity = await sourceIdentity(options)
  const interruption = new AbortController()
  let escalateActiveAttempt: (() => void) | undefined
  const removeSignals = registerSmokeLauncherSignals(interruption, () =>
    escalateActiveAttempt?.(),
  )
  try {
    const comparison = await runCapacityTerminalComparison(
      {
        ...options,
        sourceIdentity: identity,
        interruptionSignal: interruption.signal,
        registerSignalEscalation: (escalate) => {
          escalateActiveAttempt = escalate
          return () => {
            if (escalateActiveAttempt === escalate) escalateActiveAttempt = undefined
          }
        },
      },
      {
        candidateUnchanged: async () =>
          JSON.stringify(await sourceIdentity(options)) === JSON.stringify(identity),
      },
    )
    if (!comparison.timingPassed || interruption.signal.aborted) process.exitCode = 1
  } finally {
    removeSignals()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void withSmokeRunLock(main).catch(() => {
    console.error('[capacity:comparison] invocation-failed')
    process.exitCode = 1
  })
}
