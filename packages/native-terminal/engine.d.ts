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
declare const engine: {
  open(path: string): Result & { host?: Host }
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
  event(
    host: Host,
    id: bigint,
  ): Result & { event?: { kind: number; truncated: boolean; data: Buffer } }
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
