import { invoke, payload, type IpcFeatureContract } from '../ipc-contract'
import { type HostPath } from '../host-path'
import { type KeybindingAction, type KeybindingMap } from '../keybindings'
import { type WebPaneDiagnosticEvent } from '../web-pane'
import { type OperationResult } from '../operation-result'

export type WebPaneCommandAction =
  KeybindingAction | 'closeWebPane' | 'escapeWebPaneFocus'

export type OpenWebPaneRequest =
  | {
      readonly source: 'terminal'
      readonly root: HostPath
      readonly terminalId: string
      readonly url: string
    }
  | {
      readonly source: 'pane'
      readonly paneId: string
      readonly url: string
    }

export interface OpenWebPaneResponse {
  readonly paneId: string
  readonly partition: string
  readonly url: string
  readonly origin: string
}

export interface CloseWebPaneRequest {
  readonly paneId: string
}

export interface OpenWebPaneExternalRequest {
  readonly paneId: string
  readonly url: string
}

export type OpenWebPaneBrowserRequest = OpenWebPaneExternalRequest

export interface WebPaneBlockedNavigation {
  readonly paneId: string
  readonly kind: 'loopback' | 'external'
  readonly url: string
}

export const webPaneIpc = {
  invoke: {
    'web-pane:open': invoke<OpenWebPaneRequest, OperationResult<OpenWebPaneResponse>>(),
    'web-pane:close': invoke<CloseWebPaneRequest, void>(),
    'web-pane:open-external': invoke<OpenWebPaneExternalRequest, void>(),
    'web-pane:open-browser': invoke<OpenWebPaneBrowserRequest, void>(),
  },
  send: {
    'web-pane:reserved-bindings': payload<KeybindingMap>(),
    'web-pane:full-page': payload<{ readonly paneId?: string }>(),
  },
  event: {
    'web-pane:navigation-blocked': payload<WebPaneBlockedNavigation>(),
    'web-pane:command': payload<{
      readonly paneId: string
      readonly action: WebPaneCommandAction
    }>(),
    'web-pane:diagnostic': payload<{
      readonly paneId: string
      readonly event: WebPaneDiagnosticEvent
    }>(),
  },
} satisfies IpcFeatureContract
