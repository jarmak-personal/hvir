import { describe, expect, it, vi } from 'vitest'
import { localPath } from '../src/shared/host-path'
import type { NativeTerminalSession } from '../src/shared/native-terminal'
import type {
  NativeTerminalEffectBatch,
  NativeTerminalProductEffect,
} from '../src/shared/native-terminal-effects'
import {
  NativeTerminalQueryBoundaries,
  type NativeBoundarySource,
} from '../src/main/terminal/native-terminal-query-boundaries'

const session: NativeTerminalSession = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  instanceId: '22222222-2222-4222-8222-222222222222',
  ownerId: 1,
  ownerGeneration: 1,
  workspaceRoot: localPath('/tmp/native-query-boundaries'),
}
function marker(serial: number, options = ''): NativeTerminalEffectBatch {
  return {
    droppedEffects: 0,
    semanticGeneration: 0,
    effects: [
      {
        kind: 'semantic',
        sequence: serial,
        eventSerial: serial,
        action: 1,
        options,
        screen: 'normal',
        row: serial,
        column: 0,
        boundary: String(serial),
      },
    ],
  }
}
function boundaryId(
  snapshot: Awaited<ReturnType<NativeTerminalQueryBoundaries['snapshot']>>,
): string {
  const effect = snapshot.effects.find(
    (event) => event.effect.kind === 'semantic',
  )?.effect
  if (effect?.kind !== 'semantic') throw new Error('Expected genuine semantic boundary')
  return effect.boundaryId
}

describe('Main semantic boundary authority', () => {
  it('selectively prunes a late control cutoff and retains a newer parser handle', async () => {
    const source = { handle: 'physical-surface', session, assertCurrent: () => {} }
    const close = vi.fn(() => Promise.resolve())
    const owner = new NativeTerminalQueryBoundaries(close, vi.fn())
    await owner.consume(source, marker(3))
    const old = boundaryId(await owner.snapshot(source))
    await owner.consume(source, marker(8))
    const newer = (await owner.snapshot(source)).effects.at(-1)!.effect
    if (newer.kind !== 'semantic') throw new Error('Expected current handle')
    const clearing = owner.controlApplied(source, 5)
    expect(owner.lookup(source, old)).toBeUndefined()
    expect(owner.lookup(source, newer.boundaryId)).toBe('8')
    await clearing
    await owner.consume(source, marker(4))
    expect((await owner.snapshot(source)).throughSerial).toBe(8)
    expect(close).toHaveBeenCalledWith(source, '3')
    expect(close).toHaveBeenCalledWith(source, '4')
    expect(close).not.toHaveBeenCalledWith(source, '8')
  })
  it('floors paused old facts at the genuine cutoff while preserving newer facts and monotonic generation', async () => {
    const source = { handle: 'physical-surface', session, assertCurrent: () => {} }
    let release!: () => void
    let entered!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const close = vi.fn((_source: NativeBoundarySource, token: string) => {
      if (token === '1') {
        entered()
        return held
      }
      return Promise.resolve()
    })
    const publish =
      vi.fn<
        (session: NativeTerminalSession, effect: NativeTerminalProductEffect) => void
      >()
    const owner = new NativeTerminalQueryBoundaries(close, publish)
    for (let index = 1; index <= 511; index++) await owner.consume(source, marker(index))
    const paused = owner.consume(source, marker(512))
    await started
    const cutoff = owner.controlApplied(source, 513)
    release()
    await Promise.all([paused, cutoff])
    await owner.consume(source, marker(514))
    const snapshot = await owner.snapshot(source)
    expect(snapshot.throughSerial).toBe(514)
    expect(
      snapshot.effects
        .filter((event) => event.effect.kind === 'semantic')
        .map((event) => event.eventSerial),
    ).toEqual([514])
    expect(publish.mock.calls.some(([, event]) => event.eventSerial === 512)).toBe(false)
    await owner.controlApplied(source, 513)
    expect((await owner.snapshot(source)).effects.at(-1)?.eventSerial).toBe(514)
    await owner.consume(source, { ...marker(515), semanticGeneration: 2 })
    await owner.consume(source, { ...marker(400), semanticGeneration: 1 })
    expect((await owner.snapshot(source)).effects.at(-1)?.eventSerial).toBe(515)
  })
  it.each(['capture', 'consume'] as const)(
    'rejects old-owner %s after an awaited eviction',
    async (operation) => {
      let owner = 1
      let release!: () => void
      let entered!: () => void
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const source = (ownerId: number): NativeBoundarySource => ({
        handle: 'physical-surface',
        session: { ...session, ownerId },
        assertCurrent: () => {
          if (owner !== ownerId) throw new Error('owner-stale')
        },
      })
      const close = vi.fn((_source: NativeBoundarySource, token: string) => {
        if (token === '1') {
          entered()
          return held
        }
        return Promise.resolve()
      })
      const publish =
        vi.fn<
          (session: NativeTerminalSession, effect: NativeTerminalProductEffect) => void
        >()
      const boundaries = new NativeTerminalQueryBoundaries(close, publish)
      const a = source(1)
      for (let index = 1; index <= 511; index++)
        await boundaries.consume(a, marker(index))
      publish.mockClear()
      const pending =
        operation === 'capture'
          ? boundaries.capture(a, '999')
          : boundaries.consume(a, marker(512))
      await started
      owner = 2
      const b = source(2)
      const transferred = await boundaries.snapshot(b)
      const current = transferred.effects.at(-1)!.effect
      if (current.kind !== 'semantic') throw new Error('Expected current boundary')
      release()
      await expect(pending).rejects.toThrow('owner-stale')
      expect(boundaries.lookup(b, current.boundaryId)).toBe('511')
      const after = await boundaries.snapshot(b)
      expect(after.throughSerial).toBe(511)
      expect(after.effects.at(-1)).toEqual(transferred.effects.at(-1))
      expect(publish).not.toHaveBeenCalled()
    },
  )

  it('rejects late old-owner lookup/close without rotating the current owner back', async () => {
    let owner = 1
    const source = (ownerId: number): NativeBoundarySource => ({
      handle: 'physical-surface',
      session: { ...session, ownerId },
      assertCurrent: () => {
        if (owner !== ownerId) throw new Error('owner-stale')
      },
    })
    const close = vi.fn(() => Promise.resolve())
    const boundaries = new NativeTerminalQueryBoundaries(close, vi.fn())
    const a = source(1)
    await boundaries.consume(a, marker(5))
    const oldId = boundaryId(await boundaries.snapshot(a))
    const end = await boundaries.capture(a, '99')
    expect(boundaries.lookup(a, oldId)).toBe('5')
    owner = 2
    const b = source(2)
    const transferred = await boundaries.snapshot(b)
    const newId = boundaryId(transferred)
    expect(newId).not.toBe(oldId)
    expect(boundaries.lookup(b, newId)).toBe('5')
    expect(boundaries.lookup(b, end)).toBeUndefined()
    expect(close).toHaveBeenCalledWith(b, '99')
    expect(boundaries.lookup(a, newId)).toBeUndefined()
    await boundaries.close(a, newId)
    expect(boundaries.lookup(b, newId)).toBe('5')
    expect(boundaryId(await boundaries.snapshot(b))).toBe(newId)
    await expect(boundaries.snapshot(a)).rejects.toThrow('owner-stale')
    expect(close).not.toHaveBeenCalledWith(expect.anything(), '5')
  })

  it('bounds replay metadata and retires exact native tokens without revoking recent positions', async () => {
    const source = { handle: 'physical-surface', session, assertCurrent: () => {} }
    const close = vi.fn(() => Promise.resolve())
    const publish =
      vi.fn<
        (session: NativeTerminalSession, effect: NativeTerminalProductEffect) => void
      >()
    const boundaries = new NativeTerminalQueryBoundaries(close, publish)
    await boundaries.consume(source, marker(1))
    const oldest = boundaryId(await boundaries.snapshot(source))
    for (let index = 2; index <= 520; index++)
      await boundaries.consume(source, marker(index))
    const snapshot = await boundaries.snapshot(source)
    expect(snapshot.effects.length).toBeLessThanOrEqual(512)
    expect(snapshot.throughSerial).toBe(520)
    expect(boundaries.lookup(source, oldest)).toBeUndefined()
    const newest = snapshot.effects.at(-1)!.effect
    expect(newest.kind).toBe('semantic')
    if (newest.kind === 'semantic')
      expect(boundaries.lookup(source, newest.boundaryId)).toBe('520')
    expect(close).toHaveBeenCalledWith(source, '1')
    expect(
      publish.mock.calls.every(([, event]) => event.effect.kind === 'semantic'),
    ).toBe(true)
  })

  it('enforces UTF-8 metadata admission and publishes a genuine producer gap at its inclusive cutoff', async () => {
    const source = { handle: 'physical-surface', session, assertCurrent: () => {} }
    const close = vi.fn(() => Promise.resolve())
    const publish =
      vi.fn<
        (session: NativeTerminalSession, effect: NativeTerminalProductEffect) => void
      >()
    const boundaries = new NativeTerminalQueryBoundaries(close, publish)
    for (let index = 1; index <= 20; index++)
      await boundaries.consume(source, marker(index, '🙂'.repeat(16384)))
    const snapshot = await boundaries.snapshot(source)
    const bytes = snapshot.effects.reduce(
      (sum, { effect }) =>
        sum + (effect.kind === 'semantic' ? Buffer.byteLength(effect.options) : 0),
      0,
    )
    expect(bytes).toBeLessThanOrEqual(1024 * 1024)
    expect(close).toHaveBeenCalled()
    const id = boundaryId(snapshot)
    await boundaries.consume(source, {
      effects: [],
      droppedEffects: 1,
      semanticGeneration: 1,
    })
    expect(boundaries.lookup(source, id)).toBeUndefined()
    expect(publish.mock.calls.at(-1)?.[1]).toMatchObject({
      eventSerial: 20,
      effect: { kind: 'semantic-gap' },
    })
    expect((await boundaries.snapshot(source)).effects).toEqual([
      expect.objectContaining({ eventSerial: 20, effect: { kind: 'semantic-gap' } }),
    ])
  })
})
