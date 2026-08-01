import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import {
  SmokeAttemptEvidenceCollector,
  createSmokeFailureArtifact,
  writeSmokeFailureArtifact,
} from './smoke-failure-artifact.mts'
import {
  parseElectronSmokeScenario,
  type ElectronSmokeScenario,
} from '../src/main/smoke/scenario-selection.mts'
import type { SmokeFailureCheckpoint } from '../src/main/smoke/failure-evidence.mts'

export const DEFAULT_SMOKE_SCENARIOS = [
  'pty-native',
  'viewer-position',
  'legacy-workflow',
] as const satisfies readonly ElectronSmokeScenario[]

export type SmokeScenarioName = ElectronSmokeScenario

export interface SmokeScenarioResult {
  readonly scenario: SmokeScenarioName
  readonly iteration: number
  readonly repetitionCount: number
  readonly status: 'passed' | 'failed'
  readonly exitCode?: number
  readonly signal?: NodeJS.Signals
  readonly error?: string
  readonly durationMs?: number
}

type InvokeSmokeScenario = (
  scenario: SmokeScenarioName,
  iteration: number,
  repetitionCount: number,
) => Promise<Omit<SmokeScenarioResult, 'scenario' | 'iteration' | 'repetitionCount'>>

const MAX_SMOKE_REPETITIONS = 100
const DEFAULT_SMOKE_ATTEMPT_TIMEOUT_MS = 180_000
const CAPACITY_SMOKE_ATTEMPT_TIMEOUT_MS = 600_000
const RENDERER_OPERATION_CHECKPOINT_TIMEOUT_MS = 15_000
const EXTERNAL_WATCHDOG_CHECKPOINTS = new Map<
  SmokeScenarioName,
  SmokeFailureCheckpoint[]
>([
  [
    'web-pane',
    [
      'web-pane-terminal-launch-awaiting',
      'web-pane-dashboard-listen-awaiting',
      'web-pane-route-activation-awaiting',
      'web-pane-dashboard-request-awaiting',
      'web-pane-guest-ready-awaiting',
      'web-pane-route-revocation-awaiting',
      'web-pane-terminal-disposal-awaiting',
      'web-pane-dashboard-close-awaiting',
    ],
  ],
  [
    'renderer-recovery',
    [
      'renderer-recovery-route-opening',
      'renderer-recovery-exit-awaiting',
      'renderer-recovery-reload-awaiting',
      'renderer-recovery-replacement-ipc-awaiting',
      'renderer-recovery-controls-awaiting',
      'renderer-recovery-terminal-lifecycle-awaiting',
      'renderer-recovery-route-revocation-awaiting',
      'renderer-recovery-diagnostics-awaiting',
    ],
  ],
  [
    'renderer-authority',
    [
      'renderer-authority-destruction-awaiting',
      'renderer-authority-resource-revocation-awaiting',
    ],
  ],
])
const FAILURE_ARTIFACT_TIMEOUT_MS = 1_000

export interface SmokeScenarioInvocationOptions {
  readonly command?: string
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly environment?: NodeJS.ProcessEnv
  readonly timeoutMs?: number
  readonly checkpointTimeoutMs?: number
  readonly artifactDirectory?: string
}

export function smokeAttemptTimeoutMs(scenario: SmokeScenarioName): number {
  return scenario === 'capacity'
    ? CAPACITY_SMOKE_ATTEMPT_TIMEOUT_MS
    : DEFAULT_SMOKE_ATTEMPT_TIMEOUT_MS
}

export function smokeCheckpointTimeoutMs(
  scenario: SmokeScenarioName,
  checkpoint: SmokeFailureCheckpoint | null,
): number | undefined {
  return checkpoint !== null &&
    EXTERNAL_WATCHDOG_CHECKPOINTS.get(scenario)?.includes(checkpoint)
    ? RENDERER_OPERATION_CHECKPOINT_TIMEOUT_MS
    : undefined
}

export function parseSmokeRepetitionCount(value: string | undefined): number {
  if (value === undefined) return 1
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(
      `HVIR_SMOKE_REPEAT must be an ASCII decimal integer from 1 through ${MAX_SMOKE_REPETITIONS}; received ${JSON.stringify(value)}`,
    )
  }
  const repetitionCount = Number(value)
  if (
    !Number.isSafeInteger(repetitionCount) ||
    repetitionCount < 1 ||
    repetitionCount > MAX_SMOKE_REPETITIONS
  ) {
    throw new Error(
      `HVIR_SMOKE_REPEAT must be an ASCII decimal integer from 1 through ${MAX_SMOKE_REPETITIONS}; received ${JSON.stringify(value)}`,
    )
  }
  return repetitionCount
}

export function selectedSmokeScenarios(
  value: string | undefined,
  positionalNames: readonly string[] = [],
): readonly SmokeScenarioName[] {
  if (positionalNames.length > 0) {
    if (value !== undefined && value !== '') {
      throw new Error(
        'Select Electron smoke scenarios with positional names or HVIR_SMOKE_SCENARIO, not both',
      )
    }
    return positionalNames.map((name) => parseElectronSmokeScenario(name))
  }
  if (value === undefined || value === '') return DEFAULT_SMOKE_SCENARIOS
  return [parseElectronSmokeScenario(value)]
}

export async function runSmokeScenarioGroups(
  scenarios: readonly SmokeScenarioName[],
  repetitionCount: number,
  invoke: InvokeSmokeScenario,
): Promise<readonly SmokeScenarioResult[]> {
  const results: SmokeScenarioResult[] = []
  for (let iteration = 1; iteration <= repetitionCount; iteration += 1) {
    for (const scenario of scenarios) {
      try {
        results.push({
          scenario,
          iteration,
          repetitionCount,
          ...(await invoke(scenario, iteration, repetitionCount)),
        })
      } catch (reason) {
        results.push({
          scenario,
          iteration,
          repetitionCount,
          status: 'failed',
          error: reason instanceof Error ? reason.message : String(reason),
        })
      }
    }
  }
  return results
}

export function smokeScenarioEnvironment(
  environment: NodeJS.ProcessEnv,
  scenario: SmokeScenarioName,
): NodeJS.ProcessEnv {
  const childEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    HVIR_SMOKE_SCENARIO: scenario,
  }
  delete childEnvironment.HVIR_SMOKE_REPEAT
  return childEnvironment
}

export function classifySmokeAttempt(options: {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly successSentinel: boolean
  readonly durationMs: number
}): Omit<SmokeScenarioResult, 'scenario' | 'iteration' | 'repetitionCount'> {
  const status = options.exitCode === 0 && options.successSentinel ? 'passed' : 'failed'
  return {
    status,
    ...(options.exitCode === null ? {} : { exitCode: options.exitCode }),
    ...(options.signal === null ? {} : { signal: options.signal }),
    ...(!options.successSentinel && options.exitCode === 0
      ? { error: 'missing success sentinel' }
      : {}),
    durationMs: options.durationMs,
  }
}

export function invokeSmokeScenario(
  scenario: SmokeScenarioName,
  iteration: number,
  repetitionCount: number,
  options: SmokeScenarioInvocationOptions = {},
): Promise<Omit<SmokeScenarioResult, 'scenario' | 'iteration' | 'repetitionCount'>> {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  console.log(
    `[smoke:group] ${scenario} iteration ${iteration}/${repetitionCount} starting`,
  )
  const startedAt = performance.now()
  return new Promise((resolveResult) => {
    const collector = new SmokeAttemptEvidenceCollector()
    const child = spawn(
      options.command ?? 'bash',
      [...(options.args ?? [join(repositoryRoot, 'scripts/run-smoke.sh')])],
      {
        cwd: options.cwd ?? repositoryRoot,
        detached: process.platform !== 'win32',
        env: smokeScenarioEnvironment(options.environment ?? process.env, scenario),
        stdio: ['inherit', 'pipe', 'pipe'],
      },
    )
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    let settled = false
    const timers: {
      attempt?: ReturnType<typeof setTimeout>
      checkpoint?: ReturnType<typeof setTimeout>
    } = {}
    let activeCheckpoint: SmokeFailureCheckpoint | null = null
    const clearTimers = (): void => {
      if (timers.attempt) clearTimeout(timers.attempt)
      if (timers.checkpoint) clearTimeout(timers.checkpoint)
    }
    const finishTimedOutAttempt = (error: string): void => {
      if (settled) return
      settled = true
      clearTimers()
      terminateSmokeAttempt(child.pid)
      collector.finish()
      const durationMs = performance.now() - startedAt
      const result = {
        status: 'failed',
        signal: 'SIGKILL',
        error,
        durationMs,
      } as const
      void retainFailureArtifact(
        {
          scenario,
          iteration,
          repetitionCount,
          durationMs,
          exitCode: null,
          signal: 'SIGKILL',
          spawnError: false,
          collector,
        },
        options.artifactDirectory,
      ).finally(() => resolveResult(result))
    }
    const refreshCheckpointDeadline = (): void => {
      const checkpoint = collector.evidence().snapshot?.checkpoint ?? null
      if (checkpoint === activeCheckpoint) return
      activeCheckpoint = checkpoint
      if (timers.checkpoint) clearTimeout(timers.checkpoint)
      timers.checkpoint = undefined
      const timeoutMs = smokeCheckpointTimeoutMs(scenario, checkpoint)
      if (timeoutMs === undefined) return
      const effectiveTimeoutMs = options.checkpointTimeoutMs ?? timeoutMs
      timers.checkpoint = setTimeout(
        () =>
          finishTimedOutAttempt(
            `process timed out at ${checkpoint} after ${effectiveTimeoutMs}ms`,
          ),
        effectiveTimeoutMs,
      )
    }
    child.stdout.on('data', (chunk: string) => {
      process.stdout.write(chunk)
      collector.observe('stdout', chunk)
      refreshCheckpointDeadline()
    })
    child.stderr.on('data', (chunk: string) => {
      process.stderr.write(chunk)
      collector.observe('stderr', chunk)
      refreshCheckpointDeadline()
    })
    timers.attempt = setTimeout(
      () => finishTimedOutAttempt('process timed out'),
      options.timeoutMs ?? smokeAttemptTimeoutMs(scenario),
    )
    child.once('error', () => {
      if (settled) return
      settled = true
      clearTimers()
      collector.finish()
      const durationMs = performance.now() - startedAt
      void retainFailureArtifact(
        {
          scenario,
          iteration,
          repetitionCount,
          durationMs,
          exitCode: null,
          signal: null,
          spawnError: true,
          collector,
        },
        options.artifactDirectory,
      ).finally(() =>
        resolveResult({ status: 'failed', error: 'process spawn failed', durationMs }),
      )
    })
    child.once('close', (exitCode, signal) => {
      if (settled) return
      settled = true
      clearTimers()
      collector.finish()
      const durationMs = performance.now() - startedAt
      const successSentinel = collector.evidence().logs.successSentinel
      const result = classifySmokeAttempt({
        exitCode,
        signal,
        successSentinel,
        durationMs,
      })
      if (result.status === 'passed') {
        resolveResult(result)
        return
      }
      void retainFailureArtifact(
        {
          scenario,
          iteration,
          repetitionCount,
          durationMs,
          exitCode,
          signal,
          spawnError: false,
          collector,
        },
        options.artifactDirectory,
      ).finally(() => resolveResult(result))
    })
  })
}

function terminateSmokeAttempt(pid: number | undefined): void {
  if (!pid) return
  try {
    if (process.platform === 'win32') process.kill(pid, 'SIGKILL')
    else process.kill(-pid, 'SIGKILL')
  } catch (error) {
    const code = (error as { code?: unknown } | undefined)?.code
    if (code !== 'ESRCH') {
      console.error('[smoke:launcher] failed to terminate timed-out process group')
    }
  }
}

async function retainFailureArtifact(
  options: Parameters<typeof createSmokeFailureArtifact>[0],
  directory = process.env.HVIR_SMOKE_ARTIFACT_DIR,
): Promise<void> {
  try {
    const path = await writeSmokeFailureArtifactWithinDeadline(() =>
      writeSmokeFailureArtifact(directory, createSmokeFailureArtifact(options)),
    )
    if (path) console.error('[smoke:artifact] retained bounded failure evidence')
  } catch {
    console.error('[smoke:artifact] failed to retain bounded failure evidence')
  }
}

export async function writeSmokeFailureArtifactWithinDeadline(
  writeArtifact: () => Promise<string | undefined>,
  timeoutMs = FAILURE_ARTIFACT_TIMEOUT_MS,
): Promise<string | undefined> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Smoke failure artifact deadline was invalid')
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      writeArtifact(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Smoke failure artifact retention timed out')),
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function formatSmokeScenarioResults(
  results: readonly SmokeScenarioResult[],
): string {
  const repetitionCount = results[0]?.repetitionCount ?? 0
  return [
    `[smoke:summary] attempts=${results.length} iterations=${repetitionCount}`,
    ...results.map((result) => {
      const detail =
        result.error ??
        (result.signal
          ? `signal ${result.signal}`
          : `exit ${result.exitCode ?? 'unknown'}`)
      const duration =
        result.durationMs === undefined ? '' : ` · ${Math.round(result.durationMs)}ms`
      return `- ${result.scenario} iteration ${result.iteration}/${result.repetitionCount}: ${result.status} (${detail}${duration})`
    }),
  ].join('\n')
}

async function main(): Promise<void> {
  const scenarios = selectedSmokeScenarios(
    process.env.HVIR_SMOKE_SCENARIO,
    process.argv.slice(2),
  )
  const repetitionCount = parseSmokeRepetitionCount(process.env.HVIR_SMOKE_REPEAT)
  const results = await runSmokeScenarioGroups(
    scenarios,
    repetitionCount,
    invokeSmokeScenario,
  )
  console.log(formatSmokeScenarioResults(results))
  if (results.some((result) => result.status === 'failed')) process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error('[smoke:launcher] failed', error)
    process.exitCode = 1
  })
}
