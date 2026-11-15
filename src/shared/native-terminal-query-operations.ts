import type { NativeTerminalSelectionContext } from './native-terminal-selection'
import {
  validNativeTerminalSelectionContext,
  validNativeTerminalSelectionCursor as token,
} from './native-terminal-selection'
import { NATIVE_TERMINAL_QUERY_BYTES } from './native-terminal-query'

/** Private Main/worker protocol. Numeric tokens never identify another native Surface. */
export type NativeTerminalQueryOperation =
  | { readonly kind: 'query-context' }
  | {
      readonly kind: 'query-begin'
      readonly text: string
      readonly caseSensitive: boolean
    }
  | {
      readonly kind: 'query-step' | 'query-close' | 'query-clear-reveal'
      readonly query: string
    }
  | {
      readonly kind: 'query-page'
      readonly query: string
      readonly revision: string
      readonly offset: number
      readonly capacity: number
    }
  | {
      readonly kind: 'resolve-begin'
      readonly query: string
      readonly occurrence: string
      readonly reveal: boolean
      readonly context: NativeTerminalSelectionContext
    }
  | {
      readonly kind: 'range-begin'
      readonly source:
        | { readonly kind: 'match'; readonly query: string; readonly occurrence: string }
        | { readonly kind: 'semantic'; readonly start: string; readonly end?: string }
      readonly context: NativeTerminalSelectionContext
    }
  | {
      readonly kind: 'boundary-capture'
      readonly context: NativeTerminalSelectionContext
    }
  | {
      readonly kind: 'boundary-resolve-begin'
      readonly boundary: string
      readonly reveal: boolean
      readonly context: NativeTerminalSelectionContext
    }
  | { readonly kind: 'boundary-close'; readonly boundary: string }
  | { readonly kind: 'next' | 'finish' | 'close'; readonly cursor: string }

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const fields = (value: object, names: readonly string[]) =>
  Object.keys(value).every((name) => names.includes(name))
const counter = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export function validNativeTerminalQueryOperation(
  value: unknown,
): value is NativeTerminalQueryOperation {
  if (!record(value)) return false
  switch (value.kind) {
    case 'query-context':
      return fields(value, ['kind'])
    case 'query-begin':
      return (
        typeof value.text === 'string' &&
        value.text.length > 0 &&
        value.text.length <= NATIVE_TERMINAL_QUERY_BYTES &&
        new TextEncoder().encode(value.text).byteLength <= NATIVE_TERMINAL_QUERY_BYTES &&
        typeof value.caseSensitive === 'boolean' &&
        fields(value, ['kind', 'text', 'caseSensitive'])
      )
    case 'query-step':
    case 'query-close':
    case 'query-clear-reveal':
      return token(value.query) && fields(value, ['kind', 'query'])
    case 'query-page':
      return (
        token(value.query) &&
        token(value.revision) &&
        counter(value.offset) &&
        counter(value.capacity) &&
        value.capacity > 0 &&
        value.capacity <= 128 &&
        fields(value, ['kind', 'query', 'revision', 'offset', 'capacity'])
      )
    case 'resolve-begin':
      return (
        token(value.query) &&
        token(value.occurrence) &&
        typeof value.reveal === 'boolean' &&
        validNativeTerminalSelectionContext(value.context) &&
        fields(value, ['kind', 'query', 'occurrence', 'reveal', 'context'])
      )
    case 'range-begin': {
      const source = value.source
      if (
        !record(source) ||
        !validNativeTerminalSelectionContext(value.context) ||
        !fields(value, ['kind', 'source', 'context'])
      )
        return false
      return source.kind === 'match'
        ? token(source.query) &&
            token(source.occurrence) &&
            fields(source, ['kind', 'query', 'occurrence'])
        : source.kind === 'semantic' &&
            token(source.start) &&
            (source.end === undefined || token(source.end)) &&
            fields(source, ['kind', 'start', 'end'])
    }
    case 'boundary-capture':
      return (
        validNativeTerminalSelectionContext(value.context) &&
        fields(value, ['kind', 'context'])
      )
    case 'boundary-resolve-begin':
      return (
        token(value.boundary) &&
        typeof value.reveal === 'boolean' &&
        validNativeTerminalSelectionContext(value.context) &&
        fields(value, ['kind', 'boundary', 'reveal', 'context'])
      )
    case 'boundary-close':
      return token(value.boundary) && fields(value, ['kind', 'boundary'])
    case 'next':
    case 'finish':
    case 'close':
      return token(value.cursor) && fields(value, ['kind', 'cursor'])
    default:
      return false
  }
}

/** These physical acquisitions need targeted cleanup even after logical cancellation. */
export function nativeTerminalQueryAcquiresCursor(
  operation: NativeTerminalQueryOperation,
): boolean {
  return (
    operation.kind === 'resolve-begin' ||
    operation.kind === 'range-begin' ||
    operation.kind === 'boundary-resolve-begin'
  )
}

/** Native BUSY certifies an unsent acquisition or cleanup only at its owning seam. */
export function nativeQueryUnsentBusy(code: unknown, stale: unknown): boolean {
  return code === 6 && stale === false
}
