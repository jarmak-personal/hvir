import {
  validNativeTerminalQueryOperation,
  nativeTerminalQueryAcquiresCursor,
  nativeQueryUnsentBusy,
  type NativeTerminalQueryOperation,
} from '../shared/native-terminal-query-operations'
import { NATIVE_TERMINAL_LIMITS } from '../shared/native-terminal'

export interface NativeQueryEngineResult {
  result: number
  stale?: boolean
  query?: bigint
  revision?: bigint
  count?: number
  status?: unknown
  work?: number
  visited?: number
  results?: unknown[]
  cursor?: bigint
  data?: Uint8Array
  done?: boolean
  selectionSerial?: bigint
  hasSelection?: boolean
  screen?: number
  geometrySerial?: bigint
  requestedMutation?: bigint
  resolved?: boolean
  revealed?: boolean
  match?: unknown
  boundary?: unknown
}
type EngineResult = NativeQueryEngineResult
type Invoke = (operation: NativeTerminalQueryOperation) => Promise<EngineResult>

/** Failed physical cleanup retains its exact identity for the host failure fence. */
export class NativeQueryCleanupFailed extends Error {
  readonly cleanup: NativeTerminalQueryOperation
  constructor(cleanup: NativeTerminalQueryOperation, cause: unknown) {
    super('native-query-cancel-cleanup-failed', { cause })
    this.cleanup = Object.freeze({ ...cleanup })
  }
}

function counter(value: unknown): number {
  if (typeof value !== 'bigint' || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('native-query-counter-invalid')
  return Number(value)
}
function token(value: unknown): string {
  if (typeof value !== 'bigint' || value <= 0n || value > 0xffffffffffffffffn)
    throw new Error('native-query-token-invalid')
  return value.toString()
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('native-query-count-invalid')
  return value
}
function screen(value: unknown): 0 | 1 {
  if (value !== 0 && value !== 1) throw new Error('native-query-screen-invalid')
  return value
}
function boundedWork(value: unknown): number {
  const result = count(value)
  if (result > 8192) throw new Error('native-query-work-invalid')
  return result
}

/** One physical native call; a cancelled acquisition still closes its exact resource. */
export async function runNativeQueryStep(
  operation: NativeTerminalQueryOperation,
  invoke: Invoke,
  cancelled: () => boolean,
) {
  if (!validNativeTerminalQueryOperation(operation))
    throw new Error('native-query-operation-invalid')
  const value = await invoke(operation)
  const acquiringCursor = nativeTerminalQueryAcquiresCursor(operation)
  let closing = false
  const cleanup = async () => {
    if (closing) return
    let close: NativeTerminalQueryOperation | undefined
    if (acquiringCursor && typeof value.cursor === 'bigint' && value.cursor > 0n)
      close = { kind: 'close', cursor: token(value.cursor) }
    else if (
      operation.kind === 'query-begin' &&
      typeof value.query === 'bigint' &&
      value.query > 0n
    )
      close = { kind: 'query-close', query: token(value.query) }
    if (!close) return
    closing = true
    try {
      const deadline = Date.now() + NATIVE_TERMINAL_LIMITS.requestMs
      for (;;) {
        const result = await invoke(close)
        if (result.result === 0) return
        if (!nativeQueryUnsentBusy(result.result, result.stale) || Date.now() >= deadline)
          throw new Error('native-query-cleanup-refused-or-timeout', {
            cause: { result: result.result, stale: result.stale },
          })
        await new Promise<void>((resolve) => setTimeout(resolve, 1))
      }
    } catch (cause) {
      throw new NativeQueryCleanupFailed(close, cause)
    }
  }
  try {
    if ((acquiringCursor || operation.kind === 'query-begin') && cancelled())
      throw new Error('cancelled')
    const normalized = normalize(operation, value)
    if ('unavailable' in normalized) await cleanup()
    return normalized
  } catch (error) {
    await cleanup()
    throw error
  }
}

function normalize(operation: NativeTerminalQueryOperation, value: EngineResult) {
  if (value.result !== 0) {
    if (![1, 5, 6, 7].includes(value.result) || typeof value.stale !== 'boolean')
      throw new Error('native-query-result-invalid')
    if (operation.kind === 'next') {
      if (!(value.data instanceof Uint8Array) || value.data.byteLength !== 0)
        throw new Error('native-query-refusal-invalid')
      return {
        unavailable: value.result,
        stale: value.stale,
        work: boundedWork(value.work),
        visited: boundedWork(value.visited),
      }
    }
    return { unavailable: value.result, stale: value.stale }
  }
  switch (operation.kind) {
    case 'query-context':
      return {
        screen: screen(value.screen),
        geometrySerial: counter(value.geometrySerial),
      }
    case 'query-close':
    case 'query-clear-reveal':
    case 'boundary-close':
    case 'close':
      return { result: 0 }
    case 'query-begin':
      return { query: token(value.query) }
    case 'query-step': {
      const status = count(value.status)
      if (token(value.query) !== operation.query || ![0, 1, 2].includes(status))
        throw new Error('native-query-status-invalid')
      const work = boundedWork(value.work)
      if (status === 0 && work === 0) throw new Error('native-query-progress-invalid')
      return {
        query: operation.query,
        revision: token(value.revision),
        count: count(value.count),
        status,
        work,
        visited: boundedWork(value.visited),
      }
    }
    case 'query-page': {
      if (
        token(value.revision) !== operation.revision ||
        !Array.isArray(value.results) ||
        value.results.length > operation.capacity
      )
        throw new Error('native-query-page-invalid')
      const results = value.results.map(match)
      for (let index = 0; index < results.length; index++)
        if (results[index]!.index !== operation.offset + index)
          throw new Error('native-query-order-invalid')
      return { revision: operation.revision, count: count(value.count), results }
    }
    case 'next': {
      if (
        token(value.cursor) !== operation.cursor ||
        !(value.data instanceof Uint8Array) ||
        value.data.byteLength > 65536 ||
        typeof value.done !== 'boolean' ||
        typeof value.stale !== 'boolean' ||
        value.stale
      )
        throw new Error('native-query-chunk-invalid')
      const work = boundedWork(value.work)
      if (!value.done && !value.data.byteLength && work === 0)
        throw new Error('native-query-progress-invalid')
      return {
        cursor: operation.cursor,
        selectionSerial: counter(value.selectionSerial),
        data: value.data,
        done: value.done,
        work,
        visited: boundedWork(value.visited),
      }
    }
    case 'resolve-begin':
    case 'range-begin':
    case 'boundary-resolve-begin':
      return { ...state(value), cursor: value.cursor === 0n ? '0' : token(value.cursor) }
    case 'finish': {
      const result = state(value)
      if (value.resolved === undefined && value.revealed === undefined) return result
      if (
        typeof value.resolved !== 'boolean' ||
        typeof value.revealed !== 'boolean' ||
        (value.revealed && !value.resolved) ||
        (value.resolved && (value.match === undefined) === (value.boundary === undefined))
      )
        throw new Error('native-query-resolution-invalid')
      return {
        ...result,
        resolved: value.resolved,
        revealed: value.revealed,
        ...(value.match === undefined ? {} : { match: match(value.match) }),
        ...(value.boundary === undefined ? {} : { boundary: boundary(value.boundary) }),
      }
    }
  }
}

function state(value: EngineResult) {
  if (
    typeof value.stale !== 'boolean' ||
    value.stale ||
    typeof value.hasSelection !== 'boolean'
  )
    throw new Error('native-query-state-invalid')
  return {
    hasSelection: value.hasSelection,
    selectionSerial: counter(value.selectionSerial),
    screen: screen(value.screen),
    geometrySerial: counter(value.geometrySerial),
    requestedMutation: counter(value.requestedMutation),
  }
}
function match(input: unknown) {
  if (!input || typeof input !== 'object') throw new Error('native-query-match-invalid')
  const value = input as Record<string, unknown>
  if (!value || value.screen !== 0) throw new Error('native-query-match-invalid')
  const row = count(value.row),
    endRow = count(value.endRow)
  const column = count(value.column),
    endColumn = count(value.endColumn)
  if (endRow < row || (row === endRow && endColumn < column))
    throw new Error('native-query-range-invalid')
  return {
    occurrence: token(value.occurrence),
    index: count(value.index),
    screen: 0 as const,
    row,
    column,
    endRow,
    endColumn,
  }
}
function boundary(value: unknown) {
  if (!value || typeof value !== 'object')
    throw new Error('native-boundary-result-invalid')
  const point = value as Record<string, unknown>
  return {
    boundary: token(point.boundary),
    screen: screen(point.screen),
    row: count(point.row),
    column: count(point.column),
  }
}
