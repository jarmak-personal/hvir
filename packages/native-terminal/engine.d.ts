import type { NativeTerminalInputOperation } from '../../src/shared/native-terminal-input'
export interface Geometry {
  serial: bigint
  backingScale: number
  columns: number
  rows: number
  width: number
  height: number
  cellWidth: number
  cellHeight: number
  contentWidth: number
  contentHeight: number
  paddingLeft: number
  paddingTop: number
}
export interface Status {
  ioAppliedMutation: bigint
  ioAppliedSequence: bigint
  inputFailure: number
  appliedSequence: bigint
  frameCopies: bigint
  geometryFailureSerial: bigint
  replySequence: bigint
  queuedReplyBytes: number
  failure: number
  closing: boolean
  rendererHealth: number
  presentationFailure: number
  geometry: Geometry
}
export interface Frame {
  lease: bigint
  streamSequence: bigint
  geometrySerial: bigint
  snapshotMutation: bigint
  kind: number
  width: number
  height: number
  fourcc: number
  premultiplied: boolean
  colorSpace: number
  origin: number
  modifier: bigint
  planeCount: number
  surface?: Buffer
  planes: { fd: number; stride: number; offset: number; size: bigint }[]
  pixels?: Buffer
}
export interface Host {
  readonly nativeTerminalHost: unique symbol
}
export interface Result {
  result: number
}
export interface RendererInfo {
  available: boolean
  glVendor: string
  glRenderer: string
  glVersion: string
  eglVendor: string
  eglVersion: string
  renderNode: string
  pixelFrames: bigint
  dmaBufFrames: bigint
}
export interface InputResult extends Result {
  data?: Buffer
  capacity?: number
  source?: 'user' | 'terminal-response'
  requestedMutation?: bigint
  captured?: boolean
  caret?: { x: number; y: number; width: number; height: number; geometrySerial: bigint }
}
declare const engine: {
  input(
    host: Host,
    id: bigint,
    operation: NativeTerminalInputOperation,
    readOnly?: boolean,
    keyEncodingFallback?: 'csi-u' | 'modify-other-keys',
  ): InputResult
  open(
    path: string,
    options?: { renderNode?: string; presentationMode?: 'auto' | 'pixels' },
  ): Result & { host?: Host }
  presentationMode(host: Host, id: bigint, mode: 0 | 1): Result
  rendererInfo(host: Host, id: bigint): Result & { info?: RendererInfo }
  createBegin(host: Host, width: number, height: number): Result & { id?: bigint }
  feed(host: Host, id: bigint, sequence: bigint, bytes: Uint8Array): Result
  resize(
    host: Host,
    id: bigint,
    serial: bigint,
    width: number,
    height: number,
    backingScale?: number,
  ): Result
  visibility(host: Host, id: bigint, visible: boolean): Result
  copyFrame(
    host: Host,
    id: bigint,
    lease: bigint,
    capacity: number,
  ): Result & { data?: Buffer; stride?: number }
  inspect(host: Host, id: bigint): Result & { status?: Status }
  read(host: Host, id: bigint, capacity: number): Result & { data?: Buffer }
  drain(host: Host, id: bigint, capacity: number): Result & { data?: Buffer }
  link(
    host: Host,
    id: bigint,
    query: {
      row: number
      column: number
      screen: number
      expectedSequence: bigint
      expectedMutation: bigint
      expectedGeometrySerial: bigint
    },
  ): Result & {
    link?: {
      uri: Buffer
      screen: number
      row: number
      column: number
      streamSequence: bigint
      snapshotMutation: bigint
      geometrySerial: bigint
    }
  }
  event(
    host: Host,
    id: bigint,
  ): Result & {
    droppedEffects: bigint
    semanticGeneration: bigint
    event?: {
      kind: number
      action: number
      screen: number
      row: number
      column: number
      sequence: bigint
      eventSerial: bigint
      truncated: boolean
      data: Buffer
      extra: Buffer
    }
  }
  key(
    host: Host,
    id: bigint,
    key: number,
    modifiers: number,
    action: number,
    text: string,
    capacity: number,
  ): Result & { data?: Buffer }
  takeFrame(host: Host, id: bigint): Result & { frame?: Frame }
  releaseFrame(host: Host, id: bigint, lease: bigint): Result
  destroy(host: Host, id: bigint): Result
  close(host: Host): Result
}
export default engine
