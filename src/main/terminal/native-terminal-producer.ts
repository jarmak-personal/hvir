import type {
  NativeTerminalCommand,
  NativeTerminalFrameInfo,
  NativeTerminalFrameResource,
} from '../../shared/native-terminal'
import {
  NativeTerminalCaretPending,
  validNativeTerminalInput,
  validNativeTerminalInputResult,
  type NativeTerminalInputOperation,
  type NativeTerminalKeyEncodingFallback,
} from '../../shared/native-terminal-input'
import type { NativeTerminalSelectionContext } from '../../shared/native-terminal-selection'
import type { NativeTerminalSelectionOperation } from '../../shared/native-terminal-selection'
import { NATIVE_TERMINAL_LIMITS as limits } from '../../shared/native-terminal'
import { validNativeTerminalEffectBatch } from '../../shared/native-terminal-effects'
import {
  validNativeTerminalLinkQuery,
  type NativeTerminalLinkQuery,
} from '../../shared/native-terminal-link'
interface ProducerBinding {
  readonly state: string
  readonly stream: number
  readonly abort: AbortController
}
interface ProducerPort {
  request(
    command: NativeTerminalCommand,
    signal?: AbortSignal,
    eligible?: (signal: AbortSignal) => Promise<void>,
    physicalInput?: true,
  ): Promise<unknown>
}
interface ProducerContext {
  readonly port: ProducerPort
  readonly binding: ProducerBinding
  readonly current: () => void
}
export async function selectionNativeTerminalProducer(
  { port, binding, current }: ProducerContext,
  operation: NativeTerminalSelectionOperation,
  signal?: AbortSignal,
  eligible?: (signal: AbortSignal) => Promise<void>,
) {
  const value = await port.request(
    { kind: 'selection', state: binding.state, operation },
    signal ? AbortSignal.any([binding.abort.signal, signal]) : binding.abort.signal,
    eligible,
  )
  current()
  return value
}
export async function queryNativeTerminalProducer(
  { port, binding, current }: ProducerContext,
  operation: import('../../shared/native-terminal-query-operations').NativeTerminalQueryOperation,
  signal?: AbortSignal,
  eligible?: (signal: AbortSignal) => Promise<void>,
) {
  const value = await port.request(
    { kind: 'query', state: binding.state, operation },
    signal ? AbortSignal.any([binding.abort.signal, signal]) : binding.abort.signal,
    eligible,
  )
  current()
  return value
}
/** Encoder results use ordinary input admission, never the privileged output role. */
export async function inputNativeTerminalProducer(
  { port, binding, current }: ProducerContext,
  input: NativeTerminalInputOperation,
  options: {
    eligible?: (signal: AbortSignal) => Promise<void>
    readOnly: boolean
    keyEncodingFallback?: NativeTerminalKeyEncodingFallback
    selectionContext?: NativeTerminalSelectionContext
  },
) {
  if (!validNativeTerminalInput(input)) throw new Error('native-input-invalid')
  const value = await port.request(
    {
      kind: 'input',
      state: binding.state,
      input,
      readOnly: options.readOnly,
      keyEncodingFallback: options.keyEncodingFallback,
      selectionContext: options.selectionContext,
    },
    binding.abort.signal,
    options.eligible,
    true,
  )
  current()
  if (
    input.kind === 'caret' &&
    value &&
    typeof value === 'object' &&
    'busy' in value &&
    value.busy === true
  )
    throw new NativeTerminalCaretPending()
  if (!validNativeTerminalInputResult(value)) throw new Error('native-input-invalid')
  return value
}
/** Copied producer results are checked after the exact immutable binding is revalidated. */
export async function readNativeTerminalProducer(
  { port, binding, current }: ProducerContext,
  kind: 'read' | 'drain',
): Promise<Uint8Array> {
  const value = await port.request({ kind, state: binding.state }, binding.abort.signal)
  current()
  if (!(value instanceof Uint8Array) || value.byteLength > limits.responseBytes)
    throw new Error(kind === 'read' ? 'native-read-bound' : 'native-reply-bound')
  return value
}
export async function drainNativeTerminalProducerEffects({
  port,
  binding,
  current,
}: ProducerContext) {
  const value = await port.request(
    { kind: 'effects', state: binding.state },
    binding.abort.signal,
  )
  current()
  if (!validNativeTerminalEffectBatch(value, binding.stream))
    throw new Error('native-effect-drain-invalid')
  return value
}
export async function readNativeTerminalProducerLink(
  { port, binding, current }: ProducerContext,
  query: NativeTerminalLinkQuery,
) {
  if (!validNativeTerminalLinkQuery(query)) throw new Error('native-link-query-invalid')
  const value = await port.request(
    { kind: 'link', state: binding.state, query },
    binding.abort.signal,
  )
  current()
  const result = value as
    | {
        unavailable?: number
        uri?: unknown
        screen?: unknown
        row?: unknown
        column?: unknown
        streamSequence?: unknown
        snapshotMutation?: unknown
        geometrySerial?: unknown
      }
    | undefined
  if (result?.unavailable === 6) return
  if (!result || (result.uri === undefined && Object.keys(result).length === 0)) return
  if (
    typeof result.uri !== 'string' ||
    result.uri.length > 65536 ||
    new TextEncoder().encode(result.uri).byteLength > 65536 ||
    !result.uri.length ||
    result.uri.includes('\0') ||
    result.screen !== query.screen ||
    result.row !== query.row ||
    result.column !== query.column ||
    result.streamSequence !== query.expectedSequence ||
    result.snapshotMutation !== query.expectedMutation ||
    result.geometrySerial !== query.expectedGeometrySerial
  )
    throw new Error('native-link-result-invalid')
  return {
    uri: result.uri,
    screen: query.screen,
    row: query.row,
    column: query.column,
    streamSequence: query.expectedSequence,
    snapshotMutation: query.expectedMutation,
    geometrySerial: query.expectedGeometrySerial,
  }
}

/** Only an exact held physical lease participates; attachment changes are unrelated.
 * Polling is fault-triggered and finite. Each RPC yields the designated worker. */
export async function retireNativeTerminalProducerFrame({
  port,
  state,
  lease,
  current,
}: {
  port: ProducerPort
  state: string
  lease: string
  current(this: void): void
}): Promise<'retired' | 'actor-ended'> {
  const deadline = Date.now() + limits.requestMs
  const signal = AbortSignal.timeout(limits.requestMs)
  current()
  const begun = await port.request({ kind: 'retire-frame-begin', state, lease }, signal)
  current()
  if (
    !begun ||
    typeof begun !== 'object' ||
    !('request' in begun) ||
    typeof begun.request !== 'string' ||
    !/^[1-9][0-9]{0,19}$/.test(begun.request) ||
    BigInt(begun.request) > 0xffffffffffffffffn
  )
    throw new Error('native-frame-retirement-request-invalid')
  const request = begun.request
  for (;;) {
    signal.throwIfAborted()
    current()
    const value = await port.request(
      { kind: 'retire-frame-status', state, lease, request },
      signal,
    )
    current()
    if (!value || typeof value !== 'object' || !('status' in value))
      throw new Error('native-frame-retirement-status-invalid')
    if (value.status === 2) return 'retired'
    if (value.status === 4) return 'actor-ended'
    if (value.status !== 1) throw new Error('native-frame-retirement-unconfirmed')
    if (Date.now() >= deadline) throw new Error('native-frame-retirement-timeout')
    await new Promise<void>((resolve) => setTimeout(resolve, 16))
  }
}

export function validNativeTerminalProducerFrame(
  value: NativeTerminalFrameInfo & { readonly lease: string },
): boolean {
  return (
    !!value &&
    /^[1-9][0-9]{0,19}$/.test(value.lease) &&
    [1, 2, 3].includes(value.kind) &&
    [0, 1].includes(value.screen) &&
    Number.isSafeInteger(value.geometrySerial) &&
    value.geometrySerial > 0 &&
    Number.isSafeInteger(value.streamSequence) &&
    value.streamSequence >= 0 &&
    Number.isSafeInteger(value.snapshotMutation) &&
    value.snapshotMutation >= 0 &&
    [1, 2].includes(value.colorSpace) &&
    [1, 2].includes(value.origin) &&
    typeof value.premultiplied === 'boolean' &&
    validFrameResource(value.resource, value.kind) &&
    Number.isInteger(value.width) &&
    value.width > 0 &&
    value.width <= 8192 &&
    Number.isInteger(value.height) &&
    value.height > 0 &&
    value.height <= 8192
  )
}

function validFrameResource(value: NativeTerminalFrameResource, kind: number): boolean {
  return (
    !!value &&
    Number.isInteger(value.fourcc) &&
    value.fourcc >= 0 &&
    value.fourcc <= 0xffffffff &&
    typeof value.modifier === 'string' &&
    /^(0|[1-9][0-9]{0,19})$/.test(value.modifier) &&
    BigInt(value.modifier) <= 0xffffffffffffffffn &&
    Array.isArray(value.planes) &&
    (kind === 2
      ? value.planes.length >= 1 && value.planes.length <= 4
      : value.planes.length === 0) &&
    value.planes.every(
      (plane: NativeTerminalFrameResource['planes'][number]) =>
        !!plane &&
        Number.isInteger(plane.stride) &&
        plane.stride > 0 &&
        plane.stride <= 0xffffffff &&
        Number.isInteger(plane.offset) &&
        plane.offset >= 0 &&
        plane.offset <= 0xffffffff &&
        Number.isSafeInteger(plane.size) &&
        plane.size > 0 &&
        plane.offset + plane.stride <= plane.size,
    )
  )
}

interface RawRendererInfo {
  available: boolean
  glVendor: string
  glRenderer: string
  glVersion: string
  eglVendor: string
  eglVersion: string
  renderNode: string
  pixelFrames: number
  dmaBufFrames: number
}
export function validNativeTerminalProducerRendererInfo(
  value: unknown,
): value is RawRendererInfo {
  if (!value || typeof value !== 'object') return false
  const info = value as RawRendererInfo
  return (
    typeof info.available === 'boolean' &&
    [
      info.glVendor,
      info.glRenderer,
      info.glVersion,
      info.eglVendor,
      info.eglVersion,
      info.renderNode,
    ].every(
      (text) =>
        typeof text === 'string' &&
        text.length <= 255 &&
        !Array.from(text).some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ),
    ) &&
    (info.renderNode === '' || /^\/dev\/dri\/renderD[0-9]+$/.test(info.renderNode)) &&
    [info.pixelFrames, info.dmaBufFrames].every(
      (count) => Number.isSafeInteger(count) && count >= 0,
    )
  )
}
