import { runSmoke, type ElectronSmokeDependencies } from '.'
import { runNativePtySmoke } from './native-pty'
import {
  parseElectronSmokeScenario,
  type ElectronSmokeScenario,
} from './scenario-selection'

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
): 'workflow' | 'capacity' {
  return scenario === 'capacity' ? 'capacity' : 'workflow'
}
