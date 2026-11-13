import type { HostPath } from './host-path'
import {
  nativeTerminalInputBytes,
  type NativeTerminalInputOperation,
  type NativeTerminalKeyEncodingFallback,
} from './native-terminal-input'
import type {
  NativeTerminalExportMode,
  NativeTerminalLinuxOptions,
} from './native-terminal-linux'

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
  readonly backingScale: number
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
  readonly ioAppliedSequence: number
  readonly ioAppliedMutation: number
  readonly inputFailure: number
  readonly appliedSequence: number
  readonly replySequence: number
  readonly queuedReplyBytes: number
  readonly failure: number
  readonly closing: boolean
  readonly rendererHealth: number
  readonly presentationFailure: number
  readonly frameCopies: number
  readonly geometryFailureSerial: number
  readonly geometry: NativeTerminalGeometry
}
/** Bounded resource facts only: process-local fds and pointers never enter this DTO. */
export interface NativeTerminalFrameResource {
  readonly fourcc: number
  readonly modifier: string
  readonly planes: readonly {
    readonly stride: number
    readonly offset: number
    readonly size: number
  }[]
}
export interface NativeTerminalFrameInfo {
  readonly snapshotMutation: number
  readonly streamSequence: number
  readonly geometrySerial: number
  readonly kind: number
  readonly width: number
  readonly height: number
  readonly colorSpace: number
  readonly origin: number
  readonly premultiplied: boolean
  readonly resource: NativeTerminalFrameResource
}
export interface NativeTerminalRendererInfo {
  readonly available: boolean
  readonly glVendor: string
  readonly glRenderer: string
  readonly glVersion: string
  readonly eglVendor: string
  readonly eglVersion: string
  readonly renderNode?: HostPath
  readonly pixelFrames: number
  readonly dmaBufFrames: number
  readonly frameCopies: number
  readonly lastFrame?: NativeTerminalFrameInfo
}
export interface NativeTerminalKeyInput {
  readonly key: number
  readonly modifiers: number
  readonly action: number
  readonly text: string
}
/** Pinned ABI4 ghostty_input_key_e ends at GHOSTTY_KEY_PASTE=175. */
export function validNativeTerminalKeyInput(value: NativeTerminalKeyInput): boolean {
  return (
    Number.isInteger(value.key) &&
    value.key >= 0 &&
    value.key <= 175 &&
    Number.isInteger(value.modifiers) &&
    value.modifiers >= 0 &&
    value.modifiers <= 1023 &&
    [0, 1, 2].includes(value.action) &&
    typeof value.text === 'string' &&
    value.text.length <= 4096 &&
    !value.text.includes('\0') &&
    new TextEncoder().encode(value.text).byteLength <= 4096
  )
}
/** Private process metadata. Platform resources travel only through the OS edge. */
export type NativeTerminalCommand =
  | { kind: 'shutdown' }
  | { kind: 'create'; width: number; height: number }
  | { kind: 'feed'; state: string; sequence: number; bytes: Uint8Array }
  | {
      kind: 'input'
      state: string
      input: NativeTerminalInputOperation
      readOnly: boolean
      keyEncodingFallback?: NativeTerminalKeyEncodingFallback
    }
  | {
      kind: 'resize'
      state: string
      serial: number
      width: number
      height: number
      backingScale?: number
    }
  | {
      kind: 'key'
      state: string
      key: number
      modifiers: number
      action: number
      text: string
    }
  | { kind: 'visibility'; state: string; visible: boolean }
  | { kind: 'presentation-mode'; state: string; mode: NativeTerminalExportMode }
  | { kind: 'pixels'; state: string; lease: string }
  | {
      kind:
        | 'inspect'
        | 'producer-inspect'
        | 'read'
        | 'drain'
        | 'event'
        | 'discard-events'
        | 'renderer-info'
        | 'destroy'
      state: string
    }
  | { kind: 'frame'; state: string; ticket: string }
  | { kind: 'transfer'; state: string; lease: string; ticket: string }
  | { kind: 'release'; state: string; lease: string }
/** Count both producer and encoder payloads in the existing physical credits. */
export function nativeTerminalCommandBytes(command: NativeTerminalCommand): number {
  return command.kind === 'input'
    ? nativeTerminalInputBytes(command.input)
    : command.kind === 'feed'
      ? command.bytes.byteLength
      : command.kind === 'key'
        ? new TextEncoder().encode(command.text).byteLength
        : 0
}
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
  readonly linux?: NativeTerminalLinuxOptions
  readonly resourceAddress: string
  readonly mainPid: number
}

/** The requested operation never reached its native caller; retry needs no replay. */
export class NativeTerminalAdmissionError extends Error {
  constructor(message = 'native-admission-bound') {
    super(message)
    this.name = 'NativeTerminalAdmissionError'
  }
}
export function validNativeTerminalExtent(width: number, height: number): boolean {
  return [width, height].every(
    (value) => Number.isInteger(value) && value >= 32 && value <= 8192,
  )
}
