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
import type { DirEntry, WatchEvent } from './fs-types'
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
  GitBlameLine,
  GitBlameRequest,
  GitChanges,
  GitChangesRequest,
  GitCommitDetail,
  GitCommitDetailRequest,
  GitHistoryPage,
  GitHistoryRequest,
} from './git-types'
import type { HostConnectionState, HostWatchTier } from './fs-types'

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
}

export interface OpenProjectRequest {
  readonly hostId: string
  readonly path: string
}

export interface SshPromptRequest {
  readonly id: number
  readonly kind: 'password' | 'passphrase' | 'keyboard-interactive' | 'host-key'
  readonly title: string
  readonly instructions?: string
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

export interface ReadFileResponse {
  readonly path: HostPath
  readonly content: string
  readonly size: number
  readonly mtimeMs: number
  readonly binary: boolean
}

export interface StartPtyRequest {
  readonly sessionId: string
  readonly cwd: HostPath
  readonly cols: number
  readonly rows: number
}

export interface StartPtyResponse {
  readonly id: string
  readonly pid: number
}

/**
 * Request/response channels (renderer invokes, main handles). Add a channel by
 * adding a key here; `IpcInvokeChannel` and the preload bridge follow from it.
 */
export interface IpcInvokeMap {
  'app:info': { request: void; response: AppInfo }
  /** Round-trips text through the echo utility process (renderer→main→worker). */
  'demo:echo': { request: EchoRequest; response: EchoResponse }
  'project:root': { request: void; response: ProjectRootResponse }
  'project:hosts': { request: void; response: readonly ProjectHostOption[] }
  'project:open': { request: OpenProjectRequest; response: ProjectState }
  'ssh:prompt-response': { request: SshPromptResponse; response: void }
  'fs:readdir': { request: ReadDirectoryRequest; response: readonly DirEntry[] }
  'fs:read': { request: ReadFileRequest; response: ReadFileResponse }
  'fs:write': { request: WriteFileRequest; response: WriteFileResponse }
  'git:diff-inputs': { request: GitDiffRequest; response: GitDiffResponse }
  'git:changes': { request: GitChangesRequest; response: GitChanges }
  'git:history': { request: GitHistoryRequest; response: GitHistoryPage }
  'git:commit-detail': { request: GitCommitDetailRequest; response: GitCommitDetail }
  'git:blame': { request: GitBlameRequest; response: readonly GitBlameLine[] }
  'html-preview:create': {
    request: CreateHtmlPreviewRequest
    response: CreateHtmlPreviewResponse
  }
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
}

/** Main -> renderer push channels. */
export interface IpcEventMap {
  'project:watch': WatchEvent
  'project:state': ProjectState
  'ssh:prompt': SshPromptRequest
  'pty:data': { readonly id: string; readonly data: string }
  'pty:exit': { readonly id: string; readonly exitCode: number; readonly signal?: number }
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
  'project:open',
  'ssh:prompt-response',
  'fs:readdir',
  'fs:read',
  'fs:write',
  'git:diff-inputs',
  'git:changes',
  'git:history',
  'git:commit-detail',
  'git:blame',
  'html-preview:create',
  'pty:start',
] as const satisfies readonly IpcInvokeChannel[]

export const SEND_CHANNELS = [
  'html-preview:release',
  'pty:write',
  'pty:resize',
  'pty:kill',
] as const satisfies readonly IpcSendChannel[]

export const EVENT_CHANNELS = [
  'project:watch',
  'project:state',
  'ssh:prompt',
  'pty:data',
  'pty:exit',
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
