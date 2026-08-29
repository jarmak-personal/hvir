import { runSmoke, type ElectronSmokeDependencies } from '.'
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
  if (scenario === 'capacity') return 'capacity'
  if (scenario === 'platform-contracts' || scenario === 'diagnostic-report-restart')
    return 'platform-contracts'
  if (scenario === 'terminal-presentation') return 'terminal-presentation'
  if (scenario === 'terminal-lifecycle') return 'terminal-lifecycle'
  if (scenario === 'viewer-content') return 'viewer-content'
  if (scenario === 'git-workflow') return 'git-workflow'
  if (scenario === 'workspace-remote') return 'workspace-remote'
  if (scenario === 'web-pane') return 'web-pane'
  if (scenario === 'renderer-authority') return 'renderer-authority'
  if (scenario === 'renderer-recovery') return 'renderer-recovery'
  if (scenario === 'sessions-projection') return 'sessions-projection'
  if (scenario === 'document-review') return 'document-review'
  if (scenario === 'development-performance') return 'development-performance'
  return scenario === 'viewer-position' ? 'viewer-position' : 'workflow'
}
