import { invoke, payload, type IpcFeatureContract } from '../ipc-contract'
import type { KeybindingAction } from '../keybindings'
import type { ExtensionPresentation } from '../extensions/contract'
import type { ExtensionPlatformState, ExtensionView } from '../extensions/workbench'

/** Trusted Settings/viewer transport. This contract is never exposed to a guest. */
export const extensionsIpc = {
  invoke: {
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
      { readonly installationId: string; readonly contributionId: string },
      ExtensionView
    >(),
    'extensions:close-view': invoke<{ readonly viewId: string }, void>(),
    'extensions:views': invoke<void, readonly ExtensionView[]>(),
  },
  send: {
    'extension-guest:message': payload<unknown>(),
    'extension-guest:visible': payload<void>(),
    'extensions:presentation': payload<{
      readonly viewId: string
      readonly presentation: ExtensionPresentation
      readonly visible: boolean
    }>(),
  },
  event: {
    'extensions:command': payload<KeybindingAction>(),
    'extensions:state-changed': payload<ExtensionPlatformState>(),
    'extensions:views-changed': payload<{
      readonly views: readonly ExtensionView[]
      readonly selectedId?: string
    }>(),
  },
} satisfies IpcFeatureContract
