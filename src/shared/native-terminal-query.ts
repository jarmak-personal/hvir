import { validNativeTerminalUuid } from './native-terminal-identities'
import { validNativeTerminalSelectionCursor } from './native-terminal-selection'

/** Query admission is independent of retained text, match count and read length. */
export const NATIVE_TERMINAL_QUERY_BYTES = 65536

export interface NativeTerminalQuerySnapshot {
  readonly revision: number
  readonly matchCount: number
  readonly pending: boolean
  readonly invalidated: boolean
  /** Terminal failure of this query; distinct from a restartable identity invalidation. */
  readonly unavailable?: true
}

interface RequestOwner {
  readonly viewId: string
  readonly requestId: string
}
interface QueryOwner extends RequestOwner {
  /** Main-owned query lifetime, distinct from the native numeric token. */
  readonly queryId: string
}

/** Intent only. Main resolves instance, native state and current presentation authority. */
export type NativeTerminalQueryRequest =
  | (RequestOwner & {
      readonly kind: 'begin'
      readonly text: string
      readonly caseSensitive: boolean
    })
  | (QueryOwner & { readonly kind: 'at'; readonly index: number })
  | (QueryOwner & {
      readonly kind: 'resolve' | 'reveal' | 'read'
      readonly occurrenceId: string
    })
  | (QueryOwner & { readonly kind: 'clear-reveal' })
  | (QueryOwner & { readonly kind: 'close' })
  | (RequestOwner & { readonly kind: 'active-screen' })
  | (RequestOwner & { readonly kind: 'capture-end' })
  | (RequestOwner & {
      readonly kind: 'boundary-resolve' | 'boundary-reveal' | 'boundary-close'
      readonly boundaryId: string
    })
  | (RequestOwner & {
      readonly kind: 'range-read'
      readonly startId: string
      /** An absent end is captured once, at this command's native begin. */
      readonly endId?: string
    })

export type NativeTerminalQueryCancellation = RequestOwner

export interface NativeTerminalQueryLocation {
  readonly screen: 'normal' | 'alternate'
  readonly row: number
  readonly column: number
}

export type NativeTerminalQueryResponse =
  | {
      readonly kind: 'query'
      readonly queryId: string
      readonly snapshot: NativeTerminalQuerySnapshot
    }
  | { readonly kind: 'occurrence'; readonly occurrenceId?: string }
  | { readonly kind: 'resolved'; readonly index?: number }
  | { readonly kind: 'revealed'; readonly revealed: boolean }
  | { readonly kind: 'text'; readonly text?: string }
  | { readonly kind: 'done' }
  | { readonly kind: 'screen'; readonly screen: 'normal' | 'alternate' }
  | { readonly kind: 'boundary'; readonly location?: NativeTerminalQueryLocation }
  | {
      readonly kind: 'boundary-captured'
      readonly boundaryId?: string
      readonly location?: NativeTerminalQueryLocation
    }

/** Owner-qualified hint; receipt does not authenticate a match or a displayed frame. */
export interface NativeTerminalQueryUpdate {
  readonly viewId: string
  readonly queryId: string
  readonly snapshot: NativeTerminalQuerySnapshot
}

const counter = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const fields = (value: object, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key))

export function validNativeTerminalQuerySnapshot(
  value: unknown,
): value is NativeTerminalQuerySnapshot {
  return (
    record(value) &&
    counter(value.revision) &&
    counter(value.matchCount) &&
    typeof value.pending === 'boolean' &&
    typeof value.invalidated === 'boolean' &&
    (value.unavailable === undefined || value.unavailable === true) &&
    fields(value, ['revision', 'matchCount', 'pending', 'invalidated', 'unavailable'])
  )
}

export function validNativeTerminalQueryCancellation(
  value: unknown,
): value is NativeTerminalQueryCancellation {
  return (
    record(value) &&
    validNativeTerminalUuid(value.viewId) &&
    validNativeTerminalUuid(value.requestId) &&
    fields(value, ['viewId', 'requestId'])
  )
}

export function validNativeTerminalQueryRequest(
  value: unknown,
): value is NativeTerminalQueryRequest {
  if (
    !record(value) ||
    !validNativeTerminalUuid(value.viewId) ||
    !validNativeTerminalUuid(value.requestId)
  )
    return false
  const owner = ['kind', 'viewId', 'requestId']
  const query = [...owner, 'queryId']
  switch (value.kind) {
    case 'begin':
      return (
        typeof value.text === 'string' &&
        value.text.length > 0 &&
        value.text.length <= NATIVE_TERMINAL_QUERY_BYTES &&
        new TextEncoder().encode(value.text).byteLength <= NATIVE_TERMINAL_QUERY_BYTES &&
        typeof value.caseSensitive === 'boolean' &&
        fields(value, [...owner, 'text', 'caseSensitive'])
      )
    case 'at':
      return (
        validNativeTerminalUuid(value.queryId) &&
        counter(value.index) &&
        fields(value, [...query, 'index'])
      )
    case 'resolve':
    case 'reveal':
    case 'read':
      return (
        validNativeTerminalUuid(value.queryId) &&
        validNativeTerminalSelectionCursor(value.occurrenceId) &&
        fields(value, [...query, 'occurrenceId'])
      )
    case 'clear-reveal':
    case 'close':
      return validNativeTerminalUuid(value.queryId) && fields(value, query)
    case 'active-screen':
    case 'capture-end':
      return fields(value, owner)
    case 'boundary-resolve':
    case 'boundary-reveal':
    case 'boundary-close':
      return (
        validNativeTerminalUuid(value.boundaryId) &&
        fields(value, [...owner, 'boundaryId'])
      )
    case 'range-read':
      return (
        validNativeTerminalUuid(value.startId) &&
        (value.endId === undefined || validNativeTerminalUuid(value.endId)) &&
        fields(value, [...owner, 'startId', 'endId'])
      )
    default:
      return false
  }
}

export function validNativeTerminalQueryUpdate(
  value: unknown,
): value is NativeTerminalQueryUpdate {
  return (
    record(value) &&
    validNativeTerminalUuid(value.viewId) &&
    validNativeTerminalUuid(value.queryId) &&
    validNativeTerminalQuerySnapshot(value.snapshot) &&
    fields(value, ['viewId', 'queryId', 'snapshot'])
  )
}

export function validNativeTerminalQueryResponse(
  value: unknown,
): value is NativeTerminalQueryResponse {
  if (!record(value)) return false
  switch (value.kind) {
    case 'query':
      return (
        validNativeTerminalUuid(value.queryId) &&
        validNativeTerminalQuerySnapshot(value.snapshot) &&
        fields(value, ['kind', 'queryId', 'snapshot'])
      )
    case 'occurrence':
      return (
        (value.occurrenceId === undefined ||
          validNativeTerminalSelectionCursor(value.occurrenceId)) &&
        fields(value, ['kind', 'occurrenceId'])
      )
    case 'resolved':
      return (
        (value.index === undefined || counter(value.index)) &&
        fields(value, ['kind', 'index'])
      )
    case 'revealed':
      return typeof value.revealed === 'boolean' && fields(value, ['kind', 'revealed'])
    case 'text':
      return (
        (value.text === undefined || typeof value.text === 'string') &&
        fields(value, ['kind', 'text'])
      )
    case 'done':
      return fields(value, ['kind'])
    case 'screen':
      return screen(value.screen) && fields(value, ['kind', 'screen'])
    case 'boundary':
      return (
        (value.location === undefined || location(value.location)) &&
        fields(value, ['kind', 'location'])
      )
    case 'boundary-captured':
      return (
        ((value.boundaryId === undefined && value.location === undefined) ||
          (validNativeTerminalUuid(value.boundaryId) && location(value.location))) &&
        fields(value, ['kind', 'boundaryId', 'location'])
      )
    default:
      return false
  }
}

function screen(value: unknown): value is 'normal' | 'alternate' {
  return value === 'normal' || value === 'alternate'
}
function location(value: unknown): value is NativeTerminalQueryLocation {
  return (
    record(value) &&
    screen(value.screen) &&
    counter(value.row) &&
    counter(value.column) &&
    fields(value, ['screen', 'row', 'column'])
  )
}
