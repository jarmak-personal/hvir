import { randomUUID } from 'node:crypto'
import type { NativeTerminalSession } from '../../shared/native-terminal'
import {
  NATIVE_TERMINAL_EFFECT_LIMITS,
  type NativeTerminalEffectBatch,
  type NativeTerminalProductEffect,
  type NativeTerminalSemanticSnapshot,
} from '../../shared/native-terminal-effects'

export interface NativeBoundarySource {
  readonly handle: string
  readonly session: NativeTerminalSession
  assertCurrent(): void
}
interface Boundary {
  readonly id: string
  readonly native: string
  readonly bytes: number
  readonly effect: NativeTerminalProductEffect
  closing?: Promise<void>
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
  constructor(
    private readonly closeNative: (
      source: NativeBoundarySource,
      token: string,
    ) => Promise<void>,
    private readonly publish: (
      session: NativeTerminalSession,
      effect: NativeTerminalProductEffect,
    ) => void,
  ) {}

  async consume(
    source: NativeBoundarySource,
    batch: NativeTerminalEffectBatch,
  ): Promise<void> {
    const surface = await this.current(source)
    source.assertCurrent()
    if (
      surface.droppedEffects < batch.droppedEffects ||
      surface.generation < batch.semanticGeneration
    ) {
      const controlCutoff = surface.controlCutoff
      await this.clear(surface)
      source.assertCurrent()
      surface.droppedEffects = Math.max(surface.droppedEffects, batch.droppedEffects)
      surface.generation = Math.max(surface.generation, batch.semanticGeneration)
      if (surface.controlCutoff === controlCutoff)
        this.publish(source.session, this.gap(surface))
    }
    for (const effect of batch.effects) {
      source.assertCurrent()
      if (effect.eventSerial <= surface.throughSerial) {
        if (
          effect.kind === 'semantic' &&
          effect.boundary &&
          effect.eventSerial <= surface.controlCutoff
        )
          await this.closeNative(source, effect.boundary)
        continue
      }
      if (
        effect.kind === 'screen' &&
        (effect.action === 'reset' || effect.action === 'clear')
      ) {
        await this.controlApplied(source, effect.eventSerial)
        source.assertCurrent()
      }
      if (effect.kind !== 'semantic') {
        surface.throughSerial = Math.max(surface.throughSerial, effect.eventSerial)
        continue
      }
      if (!effect.boundary) {
        await this.clear(surface)
        source.assertCurrent()
        surface.throughSerial = Math.max(surface.throughSerial, effect.eventSerial)
        this.publish(source.session, this.gap(surface))
        continue
      }
      const id = randomUUID()
      const published: NativeTerminalProductEffect = {
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
        await this.retire(surface, oldest)
        source.assertCurrent()
      }
      // A physically applied control may have overtaken the awaited eviction.
      if (effect.eventSerial <= surface.controlCutoff) {
        await this.closeNative(source, effect.boundary)
        continue
      }
      if (bytes > maximumBytes) {
        const controlCutoff = surface.controlCutoff
        await this.closeNative(source, effect.boundary)
        source.assertCurrent()
        if (effect.eventSerial <= surface.controlCutoff) continue
        await this.clear(surface)
        source.assertCurrent()
        surface.throughSerial = Math.max(surface.throughSerial, effect.eventSerial)
        if (surface.controlCutoff === controlCutoff)
          this.publish(source.session, this.gap(surface))
        continue
      }
      const record = { id, native: effect.boundary, effect: published, bytes }
      surface.records.set(id, record)
      this.handles.set(id, { surface, record })
      surface.bytes += bytes
      surface.throughSerial = effect.eventSerial
      this.publish(source.session, published)
    }
  }

  /** A genuine control acknowledgment can arrive after newer parser facts. */
  async controlApplied(source: NativeBoundarySource, cutoff: number): Promise<void> {
    if (!Number.isSafeInteger(cutoff) || cutoff <= 0)
      throw new Error('native-boundary-control-cutoff-invalid')
    const current = this.surfaces.get(source.session.instanceId)
    const surface =
      current &&
      current.source.handle === source.handle &&
      current.source.session.ownerId === source.session.ownerId &&
      current.source.session.ownerGeneration === source.session.ownerGeneration
        ? current
        : await this.current(source)
    source.assertCurrent()
    if (cutoff <= surface.controlCutoff) return
    surface.controlCutoff = cutoff
    surface.throughSerial = Math.max(surface.throughSerial, cutoff)
    surface.retiredThrough = Math.max(surface.retiredThrough, cutoff)
    const obsolete = Array.from(surface.records.values()).filter(
      (record) => record.effect.eventSerial <= cutoff,
    )
    for (const record of obsolete) {
      record.revoked = true
      this.handles.delete(record.id)
    }
    this.publish(source.session, {
      ...this.gap(surface, cutoff),
      effect: { kind: 'semantic-gap', controlCutoff: cutoff },
    })
    for (const record of obsolete) await this.retire(surface, record)
    source.assertCurrent()
  }

  async snapshot(source: NativeBoundarySource): Promise<NativeTerminalSemanticSnapshot> {
    const surface = await this.current(source)
    source.assertCurrent()
    return {
      throughSerial: surface.throughSerial,
      effects: [
        ...(surface.retiredThrough ? [this.gap(surface, surface.retiredThrough)] : []),
        ...Array.from(surface.records.values())
          .filter((record) => !record.revoked && record.effect.effect.kind === 'semantic')
          .map((record) => record.effect),
      ],
    }
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

  /** An explicit captured end shares the same bounded token owner and disposal rules. */
  async capture(source: NativeBoundarySource, native: string): Promise<string> {
    const surface = await this.current(source)
    source.assertCurrent()
    while (surface.records.size >= 511) {
      const oldest = surface.records.values().next().value as Boundary
      surface.retiredThrough = Math.max(surface.retiredThrough, oldest.effect.eventSerial)
      await this.retire(surface, oldest)
      source.assertCurrent()
    }
    const id = randomUUID()
    // Captured ends are not parser events and never enter a replay snapshot.
    const record: Boundary = {
      id,
      native,
      bytes: 0,
      effect: {
        id: source.session.sessionId,
        instanceId: source.session.instanceId,
        eventSerial: 0,
        effect: { kind: 'semantic-gap' },
      },
    }
    surface.records.set(id, record)
    this.handles.set(id, { surface, record })
    return id
  }

  async close(source: NativeBoundarySource, id: string): Promise<void> {
    const native = this.lookup(source, id)
    if (!native) return
    const found = this.handles.get(id)!
    await this.retire(found.surface, found.record)
  }

  async remove(instanceId: string): Promise<void> {
    const surface = this.surfaces.get(instanceId)
    if (!surface) return
    await this.clear(surface)
    if (this.surfaces.get(instanceId) === surface) this.surfaces.delete(instanceId)
  }
  /** Called only after the native owner confirms physical Surface destruction. */
  forgetDestroyed(instanceId: string): void {
    const surface = this.surfaces.get(instanceId)
    if (!surface) return
    for (const record of surface.records.values()) this.handles.delete(record.id)
    this.surfaces.delete(instanceId)
  }

  private async current(source: NativeBoundarySource): Promise<RetainedBoundaries> {
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
        const captured: Boundary[] = []
        for (const prior of records) {
          if (prior.revoked) {
            surface.records.set(prior.id, prior)
            continue
          }
          if (prior.effect.effect.kind !== 'semantic') {
            surface.records.set(prior.id, prior)
            captured.push(prior)
            continue
          }
          const id = randomUUID()
          const effect =
            prior.effect.effect.kind === 'semantic'
              ? { ...prior.effect, effect: { ...prior.effect.effect, boundaryId: id } }
              : prior.effect
          const record = { ...prior, id, effect }
          surface.records.set(id, record)
          this.handles.set(id, { surface, record })
        }
        for (const record of captured) {
          await this.retire(surface, record)
          source.assertCurrent()
        }
      }
      surface.source = source
    }
    return surface
  }

  private retire(surface: RetainedBoundaries, record: Boundary): Promise<void> {
    if (record.closing) return record.closing
    this.handles.delete(record.id)
    record.revoked = true
    record.closing = (async () => {
      await this.closeNative(surface.source, record.native)
      if (surface.records.get(record.id) === record) {
        surface.records.delete(record.id)
        surface.bytes -= record.bytes
      }
    })().catch((error: unknown) => {
      record.closing = undefined
      throw error
    })
    return record.closing
  }
  private async clear(surface: RetainedBoundaries): Promise<void> {
    const records = Array.from(surface.records.values())
    for (const record of records) {
      record.revoked = true
      this.handles.delete(record.id)
    }
    surface.retiredThrough = surface.throughSerial
    for (const record of records) await this.retire(surface, record)
  }
  private gap(
    surface: RetainedBoundaries,
    eventSerial = surface.throughSerial,
  ): NativeTerminalProductEffect {
    return {
      id: surface.source.session.sessionId,
      instanceId: surface.source.session.instanceId,
      eventSerial,
      effect: { kind: 'semantic-gap' },
    }
  }
  private bytes(effect: NativeTerminalProductEffect): number {
    return (
      Buffer.byteLength(effect.id) +
      Buffer.byteLength(effect.instanceId) +
      (effect.effect.kind === 'semantic'
        ? Buffer.byteLength(effect.effect.boundaryId) +
          Buffer.byteLength(effect.effect.options) +
          Buffer.byteLength(effect.effect.screen)
        : 0)
    )
  }
}
