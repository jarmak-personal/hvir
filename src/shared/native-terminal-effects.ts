import { hostPath, type HostId, type HostPath } from './host-path'
/** Copied parser facts. Coordinates observe native state; they are not retained identities. */
export interface NativeTerminalEffectProvenance {
  readonly sequence: number
  readonly eventSerial: number
}
export type NativeTerminalEffect = NativeTerminalEffectProvenance &
  (
    | { readonly kind: 'title'; readonly title: string }
    | { readonly kind: 'cwd'; readonly uri: string }
    | { readonly kind: 'bell' }
    | {
        readonly kind: 'notification'
        readonly source: 'osc-9' | 'osc-777'
        readonly title: string
        readonly body: string
      }
    | {
        readonly kind: 'clipboard'
        readonly protocol: 'osc-52'
        readonly selection: string
        readonly data: string
      }
    | {
        readonly kind: 'semantic'
        readonly action: number
        readonly options: string
        readonly screen: 'normal' | 'alternate'
        readonly row: number
        readonly column: number
      }
    | {
        readonly kind: 'palette'
        readonly action: number
        readonly operation: number
        readonly targetClass: number
        readonly targetIndex: number
        readonly rgb?: readonly number[]
      }
    | { readonly kind: 'progress'; readonly action: number; readonly percentage?: number }
    | {
        readonly kind: 'screen'
        readonly action: 'screen-change' | 'reset'
        readonly screen: 'normal' | 'alternate'
      }
  )
export interface NativeTerminalEffectBatch {
  readonly effects: readonly NativeTerminalEffect[]
  readonly droppedEffects: number
  readonly semanticGeneration: number
}
export interface NativeTerminalProductEffect {
  readonly id: string
  readonly instanceId: string
  readonly eventSerial: number
  readonly effect:
    { readonly kind: 'title'; readonly title: string } | { readonly kind: 'bell' }
}
export interface NativeTerminalMetadata {
  readonly instanceId: string
  readonly title?: { readonly title: string; readonly eventSerial: number }
}
export const NATIVE_TERMINAL_EFFECT_LIMITS = {
  records: 131,
  payloadBytes: 1024 * 1024,
  pairBytes: 128 * 1024,
} as const
export function nativeTerminalEffectCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
export function validNativeTerminalEffectBatch(
  value: unknown,
  maximumSequence = Number.MAX_SAFE_INTEGER,
): value is NativeTerminalEffectBatch {
  if (!value || typeof value !== 'object') return false
  const batch = value as NativeTerminalEffectBatch
  if (
    !Array.isArray(batch.effects) ||
    batch.effects.length > NATIVE_TERMINAL_EFFECT_LIMITS.records ||
    !nativeTerminalEffectCounter(batch.droppedEffects) ||
    !nativeTerminalEffectCounter(batch.semanticGeneration)
  )
    return false
  let bytes = 0
  let previousSerial = 0
  const encoder = new TextEncoder()
  for (const candidate of batch.effects) {
    const effect = candidate as NativeTerminalEffect
    if (
      !effect ||
      !nativeTerminalEffectCounter(effect.sequence) ||
      effect.sequence > maximumSequence ||
      !nativeTerminalEffectCounter(effect.eventSerial) ||
      effect.eventSerial <= previousSerial
    )
      return false
    previousSerial = effect.eventSerial
    const fields: string[] = []
    switch (effect.kind) {
      case 'title':
        fields.push(effect.title)
        break
      case 'cwd':
        fields.push(effect.uri)
        break
      case 'bell':
        break
      case 'notification':
        if (effect.source !== 'osc-9' && effect.source !== 'osc-777') return false
        fields.push(effect.title, effect.body)
        break
      case 'clipboard':
        if (effect.protocol !== 'osc-52') return false
        fields.push(effect.selection, effect.data)
        break
      case 'semantic':
        if (
          !nativeTerminalEffectCounter(effect.action) ||
          effect.action > 7 ||
          !nativeTerminalEffectCounter(effect.row) ||
          !nativeTerminalEffectCounter(effect.column) ||
          (effect.screen !== 'normal' && effect.screen !== 'alternate')
        )
          return false
        fields.push(effect.options)
        break
      case 'palette':
        if (
          !nativeTerminalEffectCounter(effect.action) ||
          effect.action > 4 ||
          !nativeTerminalEffectCounter(effect.operation) ||
          !nativeTerminalEffectCounter(effect.targetClass) ||
          effect.targetClass > 2 ||
          !nativeTerminalEffectCounter(effect.targetIndex) ||
          (effect.action === 0 ? effect.rgb === undefined : effect.rgb !== undefined) ||
          (effect.rgb !== undefined &&
            (!Array.isArray(effect.rgb) ||
              effect.rgb.length !== 3 ||
              effect.rgb.some(
                (channel: unknown) =>
                  typeof channel !== 'number' ||
                  !Number.isInteger(channel) ||
                  channel < 0 ||
                  channel > 255,
              )))
        )
          return false
        break
      case 'progress':
        if (
          !nativeTerminalEffectCounter(effect.action) ||
          effect.action > 4 ||
          (effect.percentage !== undefined &&
            (!nativeTerminalEffectCounter(effect.percentage) || effect.percentage > 100))
        )
          return false
        break
      case 'screen':
        if (
          (effect.action !== 'screen-change' && effect.action !== 'reset') ||
          (effect.screen !== 'normal' && effect.screen !== 'alternate')
        )
          return false
        break
      default:
        return false
    }
    if (fields.some((field) => typeof field !== 'string')) return false
    const units = fields.reduce((sum, field) => sum + field.length, 0)
    if (
      units > NATIVE_TERMINAL_EFFECT_LIMITS.pairBytes ||
      bytes + units > NATIVE_TERMINAL_EFFECT_LIMITS.payloadBytes
    )
      return false
    const pair = fields.reduce((sum, field) => sum + encoder.encode(field).byteLength, 0)
    if (pair > NATIVE_TERMINAL_EFFECT_LIMITS.pairBytes) return false
    bytes += pair
  }
  return bytes <= NATIVE_TERMINAL_EFFECT_LIMITS.payloadBytes
}

/** OSC7 reports a path on the originating PTY host; its URI cannot select a host. */
export function nativeTerminalWorkingDirectory(
  hostId: HostId,
  rawUri: string,
): HostPath | undefined {
  try {
    const uri = new URL(rawUri)
    if (
      uri.protocol !== 'file:' ||
      uri.username ||
      uri.password ||
      uri.search ||
      uri.hash
    )
      return
    const path = decodeURIComponent(uri.pathname)
    if (!path.startsWith('/')) return
    for (const character of path) {
      const code = character.charCodeAt(0)
      if (code <= 31 || code === 127) return
    }
    return hostPath(hostId, path)
  } catch {
    return
  }
}
