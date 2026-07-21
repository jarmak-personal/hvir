import type { BrowserWindow } from 'electron'

import type { HostPath, KeybindingMap } from '../../shared'
import type { HarnessProbeManager } from '../harness/harness-probe'
import type { HtmlPreviewProtocol } from '../html-preview-protocol'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import type { WebPaneRouteRegistry } from '../web-pane/web-pane-route-registry'
import { runSmoke } from '.'
import { runNativePtySmoke } from './native-pty'
import {
  parseElectronSmokeScenario,
  type ElectronSmokeScenario,
} from './scenario-selection'

export interface ElectronSmokeScenarioDependencies {
  readonly scenario: string | undefined
  readonly projectRoot: HostPath
  readonly createWindow: (
    discardRendererResources?: (ownerId: number) => void,
  ) => BrowserWindow
  readonly harnessProbeManager: HarnessProbeManager
  readonly htmlPreviews: HtmlPreviewProtocol
  readonly rendererResources: RendererResourceScopes
  readonly webPaneRoutes: WebPaneRouteRegistry
  readonly updateWebPaneBindings: (ownerId: number, bindings: KeybindingMap) => void
  readonly updateWebPaneFullPage: (ownerId: number, paneId?: string) => void
  readonly openExternal: (url: string) => Promise<void>
}

export async function runElectronSmokeScenario(
  dependencies: ElectronSmokeScenarioDependencies,
): Promise<number> {
  const scenario = parseElectronSmokeScenario(dependencies.scenario)
  if (scenario === 'pty-native') {
    return runNativePtySmoke(dependencies.projectRoot)
  }

  dependencies.htmlPreviews.register()
  return runSmoke({
    ...dependencies,
    mode: rendererMode(scenario),
  })
}

function rendererMode(
  scenario: Exclude<ElectronSmokeScenario, 'pty-native'>,
): 'workflow' | 'capacity' {
  return scenario === 'capacity' ? 'capacity' : 'workflow'
}
