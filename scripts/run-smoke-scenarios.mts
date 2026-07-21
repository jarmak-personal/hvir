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
  readonly status: 'passed' | 'failed'
  readonly exitCode?: number
  readonly signal?: NodeJS.Signals
  readonly error?: string
}

type InvokeSmokeScenario = (
  scenario: SmokeScenarioName,
) => Promise<Omit<SmokeScenarioResult, 'scenario'>>

export function selectedSmokeScenarios(
  value: string | undefined,
): readonly SmokeScenarioName[] {
  if (value === undefined || value === '') return DEFAULT_SMOKE_SCENARIOS
  return [parseElectronSmokeScenario(value)]
}

export async function runSmokeScenarioGroups(
  scenarios: readonly SmokeScenarioName[],
  invoke: InvokeSmokeScenario,
): Promise<readonly SmokeScenarioResult[]> {
  const results: SmokeScenarioResult[] = []
  for (const scenario of scenarios) {
    try {
      results.push({ scenario, ...(await invoke(scenario)) })
    } catch (reason) {
      results.push({
        scenario,
        status: 'failed',
        error: reason instanceof Error ? reason.message : String(reason),
      })
    }
  }
  return results
}

function invokeSmokeScenario(
  scenario: SmokeScenarioName,
): Promise<Omit<SmokeScenarioResult, 'scenario'>> {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  console.log(`[smoke:group] ${scenario} starting`)
  return new Promise((resolveResult) => {
    const child = spawn('bash', [join(repositoryRoot, 'scripts/run-smoke.sh')], {
      cwd: repositoryRoot,
      env: { ...process.env, HVIR_SMOKE_SCENARIO: scenario },
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
  return [
    '[smoke:summary]',
    ...results.map((result) => {
      const detail =
        result.error ??
        (result.signal
          ? `signal ${result.signal}`
          : `exit ${result.exitCode ?? 'unknown'}`)
      return `- ${result.scenario}: ${result.status} (${detail})`
    }),
  ].join('\n')
}

async function main(): Promise<void> {
  const scenarios = selectedSmokeScenarios(process.env.HVIR_SMOKE_SCENARIO)
  const results = await runSmokeScenarioGroups(scenarios, invokeSmokeScenario)
  console.log(formatSmokeScenarioResults(results))
  if (results.some((result) => result.status === 'failed')) process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error('[smoke:launcher] failed', error)
    process.exitCode = 1
  })
}
