import type { BrowserWindow } from 'electron'
import type { HostPath, KeybindingMap } from '../../shared'
import type { HarnessProbeManager } from '../harness/harness-probe'
import type { HtmlPreviewProtocol } from '../html-preview-protocol'
import type { RuntimeDiagnostics } from '../diagnostics/runtime-diagnostics'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import type { WebPaneRouteRegistry } from '../web-pane/web-pane-route-registry'
import type { SmokeInterruptionCheckpoint } from './interruption-checkpoint'
import type { ElectronSmokeMode } from './scenario-selection.mts'

export interface ElectronSmokeDependencies {
  readonly mode: ElectronSmokeMode
  readonly projectRoot: HostPath
  readonly createWindow: (
    discardRendererResources?: (ownerId: number) => void,
  ) => BrowserWindow
  readonly harnessProbeManager: HarnessProbeManager
  readonly htmlPreviews: HtmlPreviewProtocol
  readonly rendererResources: RendererResourceScopes
  readonly diagnostics: import('../ipc/deps').IpcDeps['diagnostics']
  readonly runtimeDiagnostics: RuntimeDiagnostics
  readonly webPaneRoutes: WebPaneRouteRegistry
  readonly rendererReady: (
    owner: import('../renderer-resource-scopes').RendererOwner,
    reportedGeneration: number,
  ) => boolean
  readonly updateWebPaneBindings: (ownerId: number, bindings: KeybindingMap) => void
  readonly updateWebPaneFullPage: (ownerId: number, paneId?: string) => void
  readonly openExternal: (url: string) => Promise<void>
  readonly interruptionCheckpoint: SmokeInterruptionCheckpoint
}
