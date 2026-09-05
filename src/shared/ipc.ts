/** One typed preload API and explicit composition of feature-owned wire contracts. */
import type { Disposer } from './disposer'
import type { OperationResult } from './operation-result'
import type { ExternalFileGrantResult } from './project-file-operations'
import {
  composeIpcContracts,
  ipcChannels,
  type InvokeMap,
  type SendMap,
  type EventMap,
  type PreloadOnlyChannel,
} from './ipc-contract'
import { appIpc } from './ipc/app'
import { diagnosticsIpc } from './ipc/diagnostics'
import { projectIpc } from './ipc/project'
import { filesystemIpc } from './ipc/filesystem'
import { gitIpc } from './ipc/git'
import { previewIpc } from './ipc/preview'
import { harnessIpc } from './ipc/harness'
import { terminalIpc } from './ipc/terminal'
import { sessionsIpc } from './ipc/sessions'
import { webPaneIpc } from './ipc/web-pane'
import { documentReviewIpc } from './ipc/document-review'

// Compatibility only: domain contracts import their named owners directly.
export { type AppInfo, type EchoRequest, type EchoResponse } from './ipc/app'
export {
  MAX_PROJECT_WATCH_INTERESTS,
  type ProjectWatchInterestsRequest,
  type ProjectWatchInterestsResponse,
  type ProjectHostOption,
  type OpenProjectRequest,
  type SwitchWorkspaceRequest,
  type RefreshProjectRequest,
  type CloseProjectRequest,
  type PruneProjectWorktreesRequest,
  type DismissWorkspaceRequest,
  type AcknowledgeWorkspaceRequest,
  type PlanWorkspaceCloseRequest,
  type WorkspaceClosePlan,
  type CloseWorkspaceRequest,
  type ReopenWorkspaceRequest,
  type ConnectHostRequest,
  type DisconnectHostRequest,
  type ConnectedHost,
  type BrowseHostRequest,
  type BrowseHostResponse,
  type ProjectFolderPickerStartRequest,
  type ProjectFolderPickerLease,
  type ProjectFolderPickerBrowseRequest,
  type ProjectFolderPickerCreateDirectoryRequest,
  type ProjectFolderPickerCloseRequest,
  type SshPromptRequest,
  type SshPromptResponse,
} from './ipc/project'
export {
  type ReadDirectoryRequest,
  type ReadFileRequest,
  type RevealProjectEntryRequest,
  type AcquireDroppedFilesRequest,
  type ResolveEntryResponse,
  type ReadFileResponse,
  type ReadAssetResponse,
} from './ipc/filesystem'
export {
  type HarnessProfilesRequest,
  type HarnessProbeProfilesRequest,
  type HarnessProbeTemplatesRequest,
  type MaterializeHarnessProfilesRequest,
  type SaveHarnessProfileRequest,
  type HarnessProfileRequest,
  type HarnessPreviewRequest,
  type AuthorizeHarnessPathRequest,
  type ConfigureComposerSubmitRequest,
} from './ipc/harness'
export {
  type StartPtyRequest,
  type StartPtyResponse,
  type TerminalIdentityStatus,
  type TerminalRecoverySession,
  type TerminalLayoutEntry,
  type TerminalRecoveryRequest,
  type RecordTerminalRecoveryDecisionRequest,
  type TerminalLayoutRequest,
  type ForgetTerminalRequest,
  type PlanTerminalMoveRequest,
  type TerminalMovePlan,
  type MoveTerminalRequest,
  type MoveTerminalResponse,
  type RebindTerminalProfileRequest,
  MAX_CLIPBOARD_WRITE_BYTES,
} from './ipc/terminal'
export {
  type WebPaneCommandAction,
  type OpenWebPaneRequest,
  type OpenWebPaneResponse,
  type CloseWebPaneRequest,
  type OpenWebPaneExternalRequest,
  type OpenWebPaneBrowserRequest,
  type WebPaneBlockedNavigation,
} from './ipc/web-pane'
export { type ProjectRootResponse, type ProjectState } from './workspace-types'
export { type OperationResult, unwrapOperation } from './operation-result'
export type { TerminalAttentionState } from './terminal-attention'

const contract = composeIpcContracts(
  appIpc,
  diagnosticsIpc,
  projectIpc,
  filesystemIpc,
  gitIpc,
  previewIpc,
  harnessIpc,
  terminalIpc,
  sessionsIpc,
  webPaneIpc,
  documentReviewIpc,
)

export type IpcInvokeMap = InvokeMap<typeof contract>
export type IpcSendMap = SendMap<typeof contract>
export type IpcEventMap = EventMap<typeof contract>
export type IpcInvokeChannel = keyof IpcInvokeMap

export type RendererIpcInvokeChannel = Exclude<
  IpcInvokeChannel,
  PreloadOnlyIpcInvokeChannel
>

export type IpcSendChannel = keyof IpcSendMap

export type IpcEventChannel = keyof IpcEventMap

export type IpcRequest<C extends IpcInvokeChannel> = IpcInvokeMap[C]['request']

export type IpcResponse<C extends IpcInvokeChannel> = IpcInvokeMap[C]['response']

export type IpcSendPayload<C extends IpcSendChannel> = IpcSendMap[C]

export type IpcEventPayload<E extends IpcEventChannel> = IpcEventMap[E]

/**
 * The surface exposed to the renderer as `window.hvir` (via the preload
 * bridge). Defined here — a pure, electron-free type — so the renderer can type
 * against it without importing anything from main/preload.
 */
export interface HvirApi {
  /** Signals that the workbench surface committed for the preload's exact generation. */
  rendererReady(): void
  /** Resolve one disk-backed clipboard File to safe local terminal paste text. */
  resolveTerminalClipboardFilePaste(file: File): string | undefined
  invoke<C extends RendererIpcInvokeChannel>(
    channel: C,
    request: IpcRequest<C>,
  ): Promise<IpcResponse<C>>
  send<C extends IpcSendChannel>(channel: C, payload: IpcSendPayload<C>): void
  on<E extends IpcEventChannel>(
    channel: E,
    callback: (payload: IpcEventPayload<E>) => void,
  ): Disposer
  readonly externalFiles: {
    /** Converts renderer File objects to inert main-owned paths inside preload. */
    acquireDropped(
      files: readonly File[],
    ): Promise<OperationResult<ExternalFileGrantResult>>
  }
  readonly diagnostics: {
    /** Electron's renderer-process sandbox state, surfaced read-only by preload. */
    readonly processSandboxed: boolean
    /** Domain-owned, content-free evidence. Invalid or overloaded calls are dropped. */
    recordRenderContainment(occurrenceId: string): void
  }
}

export type PreloadOnlyIpcInvokeChannel = PreloadOnlyChannel<typeof contract>
export const INVOKE_CHANNELS = ipcChannels(contract.invoke)
export const SEND_CHANNELS = ipcChannels(contract.send)
export const EVENT_CHANNELS = ipcChannels(contract.event)
export const PRELOAD_ONLY_INVOKE_CHANNELS: readonly PreloadOnlyIpcInvokeChannel[] =
  INVOKE_CHANNELS.filter(
    (channel): channel is PreloadOnlyIpcInvokeChannel =>
      contract.invoke[channel].access === 'preload',
  )
export const RENDERER_INVOKE_CHANNELS = INVOKE_CHANNELS.filter(
  (channel): channel is RendererIpcInvokeChannel =>
    contract.invoke[channel].access === 'renderer',
)
