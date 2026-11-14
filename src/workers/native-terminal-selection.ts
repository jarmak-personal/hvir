import {
  validNativeTerminalSelectionOperation,
  type NativeTerminalSelectionOperation,
} from '../shared/native-terminal-selection'

export interface NativeSelectionEngineResult {
  result: number
  stale?: boolean
  hasSelection?: boolean
  selectionSerial?: bigint
  screen?: number
  geometrySerial?: bigint
  requestedMutation?: bigint
  cursor?: bigint
  column?: number
  clickedByteOffset?: bigint
  data?: Uint8Array
  done?: boolean
  visited?: number
  work?: number
  link?: unknown
}

function counter(value: unknown): number {
  if (typeof value !== 'bigint' || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('native-selection-counter-invalid')
  return Number(value)
}

/** One physical native step. The parent schedules each continuation independently. */
export async function runNativeSelectionStep(
  operation: NativeTerminalSelectionOperation,
  invoke: (
    operation: NativeTerminalSelectionOperation,
  ) => Promise<NativeSelectionEngineResult>,
  cancelled: () => boolean,
) {
  if (!validNativeTerminalSelectionOperation(operation))
    throw new Error('native-selection-command-invalid')
  const value = await invoke(operation)
  const begin = operation.kind === 'begin' || operation.kind === 'link-row-begin'
  let closing = false
  const close = async () => {
    if (closing || !begin || typeof value.cursor !== 'bigint' || value.cursor <= 0n)
      return
    closing = true
    const closed = await invoke({ kind: 'close', cursor: value.cursor.toString() })
    if (closed.result !== 0) throw new Error('native-selection-cancel-cleanup-failed')
  }
  try {
    if (begin && cancelled()) throw new Error('cancelled')
    const result = normalize(operation, value)
    if ('unavailable' in result) await close()
    return result
  } catch (error) {
    await close()
    throw error
  }
}

function normalize(
  operation: NativeTerminalSelectionOperation,
  value: NativeSelectionEngineResult,
) {
  if (value.result !== 0) {
    if (![1, 5, 6, 7].includes(value.result) || typeof value.stale !== 'boolean')
      throw new Error('native-selection-result-invalid')
    if (operation.kind === 'next') {
      if (
        !(value.data instanceof Uint8Array) ||
        value.data.byteLength !== 0 ||
        !Number.isInteger(value.visited) ||
        value.visited! < 0 ||
        value.visited! > 8192 ||
        !Number.isInteger(value.work) ||
        value.work! < 0 ||
        value.work! > 8192
      )
        throw new Error('native-selection-refusal-invalid')
      return {
        unavailable: value.result,
        stale: value.stale,
        visited: value.visited!,
        work: value.work!,
      }
    }
    return { unavailable: value.result, stale: value.stale }
  }
  if (operation.kind === 'close') return { result: 0 }
  if (typeof value.stale !== 'boolean' || value.stale)
    throw new Error('native-selection-result-invalid')
  const selectionSerial = counter(value.selectionSerial)
  if (operation.kind === 'next') {
    if (
      typeof value.cursor !== 'bigint' ||
      value.cursor.toString() !== operation.cursor ||
      !(value.data instanceof Uint8Array) ||
      value.data.byteLength > 65536 ||
      typeof value.done !== 'boolean' ||
      !Number.isInteger(value.visited) ||
      value.visited! < 0 ||
      value.visited! > 8192 ||
      !Number.isInteger(value.work) ||
      value.work! < 0 ||
      value.work! > 8192 ||
      (!value.done && value.work === 0 && value.data.byteLength === 0)
    )
      throw new Error('native-selection-chunk-invalid')
    return {
      cursor: operation.cursor,
      selectionSerial,
      data: value.data,
      done: value.done,
      visited: value.visited!,
      work: value.work!,
      ...(value.clickedByteOffset === undefined
        ? {}
        : { clickedByteOffset: counter(value.clickedByteOffset) }),
    }
  }
  if (typeof value.hasSelection !== 'boolean' || ![0, 1].includes(value.screen!))
    throw new Error('native-selection-state-invalid')
  const result = {
    hasSelection: value.hasSelection,
    selectionSerial,
    screen: value.screen as 0 | 1,
    geometrySerial: counter(value.geometrySerial),
    requestedMutation: counter(value.requestedMutation),
    ...(value.clickedByteOffset === undefined
      ? {}
      : { clickedByteOffset: counter(value.clickedByteOffset) }),
  }
  if (operation.kind !== 'begin' && operation.kind !== 'link-row-begin') return result
  if (typeof value.cursor !== 'bigint' || value.cursor < 0n)
    throw new Error('native-selection-cursor-invalid')
  if (
    operation.kind === 'link-row-begin' &&
    (!Number.isInteger(value.column) || value.column! < 0 || value.column! > 0xffffffff)
  )
    throw new Error('native-link-column-invalid')
  return {
    ...result,
    cursor: value.cursor.toString(),
    ...(operation.kind === 'link-row-begin'
      ? {
          column: value.column,
          ...(value.link === undefined ? {} : { link: link(value.link) }),
        }
      : {}),
  }
}

function link(value: unknown) {
  if (!value || typeof value !== 'object') throw new Error('native-link-result-invalid')
  const data = value as Record<string, unknown>
  if (
    typeof data.uri !== 'string' ||
    !data.uri.length ||
    data.uri.length > 65536 ||
    Buffer.byteLength(data.uri) > 65536 ||
    data.uri.includes('\0') ||
    (data.screen !== 0 && data.screen !== 1) ||
    ![data.row, data.column].every(
      (n) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 0xffffffff,
    )
  )
    throw new Error('native-link-result-invalid')
  return {
    uri: data.uri,
    screen: data.screen,
    row: data.row as number,
    column: data.column as number,
    streamSequence: counter(data.streamSequence),
    snapshotMutation: counter(data.snapshotMutation),
    geometrySerial: counter(data.geometrySerial),
  }
}
