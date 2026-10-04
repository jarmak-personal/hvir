import type { ExtensionWorkspaceContext } from '../extensions/contract'
import type { ProjectHostOption } from './project'
import type {
  ExtensionSourceSelection,
  ExtensionSourceGrant,
  ExtensionSourceStatus,
} from '../extensions/source-access'
import type {
  ExtensionConnectorSelection,
  ExtensionConnectorApproval,
  ExtensionConnectorStatus,
} from '../extensions/connectors'
import { invoke, payload, type IpcFeatureContract } from '../ipc-contract'
import type { KeybindingAction } from '../keybindings'
import type { ExtensionPresentation } from '../extensions/contract'
import type {
  ExtensionPlatformState,
  ExtensionView,
  ExtensionContributionState,
  ExtensionSurfaceRequest,
  ExtensionDemand,
} from '../extensions/workbench'

/** Trusted Settings/viewer transport. This contract is never exposed to a guest. */
export const extensionsIpc = {
  invoke: {
    'extensions:source-settings': invoke<
      { readonly installationId: string },
      {
        readonly sources: readonly ExtensionSourceStatus[]
        readonly workspaces: readonly ExtensionWorkspaceContext[]
      }
    >(),
    'extensions:source-prepare': invoke<
      ExtensionSourceSelection,
      { readonly token: string; readonly grant: ExtensionSourceGrant }
    >(),
    'extensions:source-approve': invoke<{ readonly token: string }, void>(),
    'extensions:source-revoke': invoke<
      { readonly installationId: string; readonly source: string },
      void
    >(),
    'extensions:connector-settings': invoke<
      { readonly installationId: string },
      {
        readonly hosts: readonly ProjectHostOption[]
        readonly connectors: readonly ExtensionConnectorStatus[]
      }
    >(),
    'extensions:connector-prepare': invoke<
      ExtensionConnectorSelection,
      { readonly token: string; readonly approval: ExtensionConnectorApproval }
    >(),
    'extensions:connector-approve': invoke<{ readonly token: string }, void>(),
    'extensions:connector-revoke': invoke<
      { readonly installationId: string; readonly connector: string },
      void
    >(),
    'extensions:state': invoke<void, ExtensionPlatformState>(),
    'extensions:discover': invoke<void, ExtensionPlatformState>(),
    'extensions:open-folder': invoke<void, void>(),
    'extensions:enable': invoke<
      { readonly source: string; readonly revision: string },
      ExtensionPlatformState
    >(),
    'extensions:reload': invoke<
      { readonly source: string; readonly revision: string },
      ExtensionPlatformState
    >(),
    'extensions:remove': invoke<
      { readonly source: string; readonly identity?: string; readonly forget: boolean },
      ExtensionPlatformState
    >(),
    'extensions:disable': invoke<
      { readonly installationId: string },
      ExtensionPlatformState
    >(),
    'extensions:open-view': invoke<
      {
        readonly installationId: string
        readonly contributionId: string
        readonly context?: ExtensionSurfaceRequest
      },
      ExtensionView
    >(),
    'extensions:close-view': invoke<{ readonly viewId: string }, void>(),
    'extensions:contributions': invoke<void, readonly ExtensionContributionState[]>(),
    'extensions:context': invoke<
      void,
      import('../extensions/contract').ExtensionContext & {
        readonly terminalIds: Readonly<Record<string, string>>
      }
    >(),
    'extensions:action': invoke<
      {
        readonly installationId: string
        readonly action: string
        readonly input?: unknown
        readonly context: ExtensionSurfaceRequest
      },
      { readonly value: unknown }
    >(),
    'extensions:demand': invoke<readonly ExtensionDemand[], void>(),
    'extensions:views': invoke<void, readonly ExtensionView[]>(),
  },
  send: {
    'extension-guest:message': payload<unknown>(),
    'extension-guest:visible': payload<void>(),
    'extensions:presentation': payload<{
      readonly viewId: string
      readonly presentation: ExtensionPresentation
      readonly visible: boolean
      readonly refreshDemand: boolean
    }>(),
  },
  event: {
    'extensions:files-reveal': payload<{
      readonly workspaceId: string
      readonly root: import('../host-path').HostPath
      readonly path: import('../host-path').HostPath
    }>(),
    'extensions:contributions-changed': payload<readonly ExtensionContributionState[]>(),
    'extensions:command': payload<KeybindingAction>(),
    'extensions:state-changed': payload<ExtensionPlatformState>(),
    'extensions:views-changed': payload<{
      readonly views: readonly ExtensionView[]
      readonly selectedId?: string
      readonly focus?: boolean
    }>(),
  },
} satisfies IpcFeatureContract
