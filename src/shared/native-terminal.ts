import type { HostPath } from './host-path'

/** Main resolves these values; an incoming renderer copy grants no authority. */
export interface NativeTerminalSession {
  readonly sessionId: string
  readonly instanceId: string
  readonly ownerId: number
  readonly ownerGeneration: number
  readonly workspaceRoot: HostPath
}
export interface NativeTerminalGeometry {
  readonly serial: number
  readonly columns: number
  readonly rows: number
  readonly width: number
  readonly height: number
  readonly cellWidth: number
  readonly cellHeight: number
  readonly contentWidth: number
  readonly contentHeight: number
  readonly paddingLeft: number
  readonly paddingTop: number
}
export const NATIVE_TERMINAL_LIMITS = {
  states: 32,
  commands: 64,
  commandsPerState: 8,
  queuedBytes: 1024 * 1024,
  queuedBytesPerState: 128 * 1024,
  feedChunkBytes: 16 * 1024,
  responseBytes: 64 * 1024,
  requestMs: 15000,
  frameTransfers: 3,
} as const
export interface NativeTerminalStatus {
  readonly appliedSequence: number
  readonly replySequence: number
  readonly queuedReplyBytes: number
  readonly failure: number
  readonly closing: boolean
  readonly rendererHealth: number
  readonly presentationFailure: number
  readonly geometry: NativeTerminalGeometry
}
/** Private process metadata. Platform resources travel only through the OS edge. */
export type NativeTerminalCommand =
  | { kind: 'shutdown' }
  | { kind: 'create'; width: number; height: number }
  | { kind: 'feed'; state: string; sequence: number; bytes: Uint8Array }
  | { kind: 'resize'; state: string; serial: number; width: number; height: number }
  | { kind: 'inspect' | 'read' | 'drain' | 'event' | 'destroy'; state: string }
  | { kind: 'frame'; state: string; ticket: string }
  | { kind: 'transfer'; state: string; lease: string; ticket: string }
  | { kind: 'release'; state: string; lease: string }
export interface NativeTerminalRequest {
  readonly kind: 'request'
  readonly epoch: string
  readonly id: number
  readonly command: NativeTerminalCommand
}
export type NativeTerminalHostMessage =
  | { kind: 'ready'; epoch: string; pid: number }
  | { kind: 'result'; epoch: string; id: number; ok: true; value: unknown }
  | { kind: 'result'; epoch: string; id: number; ok: false; error: string }
export interface NativeTerminalWorkerOptions {
  readonly epoch: string
  readonly library: string
  readonly resourceAddress: string
  readonly mainPid: number
}
