import type { WebFrameMain } from 'electron'
import type { RendererOwner } from '../renderer-resource-scopes'
import type { NativeTerminalSession } from '../../shared/native-terminal'
import {
  NATIVE_TERMINAL_EFFECT_LIMITS,
  nativeTerminalSemanticPayloadBytes,
  type NativeTerminalProductEffect,
  type NativeTerminalProductEvent,
  type NativeTerminalSemanticEffect,
} from '../../shared/native-terminal-effects'

interface ProductEffectView {
  readonly sessionId: string
  readonly instanceId: string
  readonly owner: RendererOwner
  readonly detaching?: Promise<void>
  readonly frame: Pick<WebFrameMain, 'isDestroyed' | 'send'>
}
interface ProductEffectSession {
  readonly session: NativeTerminalSession
  readonly retiring: boolean
  readonly readonly: boolean
  readonly inputClosed: boolean
  readonly unavailable: boolean
  readonly inputUnavailable: boolean
}
export type NativeTerminalProductPublication =
  NativeTerminalProductEffect | readonly NativeTerminalSemanticEffect[]

function semanticList(
  value: NativeTerminalProductPublication,
): value is readonly NativeTerminalSemanticEffect[] {
  return Array.isArray(value)
}

function semanticChunks(
  session: NativeTerminalSession,
  effects: readonly NativeTerminalSemanticEffect[],
): NativeTerminalProductEvent[] {
  const messages: NativeTerminalProductEvent[] = []
  let chunk: NativeTerminalSemanticEffect[] = []
  let bytes = 0
  for (const effect of effects) {
    if (effect.id !== session.sessionId || effect.instanceId !== session.instanceId)
      throw new Error('native-product-semantic-instance-mismatch')
    const size = nativeTerminalSemanticPayloadBytes(
      effect,
      NATIVE_TERMINAL_EFFECT_LIMITS.payloadBytes,
    )
    if (size === undefined) throw new Error('native-product-semantic-payload-invalid')
    if (
      chunk.length === NATIVE_TERMINAL_EFFECT_LIMITS.records ||
      bytes + size > NATIVE_TERMINAL_EFFECT_LIMITS.payloadBytes
    ) {
      messages.push({ effects: chunk })
      chunk = []
      bytes = 0
    }
    chunk.push(effect)
    bytes += size
  }
  if (chunk.length) messages.push({ effects: chunk })
  return messages
}

/** Ordered bounded transport, with current view/actor authority checked at each send. */
export function publishNativeTerminalEffects(
  session: NativeTerminalSession,
  publication: NativeTerminalProductPublication,
  views: Iterable<ProductEffectView>,
  currentSession: () => ProductEffectSession | undefined,
  isCurrent: (owner: RendererOwner) => boolean,
): void {
  const messages = semanticList(publication)
    ? semanticChunks(session, publication)
    : [publication]
  for (const view of views) {
    for (const message of messages) {
      if (
        view.sessionId !== session.sessionId ||
        view.detaching ||
        view.instanceId !== session.instanceId ||
        view.owner.id !== session.ownerId ||
        view.owner.generation !== session.ownerGeneration ||
        !isCurrent(view.owner) ||
        view.frame.isDestroyed()
      )
        continue
      const current = currentSession()
      if (
        !current ||
        current.retiring ||
        current.session.instanceId !== session.instanceId ||
        current.session.ownerId !== session.ownerId ||
        current.session.ownerGeneration !== session.ownerGeneration ||
        (!('effects' in message) &&
          !['title', 'semantic', 'semantic-gap'].includes(message.effect.kind) &&
          (current.readonly ||
            current.inputClosed ||
            current.unavailable ||
            current.inputUnavailable))
      )
        continue
      try {
        view.frame.send('native-terminal:effect', message)
      } catch {
        // Renderer delivery cannot invalidate already retained parser facts.
      }
    }
  }
}
