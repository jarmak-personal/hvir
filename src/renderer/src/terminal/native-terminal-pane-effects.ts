import {
  NATIVE_TERMINAL_EFFECT_LIMITS,
  nativeTerminalSemanticPayloadBytes,
  type NativeTerminalSemanticEffects,
  type NativeTerminalProductEffect,
  type NativeTerminalSemanticSnapshot,
} from '../../../shared/native-terminal-effects'
import type { TerminalEvent, TerminalSemanticAction } from './terminal-pane'
/** One pane receives only its current immutable binding's product effects. */
export class NativeTerminalPaneEffects {
  private bootstrap?: {
    sessionId: string
    events: NativeTerminalProductEffect[]
    bytes: number
    overflowSerial: number
  }
  private readonly serial = { title: 0, bell: 0, semantic: 0 }
  private controlCutoff = 0
  private readonly listeners = new Set<(event: TerminalEvent) => void>()
  constructor(
    private readonly current: () => {
      sessionId?: string
      instanceId?: string
      disposed: boolean
    },
  ) {}
  beginBootstrap(sessionId: string): void {
    this.bootstrap = { sessionId, events: [], bytes: 0, overflowSerial: 0 }
  }
  restoreSemantics(snapshot?: NativeTerminalSemanticSnapshot): void {
    const bootstrap = this.bootstrap
    this.bootstrap = undefined
    const through = snapshot?.throughSerial ?? 0
    if (bootstrap && snapshot)
      bootstrap.events = bootstrap.events.filter(
        (value) =>
          value.eventSerial > through ||
          (value.effect.kind === 'semantic-gap' &&
            value.effect.controlCutoff !== undefined) ||
          (value.effect.kind === 'semantic-gap' && value.eventSerial === through),
      )
    let bytes = 0
    let complete = (snapshot?.effects.length ?? 0) <= 512
    if (complete) {
      for (const value of snapshot?.effects ?? []) {
        const size = nativeTerminalSemanticPayloadBytes(
          value,
          NATIVE_TERMINAL_EFFECT_LIMITS.payloadBytes - bytes,
        )
        if (size === undefined) {
          complete = false
          break
        }
        bytes += size
        this.accept(value)
      }
    }
    this.serial.semantic = Math.max(this.serial.semantic, through)
    for (const value of bootstrap?.events.sort((a, b) => a.eventSerial - b.eventSerial) ??
      []) {
      if (
        !snapshot ||
        value.eventSerial > through ||
        (value.effect.kind === 'semantic-gap' &&
          value.effect.controlCutoff !== undefined) ||
        (value.effect.kind === 'semantic-gap' && value.eventSerial === through)
      )
        this.accept(value)
    }
    if (!complete || (bootstrap && bootstrap.overflowSerial > through))
      this.emitSemanticGap()
  }
  acceptBatch(envelope: NativeTerminalSemanticEffects): void {
    if (
      !envelope ||
      !Array.isArray(envelope.effects) ||
      envelope.effects.length > NATIVE_TERMINAL_EFFECT_LIMITS.records
    )
      return
    const effects: NativeTerminalSemanticEffects['effects'] = envelope.effects
    const current = this.current(),
      bootstrap = this.bootstrap
    if (
      current.disposed ||
      !effects.some(
        (value) =>
          value &&
          (bootstrap
            ? value.id === bootstrap.sessionId
            : value.id === current.sessionId &&
              !!current.instanceId &&
              value.instanceId === current.instanceId),
      )
    )
      return
    let bytes = 0
    try {
      for (const value of effects) {
        const size = nativeTerminalSemanticPayloadBytes(
          value,
          NATIVE_TERMINAL_EFFECT_LIMITS.payloadBytes - bytes,
        )
        if (size === undefined) return
        bytes += size
      }
    } catch {
      return // Malformed envelopes have no semantic authority.
    }
    let failed = false,
      firstError: unknown
    for (const value of effects) {
      try {
        this.accept(value)
      } catch (error) {
        if (!failed) {
          failed = true
          firstError = error
        }
      }
    }
    if (failed) throw firstError
  }
  accept(value: NativeTerminalProductEffect): void {
    const current = this.current()
    if (
      !current.disposed &&
      this.bootstrap &&
      value.id === this.bootstrap.sessionId &&
      (value.effect.kind === 'semantic' || value.effect.kind === 'semantic-gap') &&
      Number.isSafeInteger(value.eventSerial) &&
      value.eventSerial > 0
    ) {
      const size = nativeTerminalSemanticPayloadBytes(
        value,
        NATIVE_TERMINAL_EFFECT_LIMITS.payloadBytes - this.bootstrap.bytes,
      )
      if (this.bootstrap.events.length >= 512 || size === undefined) {
        this.bootstrap.overflowSerial = Math.max(
          this.bootstrap.overflowSerial,
          value.eventSerial,
        )
      } else {
        this.bootstrap.events.push(value)
        this.bootstrap.bytes += size
      }
      return
    }
    if (
      current.disposed ||
      value.id !== current.sessionId ||
      !current.instanceId ||
      value.instanceId !== current.instanceId ||
      !Number.isSafeInteger(value.eventSerial) ||
      value.eventSerial < 0 ||
      (value.eventSerial === 0 && value.effect.kind !== 'semantic-gap')
    )
      return
    const kind = value.effect.kind
    const cutoff = kind === 'semantic-gap' ? value.effect.controlCutoff : undefined
    if (
      cutoff !== undefined &&
      (!Number.isSafeInteger(cutoff) ||
        cutoff <= 0 ||
        cutoff !== value.eventSerial ||
        cutoff <= this.controlCutoff)
    )
      return
    const serialKind = kind === 'semantic-gap' ? 'semantic' : kind
    if (
      cutoff !== undefined
        ? false
        : kind === 'semantic-gap'
          ? value.eventSerial < this.serial.semantic
          : value.eventSerial <= this.serial[serialKind]
    )
      return
    let event: TerminalEvent
    if (kind === 'title') event = { type: 'title', title: value.effect.title }
    else if (kind === 'bell') event = { type: 'bell' }
    else if (kind === 'semantic-gap') {
      event =
        cutoff === undefined
          ? { type: 'semantic-gap' }
          : { type: 'semantic-gap', controlCutoff: cutoff }
      if (cutoff !== undefined) this.controlCutoff = cutoff
    } else {
      const action = SEMANTIC_ACTIONS[value.effect.action]
      if (!action) return
      event = {
        type: 'semantic',
        action,
        options: value.effect.options,
        provenance: {
          id: value.eventSerial,
          boundaryId: value.effect.boundaryId,
          screen: value.effect.screen,
          row: value.effect.row,
          column: value.effect.column,
        },
      }
    }
    this.serial[serialKind] = Math.max(this.serial[serialKind], value.eventSerial)
    for (const listener of this.listeners) listener(event)
  }
  restoreTitle(
    title: { readonly title: string; readonly eventSerial: number } | undefined,
  ): void {
    const current = this.current()
    if (title && current.sessionId && current.instanceId)
      this.accept({
        id: current.sessionId,
        instanceId: current.instanceId,
        eventSerial: title.eventSerial,
        effect: { kind: 'title', title: title.title },
      })
  }
  subscribe(listener: (event: TerminalEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private emitSemanticGap(): void {
    if (this.current().disposed) return
    for (const listener of this.listeners) listener({ type: 'semantic-gap' })
  }
  clear(): void {
    this.bootstrap = undefined
    this.listeners.clear()
  }
}

// Pinned native semantic_prompt.Command enum order; unknown values have no authority.
const SEMANTIC_ACTIONS: readonly TerminalSemanticAction[] = [
  'fresh-line',
  'fresh-line-new-prompt',
  'new-command',
  'prompt-start',
  'end-prompt-start-input',
  'end-prompt-start-input-terminate-eol',
  'end-input-start-output',
  'end-command',
]
