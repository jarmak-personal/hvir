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
  appliedAppearanceSerial: bigint
  appearanceFailureSerial: bigint
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
  screen: 0 | 1
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
export interface SelectionContext {
  screen: 0 | 1
  geometrySerial: bigint
}
export interface SelectionResult extends Result {
  effectSerialCutoff: bigint
  column?: number
  clickedByteOffset?: bigint
  stale: boolean
  hasSelection: boolean
  selectionSerial: bigint
  screen: 0 | 1
  geometrySerial: bigint
  requestedMutation: bigint
}
export interface ExtractionChunk extends Result {
  clickedByteOffset?: bigint
  stale: boolean
  cursor: bigint
  selectionSerial: bigint
  data: Buffer
  done: boolean
  visited: number
  work: number
}
/** Query-owned IDs and cell coordinates are observations, never caller authority. */
export interface QueryMatch {
  occurrence: bigint
  index: number
  screen: 0 | 1
  row: number
  column: number
  endRow: number
  endColumn: number
}
export interface QueryResult extends Result {
  stale: boolean
}
export interface QueryStatus extends QueryResult {
  query: bigint
  revision: bigint
  count: number
  /** 0 running; 1 waiting for source feed; 2 caught up with current source. */
  status: 0 | 1 | 2
  work: number
  visited: number
}
export interface SemanticBoundary {
  boundary: bigint
  screen: 0 | 1
  row: number
  column: number
}
export interface QueryResolution {
  resolved: boolean
  revealed: boolean
  match?: QueryMatch
  boundary?: SemanticBoundary
}
export type RetainedRange =
  | { kind: 'match'; query: bigint; occurrence: bigint }
  | { kind: 'semantic'; start: bigint; end?: bigint }
export interface InputResult extends Result {
  hasSelection?: boolean
  selectionSerial?: bigint
  selectionResult?: 0 | 5 | 6 | 7
  linkCandidate?: boolean
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
    selectionContext?: SelectionContext,
  ): InputResult
  selection(
    host: Host,
    id: bigint,
    action: 'state' | 'select-all' | 'selection-clear' | 'clear' | 'reset',
    context: SelectionContext,
  ): SelectionResult
  extractBegin(
    host: Host,
    id: bigint,
    selectionSerial: bigint,
    context: SelectionContext,
  ): SelectionResult & { cursor: bigint }
  extractNext(host: Host, id: bigint, cursor: bigint): ExtractionChunk
  extractFinish(
    host: Host,
    id: bigint,
    cursor: bigint,
  ): SelectionResult & Partial<QueryResolution>
  extractClose(host: Host, id: bigint, cursor: bigint): Result
  queryContext(
    host: Host,
    id: bigint,
  ): QueryResult & { screen: 0 | 1; geometrySerial: bigint }
  queryBegin(
    host: Host,
    id: bigint,
    needle: string,
    caseSensitive: boolean,
  ): QueryResult & { query?: bigint }
  queryStep(host: Host, id: bigint, query: bigint): QueryStatus
  queryPage(
    host: Host,
    id: bigint,
    query: bigint,
    revision: bigint,
    offset: number,
    capacity: number,
  ): QueryResult & { revision: bigint; count: number; results: QueryMatch[] }
  queryResolveBegin(
    host: Host,
    id: bigint,
    query: bigint,
    occurrence: bigint,
    reveal: boolean,
    context: SelectionContext,
  ): SelectionResult & { cursor: bigint }
  queryClearReveal(host: Host, id: bigint, query: bigint): QueryResult
  queryClose(host: Host, id: bigint, query: bigint): QueryResult
  rangeBegin(
    host: Host,
    id: bigint,
    range: RetainedRange,
    context: SelectionContext,
  ): SelectionResult & { cursor: bigint }
  semanticBoundaryCaptureEnd(
    host: Host,
    id: bigint,
    context: SelectionContext,
  ): QueryResult & Partial<SemanticBoundary>
  semanticBoundaryResolveBegin(
    host: Host,
    id: bigint,
    boundary: bigint,
    reveal: boolean,
    context: SelectionContext,
  ): SelectionResult & { cursor: bigint }
  semanticBoundaryClose(host: Host, id: bigint, boundary: bigint): QueryResult
  linkCurrent(
    host: Host,
    id: bigint,
    query: { x: number; y: number; screen: 0 | 1; geometrySerial: bigint },
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
  linkRowBegin(
    host: Host,
    id: bigint,
    query: { x: number; y: number; screen: 0 | 1; geometrySerial: bigint },
  ): SelectionResult & {
    cursor: bigint
    column: number
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
  /** Enqueue only; inspect.appliedAppearanceSerial certifies native application. */
  appearance(
    host: Host,
    id: bigint,
    serial: bigint,
    value: import('../../src/shared/native-terminal-appearance').NativeTerminalAppearance,
  ): Result & { requestedMutation: bigint }
  visibility(host: Host, id: bigint, visible: boolean): Result
  copyFrame(
    host: Host,
    id: bigint,
    lease: bigint,
    capacity: number,
  ): Result & { data?: Uint8Array; stride?: number }
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
      /** Present only for an authenticated parser-time semantic location. */
      boundary?: bigint
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
  retireFrameBegin(host: Host, id: bigint, lease: bigint): Result & { request?: bigint }
  retireFrameStatus(
    host: Host,
    id: bigint,
    lease: bigint,
    request: bigint,
  ): Result & { status?: number }
  destroy(host: Host, id: bigint): Result
  close(host: Host): Result
}
export default engine
