import type { TerminalInputSource } from './terminal-input'
export type NativeTerminalKeyEncodingFallback = 'csi-u' | 'modify-other-keys'

/** DOM values describe one gesture, never its provider policy or PTY authority. */
export type NativeTerminalInputOperation =
  | {
      kind: 'key'
      key: number
      modifiers: number
      consumedModifiers: number
      action: 0 | 1 | 2
      text: string
      unshiftedCodepoint: number
      composing: boolean
      optionAsAlt: boolean | 'left' | 'right'
    }
  | { kind: 'paste'; text: string }
  | { kind: 'preedit'; text: string | null }
  | { kind: 'focus'; focused: boolean }
  | {
      kind: 'pointer'
      x: number
      y: number
      modifiers: number
      button?: number
      action?: 0 | 1
    }
  | {
      kind: 'wheel'
      x: number
      y: number
      deltaX: number
      deltaY: number
      precision: boolean
      modifiers: number
    }
  | { kind: 'caret' }

export interface NativeTerminalCaret {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly geometrySerial: number
}
export interface NativeTerminalInputCompletion {
  /** Enqueued native mutation; this alone is not an applied or presented frame. */
  readonly requestedMutation: number
  readonly caret?: NativeTerminalCaret
  readonly captured?: boolean
  /** Proven-unsent transient admission; accepted input is never replayed. */
  readonly refused?: 'capacity'
}
/** Private utility/main result. Renderer completion never includes PTY bytes. */
export interface NativeTerminalInputResult extends NativeTerminalInputCompletion {
  readonly bytes: Uint8Array
  readonly capacity: number
  readonly source: TerminalInputSource
}
/** Read-only caret query has not reached its preceding native mutation fence. */
export class NativeTerminalCaretPending extends Error {
  constructor() {
    super('native-caret-pending')
    this.name = 'NativeTerminalCaretPending'
  }
}
/** Allocation/capacity refusal proved to precede native mutation and byte emission. */
export class NativeTerminalInputResourceRefused extends Error {
  constructor(message = 'native-input-resource-unavailable') {
    super(message)
    this.name = 'NativeTerminalInputResourceRefused'
  }
}
/** The owned native input did not produce an observable physical completion. */
export class NativeTerminalInputPhysicalFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NativeTerminalInputPhysicalFailure'
  }
}
/** Ordinary concurrent result capacity; oversized paste is separately owned.
 * Neither this budget nor admission accounting bounds physical process memory. */
export const NATIVE_INPUT_RESULTS = {
  aggregateBytes: 64 * 1024 * 1024,
  cleanupBytes: 32 * 64 * 1024,
  ordinaryBytes: 64 * 1024,
  // Default precision1/discrete3, |CSS delta|<=32768, scale<=4, native cell>=1,
  // <=262144 reports*38 bytes plus motion and worst CR->CRLF expansion.
  wheelBytes: 20 * 1024 * 1024,
} as const
export function nativeTerminalInputResultCapacity(
  input: NativeTerminalInputOperation,
  readOnly: boolean,
  utf8ByteLength: (text: string) => number,
): number {
  if (input.kind === 'paste') {
    const bytes = utf8ByteLength(input.text)
    const capacity = 2 * bytes + 12
    if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(capacity))
      throw new NativeTerminalInputResourceRefused('native-input-capacity-overflow')
    return capacity
  }
  if (input.kind === 'caret' || input.kind === 'preedit') return 0
  if (readOnly && (input.kind === 'wheel' || input.kind === 'pointer')) return 0
  return input.kind === 'wheel'
    ? NATIVE_INPUT_RESULTS.wheelBytes
    : NATIVE_INPUT_RESULTS.ordinaryBytes
}
export function nativeTerminalInputCleanup(input: NativeTerminalInputOperation): boolean {
  return (
    (input.kind === 'focus' && !input.focused) ||
    (input.kind === 'preedit' && input.text === null)
  )
}
/** Compatibility entry for the original preview key port; richer callers send all fields. */
export function nativeTerminalKeyOperation(input: {
  key: number
  modifiers: number
  action: number
  text: string
}): Extract<NativeTerminalInputOperation, { kind: 'key' }> {
  const operation = {
    kind: 'key' as const,
    key: input.key,
    modifiers: input.modifiers,
    text: input.text,
    action: input.action as 0 | 1 | 2,
    consumedModifiers: 0,
    unshiftedCodepoint: 0,
    composing: false,
    optionAsAlt: false,
  }
  if (!validNativeTerminalInput(operation)) throw new Error('native-key-invalid')
  return operation
}

const modifiers = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 1023
const text = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 4096 &&
  !value.includes('\0') &&
  new TextEncoder().encode(value).byteLength <= 4096
const coordinate = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 32768

export function validNativeTerminalInput(
  input: unknown,
): input is NativeTerminalInputOperation {
  if (!input || typeof input !== 'object') return false
  const value = input as Record<string, unknown>
  const fields: Record<string, readonly string[]> = {
    key: [
      'kind',
      'key',
      'modifiers',
      'consumedModifiers',
      'action',
      'text',
      'unshiftedCodepoint',
      'composing',
      'optionAsAlt',
    ],
    paste: ['kind', 'text'],
    preedit: ['kind', 'text'],
    focus: ['kind', 'focused'],
    pointer: ['kind', 'x', 'y', 'modifiers', 'button', 'action'],
    wheel: ['kind', 'x', 'y', 'deltaX', 'deltaY', 'precision', 'modifiers'],
    caret: ['kind'],
  }
  if (
    typeof value.kind !== 'string' ||
    !Object.hasOwn(fields, value.kind) ||
    Object.keys(value).some((field) => !fields[value.kind as string]!.includes(field))
  )
    return false
  switch (value.kind) {
    case 'key':
      return (
        Number.isInteger(value.key) &&
        Number(value.key) >= 0 &&
        Number(value.key) <= 175 &&
        modifiers(value.modifiers) &&
        modifiers(value.consumedModifiers) &&
        [0, 1, 2].includes(Number(value.action)) &&
        typeof value.action === 'number' &&
        text(value.text) &&
        Number.isInteger(value.unshiftedCodepoint) &&
        Number(value.unshiftedCodepoint) >= 0 &&
        Number(value.unshiftedCodepoint) <= 0x10ffff &&
        !(
          Number(value.unshiftedCodepoint) >= 0xd800 &&
          Number(value.unshiftedCodepoint) <= 0xdfff
        ) &&
        typeof value.composing === 'boolean' &&
        (typeof value.optionAsAlt === 'boolean' ||
          value.optionAsAlt === 'left' ||
          value.optionAsAlt === 'right')
      )
    case 'paste':
      // Paste has independent dynamic sizing; key/reply limits do not govern it.
      return typeof value.text === 'string'
    case 'preedit':
      return value.text === null || text(value.text)
    case 'focus':
      return typeof value.focused === 'boolean'
    case 'pointer':
      return (
        coordinate(value.x) &&
        coordinate(value.y) &&
        modifiers(value.modifiers) &&
        ((value.button === undefined && value.action === undefined) ||
          (Number.isInteger(value.button) &&
            Number(value.button) >= 1 &&
            Number(value.button) <= 11 &&
            [0, 1].includes(Number(value.action)) &&
            typeof value.action === 'number'))
      )
    case 'wheel':
      return (
        coordinate(value.x) &&
        coordinate(value.y) &&
        coordinate(value.deltaX) &&
        coordinate(value.deltaY) &&
        modifiers(value.modifiers) &&
        typeof value.precision === 'boolean'
      )
    case 'caret':
      return true
    default:
      return false
  }
}

export function nativeTerminalInputBytes(input: NativeTerminalInputOperation): number {
  // Paste has separate dynamic admission: never allocate a full preflight copy here.
  return input.kind !== 'paste' && 'text' in input && typeof input.text === 'string'
    ? new TextEncoder().encode(input.text).byteLength
    : 0
}

export function validNativeTerminalInputResult(
  value: unknown,
): value is NativeTerminalInputResult {
  if (!value || typeof value !== 'object') return false
  const result = value as NativeTerminalInputResult
  return (
    result.bytes instanceof Uint8Array &&
    Number.isSafeInteger(result.capacity) &&
    result.capacity >= result.bytes.byteLength &&
    (result.source === 'user' || result.source === 'terminal-response') &&
    Number.isSafeInteger(result.requestedMutation) &&
    result.requestedMutation >= 0 &&
    (result.captured === undefined || typeof result.captured === 'boolean') &&
    (result.caret === undefined ||
      (result.caret !== null &&
        typeof result.caret === 'object' &&
        Object.values(result.caret).length === 5 &&
        Number.isSafeInteger(result.caret.geometrySerial) &&
        result.caret.geometrySerial >= 1 &&
        [result.caret.x, result.caret.y, result.caret.width, result.caret.height].every(
          (item) => typeof item === 'number' && Number.isFinite(item),
        )))
  )
}
