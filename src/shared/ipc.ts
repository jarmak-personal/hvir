/**
 * The typed IPC contract (renderer <-> main).
 *
 * This is the *single* source of truth for channel names and their
 * request/response shapes. Nothing outside this module and the preload bridge
 * may name a raw channel string; the renderer calls `window.hvir.invoke(...)`,
 * which is typed entirely against the maps below. Adding an IPC surface means
 * adding an entry here first.
 */

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

/**
 * Request/response channels (renderer invokes, main handles). Add a channel by
 * adding a key here; `IpcInvokeChannel` and the preload bridge follow from it.
 */
export interface IpcInvokeMap {
  'app:info': { request: void; response: AppInfo }
  /** Round-trips text through the echo utility process (renderer→main→worker). */
  'demo:echo': { request: EchoRequest; response: EchoResponse }
}

/**
 * Fire-and-forget push channels (main emits, renderer listens). Empty for
 * Phase 1 — notification dots, watch events, and PTY streams land here later.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface IpcEventMap {}

export type IpcInvokeChannel = keyof IpcInvokeMap
export type IpcEventChannel = keyof IpcEventMap

export type IpcRequest<C extends IpcInvokeChannel> = IpcInvokeMap[C]['request']
export type IpcResponse<C extends IpcInvokeChannel> = IpcInvokeMap[C]['response']
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
}

/**
 * Runtime allow-list of invokable channels. The preload bridge validates
 * against this so the renderer can never reach an un-declared channel.
 */
export const INVOKE_CHANNELS = ['app:info', 'demo:echo'] as const

// Compile-time proof that INVOKE_CHANNELS stays in sync with IpcInvokeMap.
type _AssertChannelsCover = IpcInvokeChannel extends (typeof INVOKE_CHANNELS)[number]
  ? true
  : ['INVOKE_CHANNELS is missing a channel declared in IpcInvokeMap']
const _channelsCover: _AssertChannelsCover = true
void _channelsCover
