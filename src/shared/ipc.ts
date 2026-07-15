/**
 * The typed IPC contract (renderer <-> main).
 *
 * This is the *single* source of truth for channel names and their
 * request/response shapes. Nothing outside this module and the preload bridge
 * may name a raw channel string; the renderer calls `window.hvir.invoke(...)`,
 * which is typed entirely against the maps below. Adding an IPC surface means
 * adding an entry here first.
 */

import type { Disposer } from './disposer'
import type { DirEntry, FileType, WatchEvent } from './fs-types'
import type { HostPath } from './host-path'
import type {
  CreateHtmlPreviewRequest,
  CreateHtmlPreviewResponse,
  ReleaseHtmlPreviewRequest,
} from './html-preview'
import type {
  GitDiffRequest,
  GitDiffResponse,
  WriteFileRequest,
  WriteFileResponse,
} from './viewer-types'
import type {
  GitBlameRun,
  GitBlameRequest,
  GitChanges,
  GitChangesRequest,
  GitCommitDetail,
  GitCommitDetailRequest,
  GitHistoryPage,
  GitHistoryRequest,
  GitIgnoredEntriesRequest,
  GitIgnoredEntriesResponse,
} from './git-types'
import type { HostConnectionState, HostWatchTier } from './fs-types'
import type { HarnessTelemetry } from './harness-telemetry'
import type { RegisteredProjectState } from './workspace-types'

/** Basic app/runtime info — the trivial round-trip that proves the contract. */
export interface AppInfo {
  readonly appVersion: string
  readonly electronVersion: string
  readonly chromeVersion: string
  readonly nodeVersion: string
  readonly platform: string
}

export interface EchoRequest {
  readonly text: string
}

export interface EchoResponse {
  readonly text: string
  readonly workerPid: number
}

export interface ProjectRootResponse {
  readonly root: HostPath
}

export interface ProjectHostOption {
  readonly hostId: string
  readonly label: string
  readonly kind: 'local' | 'ssh'
  readonly connectionState: HostConnectionState
  readonly watchTier: HostWatchTier
}

export interface ProjectState extends ProjectRootResponse {
  readonly connectionState: HostConnectionState
  readonly watchTier: HostWatchTier
  readonly projects: readonly RegisteredProjectState[]
  readonly activeProjectId: string
  readonly activeWorkspaceId: string
}

export interface OpenProjectRequest {
  readonly hostId: string
  readonly path: string
}

export interface SwitchWorkspaceRequest {
  readonly projectId: string
  readonly workspaceId: string
}

export interface RefreshProjectRequest {
  readonly projectId: string
}

export type PruneProjectWorktreesRequest = RefreshProjectRequest
export type DismissWorkspaceRequest = SwitchWorkspaceRequest

export interface ConnectHostRequest {
  readonly hostId: string
}

export interface DisconnectHostRequest {
  readonly hostId: string
}

export interface ConnectedHost {
  readonly host: ProjectHostOption
  readonly suggestedPath: string
}

export interface BrowseHostRequest {
  readonly hostId: string
  readonly path: string
}

export interface BrowseHostResponse {
  readonly path: HostPath
  readonly directories: readonly DirEntry[]
}

export type OperationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string }

export function unwrapOperation<T>(result: OperationResult<T>): T {
  if (!result.ok) throw new Error(result.error)
  return result.value
}

export interface SshPromptRequest {
  readonly id: number
  readonly hostId: string
  readonly kind:
    'password' | 'passphrase' | 'keyboard-interactive' | 'host-key' | 'host-key-changed'
  readonly title: string
  readonly instructions?: string
  readonly fingerprint?: string
  readonly previousFingerprint?: string
  readonly prompts: readonly { readonly text: string; readonly echo: boolean }[]
}

export interface SshPromptResponse {
  readonly id: number
  readonly answers?: readonly string[]
}

export interface ReadDirectoryRequest {
  readonly path: HostPath
}

export interface ReadFileRequest {
  readonly path: HostPath
}

export interface ResolveEntryResponse {
  /** The renderer-facing link path, not the canonical target path. */
  readonly path: HostPath
  /** Target kind after canonical confinement and symlink resolution. */
  readonly type: FileType
}

export interface ReadFileResponse {
  readonly path: HostPath
  readonly content: string
  readonly size: number
  readonly mtimeMs: number
  readonly binary: boolean
}

export interface ReadAssetResponse {
  readonly path: HostPath
  readonly data: Uint8Array
  readonly size: number
  readonly mimeType: string
}

export interface StartPtyRequest {
  readonly sessionId: string
  readonly adapterId: TerminalAdapterId
  readonly cwd: HostPath
  readonly cols: number
  readonly rows: number
  readonly title: string
  readonly position: number
  readonly active: boolean
  readonly resume?: boolean
  readonly harnessSessionId?: string
}

export type TerminalAdapterId = 'plain-shell' | 'claude-code' | 'codex'

export interface StartPtyResponse {
  readonly id: string
  readonly pid: number
  readonly harnessSessionId?: string
  readonly identityStatus: TerminalIdentityStatus
}

export type TerminalIdentityStatus =
  'none' | 'discovering' | 'identified' | 'ambiguous' | 'unavailable'

export interface TerminalRecoverySession {
  readonly id: string
  readonly adapterId: TerminalAdapterId
  readonly harnessSessionId?: string
  readonly hostId: string
  readonly cwd: HostPath
  readonly title: string
  readonly position: number
  readonly active: boolean
  readonly updatedAt: number
}

export interface TerminalLayoutEntry {
  readonly id: string
  readonly title: string
  readonly position: number
  readonly active: boolean
}

export interface TerminalRecoveryRequest {
  readonly root: HostPath
}

export interface TerminalLayoutRequest {
  readonly root: HostPath
  readonly sessions: readonly TerminalLayoutEntry[]
}

export interface ForgetTerminalRequest {
  readonly root: HostPath
  readonly id: string
}

/**
 * Request/response channels (renderer invokes, main handles). Add a channel by
 * adding a key here; `IpcInvokeChannel` and the preload bridge follow from it.
 */
export interface IpcInvokeMap {
  'app:info': { request: void; response: AppInfo }
  /** Round-trips text through the echo utility process (renderer→main→worker). */
  'demo:echo': { request: EchoRequest; response: EchoResponse }
  'project:root': { request: void; response: ProjectState }
  'project:hosts': { request: void; response: readonly ProjectHostOption[] }
  'project:connect-host': {
    request: ConnectHostRequest
    response: OperationResult<ConnectedHost>
  }
  'project:disconnect-host': {
    request: DisconnectHostRequest
    response: OperationResult<ProjectHostOption>
  }
  'project:browse-host': {
    request: BrowseHostRequest
    response: OperationResult<BrowseHostResponse>
  }
  'project:open': {
    request: OpenProjectRequest
    response: OperationResult<ProjectState>
  }
  'project:switch': {
    request: SwitchWorkspaceRequest
    response: OperationResult<ProjectState>
  }
  'project:refresh': {
    request: RefreshProjectRequest
    response: OperationResult<ProjectState>
  }
  'workspace:prune': {
    request: PruneProjectWorktreesRequest
    response: OperationResult<ProjectState>
  }
  'workspace:dismiss': {
    request: DismissWorkspaceRequest
    response: OperationResult<ProjectState>
  }
  'ssh:prompt-response': { request: SshPromptResponse; response: void }
  'fs:readdir': {
    request: ReadDirectoryRequest
    response: OperationResult<readonly DirEntry[]>
  }
  'fs:resolve-entry': {
    request: ReadFileRequest
    response: OperationResult<ResolveEntryResponse>
  }
  'fs:read': { request: ReadFileRequest; response: OperationResult<ReadFileResponse> }
  'fs:read-asset': {
    request: ReadFileRequest
    response: OperationResult<ReadAssetResponse>
  }
  'fs:write': { request: WriteFileRequest; response: OperationResult<WriteFileResponse> }
  'git:diff-inputs': { request: GitDiffRequest; response: GitDiffResponse }
  'git:changes': { request: GitChangesRequest; response: GitChanges }
  'git:history': { request: GitHistoryRequest; response: GitHistoryPage }
  'git:ignored-entries': {
    request: GitIgnoredEntriesRequest
    response: GitIgnoredEntriesResponse
  }
  'git:commit-detail': { request: GitCommitDetailRequest; response: GitCommitDetail }
  'git:blame': { request: GitBlameRequest; response: readonly GitBlameRun[] }
  'html-preview:create': {
    request: CreateHtmlPreviewRequest
    response: CreateHtmlPreviewResponse
  }
  'terminal:recovery': {
    request: TerminalRecoveryRequest
    response: readonly TerminalRecoverySession[]
  }
  'terminal:update-layout': { request: TerminalLayoutRequest; response: void }
  'terminal:forget': { request: ForgetTerminalRequest; response: void }
  'pty:start': { request: StartPtyRequest; response: StartPtyResponse }
}

/**
 * Fire-and-forget renderer -> main channels. PTY input uses this path so a
 * round trip is never inserted into the typing hot path.
 */
export interface IpcSendMap {
  'html-preview:release': ReleaseHtmlPreviewRequest
  'pty:write': { readonly id: string; readonly data: string }
  'pty:resize': { readonly id: string; readonly cols: number; readonly rows: number }
  'pty:kill': { readonly id: string }
  'app:attention': { readonly count: number }
}

/** Main -> renderer push channels. */
export interface IpcEventMap {
  'project:watch': WatchEvent
  'project:state': ProjectState
  'ssh:prompt': SshPromptRequest
  'ssh:prompt-cancel': { readonly hostId: string }
  'pty:data': { readonly id: string; readonly data: string }
  'pty:exit': { readonly id: string; readonly exitCode: number; readonly signal?: number }
  'pty:telemetry': {
    readonly id: string
    readonly telemetry: HarnessTelemetry | undefined
  }
  'pty:identity': {
    readonly id: string
    readonly harnessSessionId?: string
    readonly identityStatus: TerminalIdentityStatus
  }
}

export type IpcInvokeChannel = keyof IpcInvokeMap
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
  invoke<C extends IpcInvokeChannel>(
    channel: C,
    request: IpcRequest<C>,
  ): Promise<IpcResponse<C>>
  send<C extends IpcSendChannel>(channel: C, payload: IpcSendPayload<C>): void
  on<E extends IpcEventChannel>(
    channel: E,
    callback: (payload: IpcEventPayload<E>) => void,
  ): Disposer
}

/**
 * Runtime allow-list of invokable channels. The preload bridge validates
 * against this so the renderer can never reach an un-declared channel.
 */
export const INVOKE_CHANNELS = [
  'app:info',
  'demo:echo',
  'project:root',
  'project:hosts',
  'project:connect-host',
  'project:disconnect-host',
  'project:browse-host',
  'project:open',
  'project:switch',
  'project:refresh',
  'workspace:prune',
  'workspace:dismiss',
  'ssh:prompt-response',
  'fs:readdir',
  'fs:resolve-entry',
  'fs:read',
  'fs:read-asset',
  'fs:write',
  'git:diff-inputs',
  'git:changes',
  'git:history',
  'git:ignored-entries',
  'git:commit-detail',
  'git:blame',
  'html-preview:create',
  'terminal:recovery',
  'terminal:update-layout',
  'terminal:forget',
  'pty:start',
] as const satisfies readonly IpcInvokeChannel[]

export const SEND_CHANNELS = [
  'html-preview:release',
  'pty:write',
  'pty:resize',
  'pty:kill',
  'app:attention',
] as const satisfies readonly IpcSendChannel[]

export const EVENT_CHANNELS = [
  'project:watch',
  'project:state',
  'ssh:prompt',
  'ssh:prompt-cancel',
  'pty:data',
  'pty:exit',
  'pty:telemetry',
  'pty:identity',
] as const satisfies readonly IpcEventChannel[]

// Compile-time proof that INVOKE_CHANNELS stays in sync with IpcInvokeMap.
type _AssertChannelsCover = IpcInvokeChannel extends (typeof INVOKE_CHANNELS)[number]
  ? true
  : ['INVOKE_CHANNELS is missing a channel declared in IpcInvokeMap']
const _channelsCover: _AssertChannelsCover = true
void _channelsCover

type _AssertSendChannelsCover = IpcSendChannel extends (typeof SEND_CHANNELS)[number]
  ? true
  : ['SEND_CHANNELS is missing a channel declared in IpcSendMap']
const _sendChannelsCover: _AssertSendChannelsCover = true
void _sendChannelsCover

type _AssertEventChannelsCover = IpcEventChannel extends (typeof EVENT_CHANNELS)[number]
  ? true
  : ['EVENT_CHANNELS is missing a channel declared in IpcEventMap']
const _eventChannelsCover: _AssertEventChannelsCover = true
void _eventChannelsCover
