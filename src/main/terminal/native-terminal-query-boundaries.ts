import { randomUUID } from 'node:crypto'
import { NativeTerminalSemanticRetirement } from './native-terminal-semantic-retirement'
import type { NativeTerminalSession } from '../../shared/native-terminal'
import {
  NATIVE_TERMINAL_EFFECT_LIMITS,
  nativeTerminalSemanticPayloadBytes,
  type NativeTerminalSemanticEffect,
  type NativeTerminalEffectBatch,
  type NativeTerminalProductEffect,
  type NativeTerminalSemanticSnapshot,
} from '../../shared/native-terminal-effects'

export interface NativeBoundarySource {
  readonly handle: string
  readonly session: NativeTerminalSession
  assertCurrent(): void
}
type SemanticEffect = NativeTerminalProductEffect & {
  readonly effect: Extract<NativeTerminalProductEffect['effect'], { kind: 'semantic' }>
}
interface Boundary {
  readonly id: string
  readonly native: string
  readonly bytes: number
  readonly effect: SemanticEffect
  revoked?: boolean
}
interface RetainedBoundaries {
  source: NativeBoundarySource
  readonly records: Map<string, Boundary>
  bytes: number
  throughSerial: number
  retiredThrough: number
  droppedEffects: number
  generation: number
  controlCutoff: number
}

/** Genuine parser positions, separately qualified from historical search content. */
export class NativeTerminalQueryBoundaries {
  private readonly surfaces = new Map<string, RetainedBoundaries>()
  private readonly handles = new Map<
    string,
    { surface: RetainedBoundaries; record: Boundary }
  >()
  private readonly retirement: NativeTerminalSemanticRetirement
  constructor(
    closeNative: (source: NativeBoundarySource, token: string) => Promise<void>,
    private readonly publish: (
      session: NativeTerminalSession,
      effects: readonly NativeTerminalSemanticEffect[],
    ) => void,
  ) {
    this.retirement = new NativeTerminalSemanticRetirement(closeNative, (source) => {
      const surface = this.surfaces.get(source.session.instanceId)
      if (surface) this.invalidate(surface)
    })
  }

  async consume(
    source: NativeBoundarySource,
    batch: NativeTerminalEffectBatch,
  ): Promise<void> {
    source.assertCurrent()
    let surface: RetainedBoundaries | undefined
    const emissions: NativeTerminalSemanticEffect[] = []
    const emit = (effect: NativeTerminalSemanticEffect): void => {
      emissions.push(effect)
    }
    try {
      for (const effect of batch.effects) {
        if (effect.kind === 'semantic' && effect.boundary)
          this.retirement.observe(source, effect.boundary, effect.eventSerial)
      }
      this.retirement.wake(source)
      surface = this.current(source)
      if (
        surface.droppedEffects < batch.droppedEffects ||
        surface.generation < batch.semanticGeneration
      ) {
        const controlCutoff = surface.controlCutoff
        this.clear(surface)
        source.assertCurrent()
        surface.droppedEffects = Math.max(surface.droppedEffects, batch.droppedEffects)
        surface.generation = Math.max(surface.generation, batch.semanticGeneration)
        if (surface.controlCutoff === controlCutoff) emit(this.gap(surface))
      }
      for (const effect of batch.effects) {
        source.assertCurrent()
        if (effect.eventSerial <= surface.throughSerial) {
          if (
            effect.kind === 'semantic' &&
            effect.boundary &&
            effect.eventSerial <= surface.controlCutoff
          )
            this.retirement.retire(source, effect.boundary)
          continue
        }
        if (
          effect.kind === 'screen' &&
          (effect.action === 'reset' || effect.action === 'clear')
        ) {
          this.applyControl(source, effect.eventSerial, emit)
          source.assertCurrent()
        }
        if (effect.kind !== 'semantic') {
          surface.throughSerial = Math.max(surface.throughSerial, effect.eventSerial)
          continue
        }
        if (!effect.boundary) {
          this.clear(surface)
          source.assertCurrent()
          surface.throughSerial = Math.max(surface.throughSerial, effect.eventSerial)
          emit(this.gap(surface))
          continue
        }
        const id = randomUUID()
        const published: SemanticEffect = {
          id: source.session.sessionId,
          instanceId: source.session.instanceId,
          eventSerial: effect.eventSerial,
          effect: {
            kind: 'semantic',
            boundaryId: id,
            action: effect.action,
            options: effect.options,
            screen: effect.screen,
            row: effect.row,
            column: effect.column,
          },
        }
        const bytes = this.bytes(published)
        const maximumBytes =
          NATIVE_TERMINAL_EFFECT_LIMITS.payloadBytes - this.bytes(this.gap(surface))
        while (
          surface.records.size &&
          (surface.records.size >= 511 || surface.bytes + bytes > maximumBytes)
        ) {
          const oldest = surface.records.values().next().value as Boundary
          surface.retiredThrough = Math.max(
            surface.retiredThrough,
            oldest.effect.eventSerial,
          )
          this.retire(surface, oldest)
          source.assertCurrent()
        }
        // Older copied facts cannot repopulate metadata after a genuine control.
        if (effect.eventSerial <= surface.controlCutoff) {
          this.retirement.retire(source, effect.boundary)
          continue
        }
        if (bytes > maximumBytes) {
          const controlCutoff = surface.controlCutoff
          this.retirement.retire(source, effect.boundary)
          source.assertCurrent()
          if (effect.eventSerial <= surface.controlCutoff) continue
          this.clear(surface)
          source.assertCurrent()
          surface.throughSerial = Math.max(surface.throughSerial, effect.eventSerial)
          if (surface.controlCutoff === controlCutoff) emit(this.gap(surface))
          continue
        }
        const record = { id, native: effect.boundary, effect: published, bytes }
        surface.records.set(id, record)
        this.handles.set(id, { surface, record })
        surface.bytes += bytes
        surface.throughSerial = effect.eventSerial
        emit(published)
      }
    } catch {
      for (const effect of batch.effects) {
        if (effect.kind === 'semantic' && effect.boundary)
          this.retirement.retire(source, effect.boundary)
      }
      if (surface) {
        for (const effect of batch.effects)
          surface.throughSerial = Math.max(surface.throughSerial, effect.eventSerial)
        this.invalidate(surface, emit)
      }
    }
    if (emissions.length) {
      try {
        this.publish(source.session, emissions)
      } catch {
        if (surface) this.invalidate(surface)
      }
    }
    return Promise.resolve()
  }

  /** A genuine control acknowledgment can arrive after newer parser facts. */
  async controlApplied(source: NativeBoundarySource, cutoff: number): Promise<void> {
    this.applyControl(source, cutoff)
    return Promise.resolve()
  }

  private applyControl(
    source: NativeBoundarySource,
    cutoff: number,
    emit: (effect: NativeTerminalSemanticEffect) => void = (effect) =>
      this.publish(source.session, [effect]),
  ): void {
    if (!Number.isSafeInteger(cutoff) || cutoff <= 0)
      throw new Error('native-boundary-control-cutoff-invalid')
    const current = this.surfaces.get(source.session.instanceId)
    const surface =
      current &&
      current.source.handle === source.handle &&
      current.source.session.ownerId === source.session.ownerId &&
      current.source.session.ownerGeneration === source.session.ownerGeneration
        ? current
        : this.current(source)
    source.assertCurrent()
    if (cutoff <= surface.controlCutoff) return
    surface.controlCutoff = cutoff
    surface.throughSerial = Math.max(surface.throughSerial, cutoff)
    surface.retiredThrough = Math.max(surface.retiredThrough, cutoff)
    const obsolete = Array.from(surface.records.values()).filter(
      (record) => record.effect.eventSerial <= cutoff,
    )
    for (const record of obsolete) this.retire(surface, record)
    try {
      emit({
        ...this.gap(surface, cutoff),
        effect: { kind: 'semantic-gap', controlCutoff: cutoff },
      })
    } catch {
      this.invalidate(surface, emit)
    }
    source.assertCurrent()
  }

  async snapshot(source: NativeBoundarySource): Promise<NativeTerminalSemanticSnapshot> {
    const surface = this.current(source)
    source.assertCurrent()
    return Promise.resolve({
      throughSerial: surface.throughSerial,
      effects: [
        ...(surface.retiredThrough ? [this.gap(surface, surface.retiredThrough)] : []),
        ...Array.from(surface.records.values())
          .filter((record) => !record.revoked)
          .map((record) => record.effect),
      ],
    })
  }

  lookup(source: NativeBoundarySource, id: string): string | undefined {
    const found = this.handles.get(id)
    if (
      !found ||
      found.record.revoked ||
      found.surface.source.handle !== source.handle ||
      found.surface.source.session.instanceId !== source.session.instanceId ||
      found.surface.source.session.ownerId !== source.session.ownerId ||
      found.surface.source.session.ownerGeneration !== source.session.ownerGeneration
    )
      return
    return found.record.native
  }

  async remove(instanceId: string): Promise<void> {
    const surface = this.surfaces.get(instanceId)
    if (!surface) return
    this.clear(surface)
    if (this.surfaces.get(instanceId) === surface) this.surfaces.delete(instanceId)
    return Promise.resolve()
  }
  /** Called only after the native owner confirms physical Surface destruction. */
  forgetDestroyed(instanceId: string): void {
    this.retirement.forgetDestroyed(instanceId)
    const surface = this.surfaces.get(instanceId)
    if (!surface) return
    for (const record of surface.records.values()) this.handles.delete(record.id)
    this.surfaces.delete(instanceId)
  }

  private current(source: NativeBoundarySource): RetainedBoundaries {
    source.assertCurrent()
    const instanceId = source.session.instanceId
    let surface = this.surfaces.get(instanceId)
    if (!surface) {
      surface = {
        source,
        records: new Map(),
        bytes: 0,
        throughSerial: 0,
        retiredThrough: 0,
        droppedEffects: 0,
        generation: 0,
        controlCutoff: 0,
      }
      this.surfaces.set(instanceId, surface)
    } else {
      if (surface.source.handle !== source.handle)
        throw new Error('native-boundary-instance-mismatch')
      if (
        surface.source.session.ownerId !== source.session.ownerId ||
        surface.source.session.ownerGeneration !== source.session.ownerGeneration
      ) {
        // Retained native positions survive transfer; old renderer handles do not.
        const records = Array.from(surface.records.values())
        for (const prior of records) this.handles.delete(prior.id)
        surface.records.clear()
        surface.source = source
        for (const prior of records) {
          const id = randomUUID()
          const effect = {
            ...prior.effect,
            effect: { ...prior.effect.effect, boundaryId: id },
          }
          const record = { ...prior, id, effect }
          surface.records.set(id, record)
          this.handles.set(id, { surface, record })
        }
      }
      surface.source = source
    }
    return surface
  }

  private retire(surface: RetainedBoundaries, record: Boundary): void {
    this.handles.delete(record.id)
    record.revoked = true
    if (surface.records.delete(record.id)) surface.bytes -= record.bytes
    this.retirement.retire(surface.source, record.native)
  }
  private clear(surface: RetainedBoundaries): void {
    surface.retiredThrough = Math.max(surface.retiredThrough, surface.throughSerial)
    for (const record of surface.records.values()) this.retire(surface, record)
  }
  private invalidate(
    surface: RetainedBoundaries,
    emit: (effect: NativeTerminalSemanticEffect) => void = (effect) =>
      this.publish(surface.source.session, [effect]),
  ): void {
    this.clear(surface)
    // Publishing metadata cannot turn a cleanup failure into a PTY failure.
    try {
      emit(this.gap(surface))
    } catch {
      /* Authority is already revoked. */
    }
  }
  private gap(
    surface: RetainedBoundaries,
    eventSerial = surface.throughSerial,
  ): NativeTerminalSemanticEffect {
    return {
      id: surface.source.session.sessionId,
      instanceId: surface.source.session.instanceId,
      eventSerial,
      effect: { kind: 'semantic-gap' },
    }
  }
  private bytes(effect: NativeTerminalSemanticEffect): number {
    const bytes = nativeTerminalSemanticPayloadBytes(effect, Infinity)
    if (bytes === undefined) throw new Error('native-boundary-payload')
    return bytes
  }
}
