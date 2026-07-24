import { runSmoke, type ElectronSmokeDependencies } from '.'
import { runNativePtySmoke } from './native-pty'
import {
  parseElectronSmokeScenario,
  type ElectronSmokeMode,
  type ElectronSmokeScenario,
} from './scenario-selection.mts'

export type ElectronSmokeScenarioDependencies = Omit<
  ElectronSmokeDependencies,
  'mode'
> & {
  readonly scenario: string | undefined
}

export async function runElectronSmokeScenario(
  dependencies: ElectronSmokeScenarioDependencies,
): Promise<number> {
  const { scenario: requestedScenario, ...rendererDependencies } = dependencies
  const scenario = parseElectronSmokeScenario(requestedScenario)
  if (scenario === 'pty-native') {
    return runNativePtySmoke(rendererDependencies.projectRoot)
  }

  rendererDependencies.htmlPreviews.register()
  return runSmoke({
    ...rendererDependencies,
    mode: rendererMode(scenario),
  })
}

function rendererMode(
  scenario: Exclude<ElectronSmokeScenario, 'pty-native'>,
): ElectronSmokeMode {
  if (scenario === 'capacity') return 'capacity'
  if (scenario === 'platform-contracts' || scenario === 'diagnostic-report-restart')
    return 'platform-contracts'
  if (scenario === 'terminal-presentation') return 'terminal-presentation'
  return scenario === 'viewer-position' ? 'viewer-position' : 'workflow'
}
