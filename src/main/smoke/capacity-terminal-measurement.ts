import type { CapacityTerminalTag } from './capacity-terminal-tags'
import type { CapacityTerminalComparisonMeasurement } from './capacity-terminal-comparison'

export type CapacityTerminalScrollProof =
  | { engine: 'web'; viewportY: number; expectedViewportY: number }
  | {
      engine: 'native'
      sequence: number
      requestedMutation: number
      ioAppliedMutation: number
      frameSnapshotMutation: number
      viewId: string
      nativeEpoch: string
      attachment: number
      geometrySerial: number
      frameGeometrySerial: number
    }
interface AppliedGrid {
  engine: 'web' | 'native'
  columns: number
  rows: number
  viewId?: string
  nativeEpoch?: string
  attachment?: number
  geometrySerial?: number
}
export interface CapacityTerminalObservation {
  startedAtMs: number
  firstMatchingVisibleFrameAtMs: number
  stateCheckedAtMs: number
  captureRequestedAtMs: number
  captureCompletedAtMs: number
  layout: AppliedGrid
  stateProof?: CapacityTerminalScrollProof
}
interface ObservedSample {
  startedAtMs: number
  firstMatchingVisibleFrameAtMs: number
  stateCheckedAtMs: number
  captured: { requestedAtMs: number; completedAtMs: number }
  layout: AppliedGrid
  tag: CapacityTerminalTag
  expectedTag: CapacityTerminalTag
  expectedViewport: { columns: number; rows: number }
  expectedInputSequence: number
  observedInputSequence: number
  stateProof?: CapacityTerminalScrollProof
}

/** Preserve the actual fixture's evidence across the process JSON boundary. */
export function capacityTerminalMeasurement(
  value: ObservedSample,
  sequence: number,
): CapacityTerminalComparisonMeasurement {
  const tag = (value: CapacityTerminalTag) =>
    [value.row, value.sequence, value.columns, value.rows].join(':')
  const grid = (value: { columns: number; rows: number }) =>
    [value.columns, value.rows].join(':')
  return {
    sequence,
    durationMs: value.captured.completedAtMs - value.startedAtMs,
    expectedTag: tag(value.expectedTag),
    observedTag: tag(value.tag),
    expectedGeometry: grid(value.expectedViewport),
    observedGeometry: grid(value.layout),
    expectedInputSequence: value.expectedInputSequence,
    observedInputSequence: value.observedInputSequence,
    terminalObservation: {
      startedAtMs: value.startedAtMs,
      firstMatchingVisibleFrameAtMs: value.firstMatchingVisibleFrameAtMs,
      stateCheckedAtMs: value.stateCheckedAtMs,
      captureRequestedAtMs: value.captured.requestedAtMs,
      captureCompletedAtMs: value.captured.completedAtMs,
      layout: {
        engine: value.layout.engine,
        columns: value.layout.columns,
        rows: value.layout.rows,
        ...(value.layout.engine === 'native'
          ? {
              viewId: value.layout.viewId,
              nativeEpoch: value.layout.nativeEpoch,
              attachment: value.layout.attachment,
              geometrySerial: value.layout.geometrySerial,
            }
          : {}),
      },
      ...(value.stateProof ? { stateProof: value.stateProof } : {}),
    },
  }
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const time = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
const serial = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0
const opaque = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 200

/** Validate retained clocks and engine-specific state without inventing missing facts. */
export function validCapacityTerminalObservation(
  measurement: Record<string, unknown>,
  engine: unknown,
  scroll: boolean,
): boolean {
  if (engine !== 'web' && engine !== 'native') return false
  const value = measurement.terminalObservation
  if (!record(value) || !record(value.layout)) return false
  const layout = value.layout
  const {
    startedAtMs: start,
    firstMatchingVisibleFrameAtMs: first,
    stateCheckedAtMs: state,
    captureRequestedAtMs: request,
    captureCompletedAtMs: end,
  } = value
  if (
    !time(start) ||
    !time(first) ||
    !time(state) ||
    !time(request) ||
    !time(end) ||
    start > first ||
    first > end ||
    start > state ||
    state > request ||
    request > end ||
    measurement.durationMs !== end - start ||
    layout.engine !== engine ||
    !serial(layout.columns) ||
    !serial(layout.rows) ||
    measurement.observedGeometry !== [layout.columns, layout.rows].join(':')
  )
    return false
  if (
    engine === 'native' &&
    (!opaque(layout.viewId) ||
      !opaque(layout.nativeEpoch) ||
      !serial(layout.attachment) ||
      !serial(layout.geometrySerial))
  )
    return false
  if (!scroll) return value.stateProof === undefined
  const proof = value.stateProof
  if (!record(proof) || proof.engine !== engine) return false
  if (engine === 'web')
    return (
      time(proof.viewportY) &&
      Number.isSafeInteger(proof.viewportY) &&
      proof.viewportY === proof.expectedViewportY
    )
  return (
    proof.sequence === measurement.observedInputSequence &&
    serial(proof.sequence) &&
    serial(proof.requestedMutation) &&
    time(proof.ioAppliedMutation) &&
    Number.isSafeInteger(proof.ioAppliedMutation) &&
    proof.ioAppliedMutation >= proof.requestedMutation &&
    time(proof.frameSnapshotMutation) &&
    Number.isSafeInteger(proof.frameSnapshotMutation) &&
    proof.frameSnapshotMutation >= proof.requestedMutation &&
    proof.viewId === layout.viewId &&
    proof.nativeEpoch === layout.nativeEpoch &&
    proof.attachment === layout.attachment &&
    proof.geometrySerial === layout.geometrySerial &&
    proof.frameGeometrySerial === layout.geometrySerial
  )
}
