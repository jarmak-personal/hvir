import { validNativeTerminalUuid } from './native-terminal-identities'
/** Selection commands carry gesture intent, never clipboard or native authority. */
export type NativeTerminalSelectionAction =
  'state' | 'select-all' | 'selection-clear' | 'clear' | 'reset' | 'copy'

export interface NativeTerminalSelectionRequest {
  readonly viewId: string
  readonly action: NativeTerminalSelectionAction
  readonly requestId?: string
}

export interface NativeTerminalSelectionState {
  readonly hasSelection: boolean
  readonly selectionSerial: number
}

export interface NativeTerminalSelectionResponse extends NativeTerminalSelectionState {
  /** Exact command-time plain text; absent when there is no selection. */
  readonly text?: string
}

export interface NativeTerminalSelectionCancellation {
  readonly viewId: string
  readonly requestId: string
}

/** Continues only the cursor captured by this exact request and view. */
export type NativeTerminalSelectionReadRequest = NativeTerminalSelectionCancellation

/** Private main-to-worker geometry authority; absent disables local gestures. */
export interface NativeTerminalSelectionContext {
  readonly screen: 0 | 1
  readonly geometrySerial: number
}

export type NativeTerminalSelectionOperation =
  | {
      readonly kind: 'command'
      readonly action: Exclude<NativeTerminalSelectionAction, 'copy'>
      readonly context: NativeTerminalSelectionContext
    }
  | {
      readonly kind: 'begin'
      readonly selectionSerial: number
      readonly context: NativeTerminalSelectionContext
    }
  | { readonly kind: 'next' | 'finish' | 'close'; readonly cursor: string }
  | {
      readonly kind: 'link-row-begin'
      readonly query: NativeTerminalSelectionContext & {
        readonly x: number
        readonly y: number
      }
    }

export interface NativeTerminalSelectionNativeResult extends NativeTerminalSelectionState {
  readonly screen: 0 | 1
  readonly geometrySerial: number
  readonly requestedMutation: number
  readonly cursor?: string
  readonly column?: number
  readonly clickedByteOffset?: number
  readonly link?: Omit<
    import('./native-terminal-link').NativeTerminalLink,
    'workspaceRoot'
  >
}

export interface NativeTerminalSelectionChunk {
  readonly cursor: string
  readonly selectionSerial: number
  readonly data: Uint8Array
  readonly done: boolean
  readonly visited: number
  readonly work: number
  readonly clickedByteOffset?: number
}

export class NativeTerminalSelectionRefused extends Error {
  constructor(
    readonly code: 1 | 5 | 6 | 7,
    readonly stale: boolean,
  ) {
    super(stale ? 'native-selection-stale' : 'native-selection-unavailable')
  }
}

export function validNativeTerminalSelectionContext(
  value: unknown,
): value is NativeTerminalSelectionContext {
  if (!value || typeof value !== 'object') return false
  const context = value as NativeTerminalSelectionContext
  return (
    (context.screen === 0 || context.screen === 1) &&
    Number.isSafeInteger(context.geometrySerial) &&
    context.geometrySerial > 0 &&
    Object.keys(context).every((key) => ['screen', 'geometrySerial'].includes(key))
  )
}

export function validNativeTerminalSelectionCursor(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[1-9][0-9]{0,19}$/.test(value) &&
    BigInt(value) <= 0xffffffffffffffffn
  )
}

export function validNativeTerminalSelectionOperation(
  value: unknown,
): value is NativeTerminalSelectionOperation {
  if (!value || typeof value !== 'object') return false
  const operation = value as NativeTerminalSelectionOperation
  switch (operation.kind) {
    case 'command':
      return (
        commands.has(operation.action) &&
        validNativeTerminalSelectionContext(operation.context) &&
        Object.keys(operation).every((key) => ['kind', 'action', 'context'].includes(key))
      )
    case 'begin':
      return (
        Number.isSafeInteger(operation.selectionSerial) &&
        operation.selectionSerial >= 0 &&
        validNativeTerminalSelectionContext(operation.context) &&
        Object.keys(operation).every((key) =>
          ['kind', 'selectionSerial', 'context'].includes(key),
        )
      )
    case 'next':
    case 'finish':
    case 'close':
      return (
        validNativeTerminalSelectionCursor(operation.cursor) &&
        Object.keys(operation).every((key) => ['kind', 'cursor'].includes(key))
      )
    case 'link-row-begin': {
      const query = operation.query
      return (
        !!query &&
        validNativeTerminalSelectionContext({
          screen: query.screen,
          geometrySerial: query.geometrySerial,
        }) &&
        [query.x, query.y].every((n) => Number.isFinite(n) && Math.abs(n) <= 32768) &&
        Object.keys(query).every((key) =>
          ['x', 'y', 'screen', 'geometrySerial'].includes(key),
        ) &&
        Object.keys(operation).every((key) => ['kind', 'query'].includes(key))
      )
    }
    default:
      return false
  }
}

const actions = new Set<NativeTerminalSelectionAction>([
  'state',
  'select-all',
  'selection-clear',
  'clear',
  'reset',
  'copy',
])
const commands = new Set([...actions].filter((action) => action !== 'copy'))

export function validNativeTerminalSelectionRequest(
  value: unknown,
): value is NativeTerminalSelectionRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as NativeTerminalSelectionRequest
  return (
    validNativeTerminalUuid(request.viewId) &&
    Object.hasOwn(request, 'viewId') &&
    Object.hasOwn(request, 'action') &&
    actions.has(request.action) &&
    Object.keys(request).every((key) =>
      ['viewId', 'action', 'requestId'].includes(key),
    ) &&
    (request.requestId === undefined || validNativeTerminalUuid(request.requestId)) &&
    (request.action !== 'copy' || request.requestId !== undefined)
  )
}

export function validNativeTerminalSelectionCancellation(
  value: unknown,
): value is NativeTerminalSelectionCancellation {
  if (!value || typeof value !== 'object') return false
  const request = value as NativeTerminalSelectionCancellation
  return (
    Object.keys(request).every((key) => ['viewId', 'requestId'].includes(key)) &&
    Object.hasOwn(request, 'viewId') &&
    Object.hasOwn(request, 'requestId') &&
    validNativeTerminalUuid(request.viewId) &&
    validNativeTerminalUuid(request.requestId)
  )
}

export function validNativeTerminalSelectionState(
  value: unknown,
): value is NativeTerminalSelectionState {
  return (
    validSelectionStateValues(value) &&
    Object.keys(value).every((key) => ['hasSelection', 'selectionSerial'].includes(key))
  )
}

function validSelectionStateValues(
  value: unknown,
): value is NativeTerminalSelectionState {
  if (!value || typeof value !== 'object') return false
  const state = value as NativeTerminalSelectionState
  return (
    typeof state.hasSelection === 'boolean' &&
    Object.hasOwn(state, 'hasSelection') &&
    Object.hasOwn(state, 'selectionSerial') &&
    Number.isSafeInteger(state.selectionSerial) &&
    state.selectionSerial >= 0
  )
}

export function validNativeTerminalSelectionResponse(
  value: unknown,
): value is NativeTerminalSelectionResponse {
  if (!validSelectionStateValues(value)) return false
  const response = value as NativeTerminalSelectionResponse
  return (
    Object.keys(response).every((key) =>
      ['hasSelection', 'selectionSerial', 'text'].includes(key),
    ) &&
    (response.text === undefined || typeof response.text === 'string')
  )
}
