import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import {
  parseElectronSmokeScenario,
  type ElectronSmokeScenario,
} from '../src/main/smoke/scenario-selection.mts'

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
}

type InvokeSmokeScenario = (
  scenario: SmokeScenarioName,
  iteration: number,
  repetitionCount: number,
) => Promise<Omit<SmokeScenarioResult, 'scenario' | 'iteration' | 'repetitionCount'>>

const MAX_SMOKE_REPETITIONS = 100

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

function invokeSmokeScenario(
  scenario: SmokeScenarioName,
  iteration: number,
  repetitionCount: number,
): Promise<Omit<SmokeScenarioResult, 'scenario' | 'iteration' | 'repetitionCount'>> {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  console.log(
    `[smoke:group] ${scenario} iteration ${iteration}/${repetitionCount} starting`,
  )
  return new Promise((resolveResult) => {
    const child = spawn('bash', [join(repositoryRoot, 'scripts/run-smoke.sh')], {
      cwd: repositoryRoot,
      env: smokeScenarioEnvironment(process.env, scenario),
      stdio: 'inherit',
    })
    let settled = false
    child.once('error', (error) => {
      if (settled) return
      settled = true
      resolveResult({ status: 'failed', error: error.message })
    })
    child.once('close', (exitCode, signal) => {
      if (settled) return
      settled = true
      resolveResult({
        status: exitCode === 0 ? 'passed' : 'failed',
        ...(exitCode === null ? {} : { exitCode }),
        ...(signal === null ? {} : { signal }),
      })
    })
  })
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
      return `- ${result.scenario} iteration ${result.iteration}/${result.repetitionCount}: ${result.status} (${detail})`
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
