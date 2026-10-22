import type { ExtensionWorkspaceContext } from '../extensions/contract'
import type { ProjectHostOption } from './project'
import type {
  ExtensionSourceBinding,
  ExtensionSourceSelection,
  ExtensionSourceGrant,
  ExtensionSourceStatus,
} from '../extensions/source-access'
import type {
  ExtensionConnectorSelection,
  ExtensionConnectorApproval,
  ExtensionConnectorSetting,
} from '../extensions/connectors'
import { invoke, payload, type IpcFeatureContract } from '../ipc-contract'
import type { KeybindingAction } from '../keybindings'
import type { ExtensionPresentation } from '../extensions/contract'
import type {
  ExtensionPlatformState,
  ExtensionAdditionResult,
  ExtensionView,
  ExtensionContributionState,
  ExtensionSurfaceRequest,
  ExtensionDemand,
} from '../extensions/workbench'

/** Trusted Settings/viewer transport. This contract is never exposed to a guest. */
export const extensionsIpc = {
  invoke: {
    'extensions:setup-template': invoke<{ readonly installationId: string }, string>(),
    'extensions:setup-import': invoke<
      { readonly installationId: string; readonly request: string },
      import('../extensions/setup-review').ExtensionSetupReview | undefined
    >(),
    'extensions:setup-select': invoke<
      { readonly request: string; readonly rows: readonly string[] },
      import('../extensions/setup-review').ExtensionSetupReview
    >(),
    'extensions:setup-apply': invoke<
      { readonly request: string },
      import('../extensions/setup-review').ExtensionSetupReview
    >(),
    'extensions:setup-cancel': invoke<{ readonly request: string }, void>(),
    'extensions:source-trash-proposals': invoke<
      void,
      readonly import('../extensions/source-trash').ExtensionSourceTrashProposal[]
    >(),
    'extensions:source-trash-confirm': invoke<
      { readonly id: string },
      import('../operation-result').OperationResult<
        import('../project-file-operations').ProjectFileOperationStartResult
      >
    >(),
    'extensions:source-trash-cancel': invoke<{ readonly id: string }, void>(),
    'extensions:source-proposals': invoke<
      void,
      readonly import('../extensions/source-access').ExtensionSourceRequestProposal[]
    >(),
    'extensions:source-decide': invoke<
      { readonly id: string; readonly accepted: boolean },
      void
    >(),
    'extensions:foreground': invoke<void, boolean>(),
    'extensions:delivery-recovery': invoke<
      void,
      readonly import('../extensions/managed-delivery').DeliveryRecoveryEntry[]
    >(),
    'extensions:delivery-resolve': invoke<
      {
        readonly kind: 'inspect' | 'keep' | 'reconcile' | 'cleanup'
        readonly id: string
      },
      import('../extensions/managed-delivery').DeliveryRecoveryReply
    >(),
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
    'extensions:source-cancel-prepared': invoke<{ readonly token: string }, void>(),
    'extensions:source-revoke': invoke<
      {
        readonly installationId: string
        readonly source: string
        readonly binding?: ExtensionSourceBinding
      },
      void
    >(),
    'extensions:connector-settings': invoke<
      {
        readonly installationId: string
        readonly connector?: string
        readonly host?: string
      },
      {
        readonly hosts: readonly ProjectHostOption[]
        readonly connectors: readonly ExtensionConnectorSetting[]
        readonly explanation?: string
      }
    >(),
    'extensions:connection-proposals': invoke<
      void,
      readonly import('../extensions/connectors').ExtensionConnectionProposal[]
    >(),
    'extensions:connection-decide': invoke<
      { readonly id: string; readonly accepted: boolean },
      void
    >(),
    'extensions:connector-connect': invoke<
      {
        readonly installationId: string
        readonly connector: string
        readonly request: string
      },
      import('../extensions/connectors').ExtensionConnectionResult
    >(),
    'extensions:connector-prepare': invoke<
      ExtensionConnectorSelection & { readonly trustUpdates?: boolean },
      {
        readonly token: string
        readonly approval: ExtensionConnectorApproval
        readonly trustUpdates: boolean
        readonly preservesBaseline: boolean
      }
    >(),
    'extensions:connector-approve': invoke<{ readonly token: string }, void>(),
    'extensions:connector-cancel-prepared': invoke<{ readonly token: string }, void>(),
    'extensions:connector-session-end': invoke<
      {
        readonly installationId: string
        readonly connector: string
        readonly host: string
      },
      void
    >(),
    'extensions:connector-revoke': invoke<
      {
        readonly installationId: string
        readonly connector: string
        readonly host: string
      },
      void
    >(),
    'extensions:state': invoke<void, ExtensionPlatformState>(),
    'extensions:discover': invoke<void, ExtensionPlatformState>(),
    'extensions:add': invoke<{ readonly request: string }, ExtensionAdditionResult>(),
    'extensions:add-cancel-setup': invoke<{ readonly request: string }, void>(),
    'extensions:connection-cancel': invoke<{ readonly request: string }, void>(),
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
    'extensions:target-view': invoke<
      { readonly viewId: string; readonly workspaceId?: string },
      ExtensionView
    >(),
    'extensions:close-view': invoke<{ readonly viewId: string }, void>(),
    'extensions:contributions': invoke<void, readonly ExtensionContributionState[]>(),
    'extensions:context': invoke<
      void,
      import('../extensions/contract').ExtensionContext & {
        readonly terminalIds: Readonly<Record<string, string>>
        readonly workspaces: readonly import('../extensions/contract').ExtensionWorkspaceContext[]
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
      readonly selected: boolean
      readonly refreshDemand: boolean
    }>(),
  },
  event: {
    'extensions:setup-changed':
      payload<import('../extensions/setup-review').ExtensionSetupReview>(),
    'extensions:source-trash-changed':
      payload<
        readonly import('../extensions/source-trash').ExtensionSourceTrashProposal[]
      >(),
    'extensions:source-proposals-changed':
      payload<
        readonly import('../extensions/source-access').ExtensionSourceRequestProposal[]
      >(),
    'extensions:connection-proposals-changed':
      payload<
        readonly import('../extensions/connectors').ExtensionConnectionProposal[]
      >(),
    'extensions:foreground-changed': payload<boolean>(),
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
