import {
  NATIVE_TERMINAL_EFFECT_LIMITS as limits,
  type NativeTerminalEffect,
  type NativeTerminalEffectBatch,
} from '../shared/native-terminal-effects'
interface NativeEventResult {
  result: number
  droppedEffects: bigint
  semanticGeneration: bigint
  event?: {
    kind: number
    action: number
    screen: number
    row: number
    column: number
    sequence: bigint
    eventSerial: bigint
    data: Uint8Array
    extra: Uint8Array
    truncated: boolean
  }
}
function counter(value: bigint): number {
  if (typeof value !== 'bigint' || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('native-effect-counter-invalid')
  return Number(value)
}
/** The designated native caller copies each borrowed result once, with no product authority. */
export function drainNativeTerminalEffects(
  next: () => NativeEventResult,
): NativeTerminalEffectBatch & { result: number } {
  const effects: NativeTerminalEffect[] = []
  let bytes = 0
  for (let index = 0; index <= limits.records; index++) {
    const value = next()
    const droppedEffects = counter(value.droppedEffects)
    const semanticGeneration = counter(value.semanticGeneration)
    if (value.result === 6)
      return { result: 0, effects, droppedEffects, semanticGeneration }
    if (value.result !== 0)
      return { result: value.result, effects, droppedEffects, semanticGeneration }
    if (index === limits.records || !value.event)
      throw new Error('native-effect-drain-bound')
    const event = value.event
    if (
      !(event.data instanceof Uint8Array) ||
      !(event.extra instanceof Uint8Array) ||
      event.truncated
    )
      throw new Error('native-effect-payload-invalid')
    const pair = event.data.byteLength + event.extra.byteLength
    bytes += pair
    if (pair > limits.pairBytes || bytes > limits.payloadBytes)
      throw new Error('native-effect-payload-bound')
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    const data = event.kind === 7 ? '' : decoder.decode(event.data)
    const extra = event.kind === 7 ? '' : decoder.decode(event.extra)
    const provenance = {
      sequence: counter(event.sequence),
      eventSerial: counter(event.eventSerial),
    }
    if (provenance.eventSerial <= (effects.at(-1)?.eventSerial ?? 0))
      throw new Error('native-effect-serial-invalid')
    const screen =
      event.screen === 0 ? 'normal' : event.screen === 1 ? 'alternate' : undefined
    let effect: NativeTerminalEffect
    switch (event.kind) {
      case 1:
        effect = { ...provenance, kind: 'title', title: data }
        break
      case 2:
        effect = { ...provenance, kind: 'cwd', uri: data }
        break
      case 3:
        effect = { ...provenance, kind: 'bell' }
        break
      case 4:
        if (event.action !== 0 && event.action !== 1)
          throw new Error('native-notification-source-invalid')
        effect = {
          ...provenance,
          kind: 'notification',
          source: event.action === 0 ? 'osc-9' : 'osc-777',
          title: data,
          body: extra,
        }
        break
      case 5:
        if (event.action !== 1) throw new Error('native-clipboard-operation-invalid')
        effect = {
          ...provenance,
          kind: 'clipboard',
          protocol: 'osc-52',
          selection: extra,
          data,
        }
        break
      case 6:
        if (
          !screen ||
          !Number.isSafeInteger(event.action) ||
          event.action < 0 ||
          event.action > 7 ||
          !Number.isSafeInteger(event.row) ||
          event.row < 0 ||
          !Number.isSafeInteger(event.column) ||
          event.column < 0
        )
          throw new Error('native-semantic-invalid')
        effect = {
          ...provenance,
          kind: 'semantic',
          action: event.action,
          options: data,
          screen,
          row: event.row,
          column: event.column,
        }
        break
      case 7:
        if (
          !Number.isInteger(event.action) ||
          event.action < 0 ||
          event.action > 4 ||
          !Number.isInteger(event.screen) ||
          event.screen < 0 ||
          !Number.isInteger(event.row) ||
          event.row < 0 ||
          event.row > 2 ||
          !Number.isInteger(event.column) ||
          event.column < 0 ||
          event.extra.byteLength ||
          (event.action === 0 ? event.data.byteLength !== 3 : event.data.byteLength !== 0)
        )
          throw new Error('native-palette-invalid')
        effect = {
          ...provenance,
          kind: 'palette',
          action: event.action,
          operation: event.screen,
          targetClass: event.row,
          targetIndex: event.column,
          ...(event.action === 0 ? { rgb: Array.from(event.data) } : {}),
        }
        break
      case 10:
        if (
          !Number.isInteger(event.action) ||
          event.action < 0 ||
          event.action > 4 ||
          (event.row !== 0xffffffff &&
            (!Number.isInteger(event.row) || event.row < 0 || event.row > 100)) ||
          pair
        )
          throw new Error('native-progress-invalid')
        effect = {
          ...provenance,
          kind: 'progress',
          action: event.action,
          ...(event.row === 0xffffffff ? {} : { percentage: event.row }),
        }
        break
      case 8:
        if (!screen || (event.action !== 0 && event.action !== 1))
          throw new Error('native-screen-effect-invalid')
        effect = {
          ...provenance,
          kind: 'screen',
          action: event.action === 0 ? 'screen-change' : 'reset',
          screen,
        }
        break
      default:
        throw new Error('native-effect-kind-invalid')
    }
    effects.push(effect)
  }
  throw new Error('native-effect-drain-bound')
}
