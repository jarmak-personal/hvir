import type { NativeTerminalCommand } from '../../shared/native-terminal'
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
  request(command: NativeTerminalCommand, signal?: AbortSignal): Promise<unknown>
}
/** Copied producer results are checked after the exact immutable binding is revalidated. */
export async function readNativeTerminalProducer(
  port: ProducerPort,
  binding: ProducerBinding,
  current: () => void,
  kind: 'read' | 'drain',
): Promise<Uint8Array> {
  const value = await port.request({ kind, state: binding.state }, binding.abort.signal)
  current()
  if (!(value instanceof Uint8Array) || value.byteLength > limits.responseBytes)
    throw new Error(kind === 'read' ? 'native-read-bound' : 'native-reply-bound')
  return value
}
export async function drainNativeTerminalProducerEffects(
  port: ProducerPort,
  binding: ProducerBinding,
  current: () => void,
) {
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
  port: ProducerPort,
  binding: ProducerBinding,
  current: () => void,
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
