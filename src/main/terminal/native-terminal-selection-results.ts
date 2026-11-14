import {
  NativeTerminalSelectionRefused,
  validNativeTerminalSelectionCursor,
  type NativeTerminalSelectionChunk,
  type NativeTerminalSelectionContext,
  type NativeTerminalSelectionNativeResult,
} from '../../shared/native-terminal-selection'

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object')
    throw new Error('native-selection-result-invalid')
  const result = value as Record<string, unknown>
  if ('unavailable' in result) {
    if (
      typeof result.unavailable !== 'number' ||
      ![1, 5, 6, 7].includes(result.unavailable) ||
      typeof result.stale !== 'boolean'
    )
      throw new Error('native-selection-refusal-invalid')
    throw new NativeTerminalSelectionRefused(
      result.unavailable as 1 | 5 | 6 | 7,
      result.stale,
    )
  }
  return result
}
const counter = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export function nativeSelectionState(
  value: unknown,
  context: NativeTerminalSelectionContext,
): NativeTerminalSelectionNativeResult {
  const state = object(value)
  if (
    typeof state.hasSelection !== 'boolean' ||
    !counter(state.selectionSerial) ||
    !counter(state.requestedMutation) ||
    state.screen !== context.screen ||
    state.geometrySerial !== context.geometrySerial ||
    (state.cursor !== undefined &&
      state.cursor !== '0' &&
      !validNativeTerminalSelectionCursor(state.cursor)) ||
    (state.clickedByteOffset !== undefined && !counter(state.clickedByteOffset))
  )
    throw new Error('native-selection-state-invalid')
  if (state.column !== undefined && (!counter(state.column) || state.column > 0xffffffff))
    throw new Error('native-link-column-invalid')
  return state as unknown as NativeTerminalSelectionNativeResult
}

export function nativeSelectionChunk(
  value: unknown,
  cursor: string,
): NativeTerminalSelectionChunk {
  const chunk = object(value)
  if (
    chunk.cursor !== cursor ||
    !counter(chunk.selectionSerial) ||
    !(chunk.data instanceof Uint8Array) ||
    chunk.data.byteLength > 65536 ||
    typeof chunk.done !== 'boolean' ||
    !counter(chunk.visited) ||
    chunk.visited > 8192 ||
    !counter(chunk.work) ||
    chunk.work > 8192 ||
    (!chunk.done && !chunk.data.byteLength && chunk.work === 0) ||
    (chunk.clickedByteOffset !== undefined && !counter(chunk.clickedByteOffset))
  )
    throw new Error('native-selection-chunk-invalid')
  return chunk as unknown as NativeTerminalSelectionChunk
}
