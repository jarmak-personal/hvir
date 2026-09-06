import { runSmoke } from '.'
import type { ElectronSmokeDependencies } from './bootstrap-contract'
import { runNativePtySmoke } from './native-pty'
import { SmokeInterruptionCheckpoint } from './interruption-checkpoint'
import {
  parseElectronSmokeScenario,
  type ElectronSmokeMode,
  type ElectronSmokeScenario,
} from './scenario-selection.mts'

export type ElectronSmokeScenarioDependencies = Omit<
  ElectronSmokeDependencies,
  'mode' | 'interruptionCheckpoint'
> & {
  readonly scenario: string | undefined
}

export async function runElectronSmokeScenario(
  dependencies: ElectronSmokeScenarioDependencies,
): Promise<number> {
  const { scenario: requestedScenario, ...rendererDependencies } = dependencies
  const scenario = parseElectronSmokeScenario(requestedScenario)
  const interruptionCheckpoint = SmokeInterruptionCheckpoint.fromEnvironment()
  try {
    if (scenario === 'pty-native') {
      return await runNativePtySmoke(
        rendererDependencies.projectRoot,
        interruptionCheckpoint,
      )
    }

    rendererDependencies.htmlPreviews.register()
    return await runSmoke({
      ...rendererDependencies,
      interruptionCheckpoint,
      mode: rendererMode(scenario),
    })
  } finally {
    interruptionCheckpoint.dispose()
  }
}

function rendererMode(
  scenario: Exclude<ElectronSmokeScenario, 'pty-native'>,
): ElectronSmokeMode {
  return scenario === 'diagnostic-report-restart' ? 'platform-contracts' : scenario
}
