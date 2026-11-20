import { describe, expect, it, vi } from 'vitest'
import { localPath } from '../src/shared/host-path'
import type { NativeTerminalSession } from '../src/shared/native-terminal'
import type {
  NativeTerminalEffectBatch,
  NativeTerminalSemanticEffect,
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
    const close = vi.fn<(source: NativeBoundarySource, token: string) => Promise<void>>(
      () => Promise.resolve(),
    )
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
    await vi.waitFor(() => expect(close).toHaveBeenCalledWith(source, '4'))
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
        (
          session: NativeTerminalSession,
          effects: readonly NativeTerminalSemanticEffect[],
        ) => void
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
    expect(snapshot.effects.some((event) => event.eventSerial === 512)).toBe(false)
    await owner.controlApplied(source, 513)
    expect((await owner.snapshot(source)).effects.at(-1)?.eventSerial).toBe(514)
    await owner.consume(source, { ...marker(515), semanticGeneration: 2 })
    await owner.consume(source, { ...marker(400), semanticGeneration: 1 })
    expect((await owner.snapshot(source)).effects.at(-1)?.eventSerial).toBe(515)
  })
  it('rejects late old-owner lookup/close without rotating the current owner back', async () => {
    let owner = 1
    const source = (ownerId: number): NativeBoundarySource => ({
      handle: 'physical-surface',
      session: { ...session, ownerId },
      assertCurrent: () => {
        if (owner !== ownerId) throw new Error('owner-stale')
      },
    })
    const close = vi.fn<(source: NativeBoundarySource, token: string) => Promise<void>>(
      () => Promise.resolve(),
    )
    const boundaries = new NativeTerminalQueryBoundaries(close, vi.fn())
    const a = source(1)
    await boundaries.consume(a, marker(5))
    const oldId = boundaryId(await boundaries.snapshot(a))
    expect(boundaries.lookup(a, oldId)).toBe('5')
    owner = 2
    const b = source(2)
    const transferred = await boundaries.snapshot(b)
    const newId = boundaryId(transferred)
    expect(newId).not.toBe(oldId)
    expect(boundaries.lookup(b, newId)).toBe('5')
    expect(boundaries.lookup(a, newId)).toBeUndefined()
    expect(boundaries.lookup(b, newId)).toBe('5')
    expect(boundaryId(await boundaries.snapshot(b))).toBe(newId)
    await expect(boundaries.snapshot(a)).rejects.toThrow('owner-stale')
    expect(close).not.toHaveBeenCalledWith(expect.anything(), '5')
  })

  it('retires control-cutoff authority even when publishing its gap fails', async () => {
    const source = { handle: 'physical-surface', session, assertCurrent: () => {} }
    const close = vi.fn<(source: NativeBoundarySource, token: string) => Promise<void>>(
      () => Promise.resolve(),
    )
    const publish = vi.fn()
    const owner = new NativeTerminalQueryBoundaries(close, publish)
    await owner.consume(source, marker(1))
    const old = boundaryId(await owner.snapshot(source))
    publish.mockImplementationOnce(() => {
      throw new Error('delivery failed')
    })
    await owner.controlApplied(source, 2)
    expect(owner.lookup(source, old)).toBeUndefined()
    await owner.consume(source, marker(3))
    expect(close).toHaveBeenCalledWith(source, '1')
    expect(owner.lookup(source, boundaryId(await owner.snapshot(source)))).toBe('3')
  })

  it('bounds replay metadata and retires exact native tokens without revoking recent positions', async () => {
    const source = { handle: 'physical-surface', session, assertCurrent: () => {} }
    const close = vi.fn<(source: NativeBoundarySource, token: string) => Promise<void>>(
      () => Promise.resolve(),
    )
    const publish =
      vi.fn<
        (
          session: NativeTerminalSession,
          effects: readonly NativeTerminalSemanticEffect[],
        ) => void
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
      publish.mock.calls.every(([, events]) =>
        events.every((event) => event.effect.kind === 'semantic'),
      ),
    ).toBe(true)
  })

  it('enforces UTF-8 metadata admission and publishes a genuine producer gap at its inclusive cutoff', async () => {
    const source = { handle: 'physical-surface', session, assertCurrent: () => {} }
    const close = vi.fn<(source: NativeBoundarySource, token: string) => Promise<void>>(
      () => Promise.resolve(),
    )
    const publish =
      vi.fn<
        (
          session: NativeTerminalSession,
          effects: readonly NativeTerminalSemanticEffect[],
        ) => void
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
    expect(publish.mock.calls.at(-1)?.[1]).toEqual([
      expect.objectContaining({
        eventSerial: 20,
        effect: { kind: 'semantic-gap' },
      }),
    ])
    expect((await boundaries.snapshot(source)).effects).toEqual([
      expect.objectContaining({ eventSerial: 20, effect: { kind: 'semantic-gap' } }),
    ])
  })
  it('publishes every131 ordered source fact plus its leading producer gap in one list', async () => {
    const assertCurrent = vi.fn(),
      source = { handle: 'physical-surface', session, assertCurrent }
    const publish =
      vi.fn<
        (
          session: NativeTerminalSession,
          effects: readonly NativeTerminalSemanticEffect[],
        ) => void
      >()
    const owner = new NativeTerminalQueryBoundaries(() => Promise.resolve(), publish)
    await owner.consume(source, {
      droppedEffects: 1,
      semanticGeneration: 1,
      effects: Array.from({ length: 131 }, (_, index) => marker(index + 1).effects[0]!),
    })
    expect(publish).toHaveBeenCalledOnce()
    const emitted = publish.mock.calls[0]![1]
    expect(emitted).toHaveLength(132)
    expect(emitted.map((effect) => effect.eventSerial)).toEqual(
      Array.from({ length: 132 }, (_, index) => index),
    )
    expect(emitted[0]?.effect.kind).toBe('semantic-gap')
    expect(emitted.slice(1).every((effect) => effect.effect.kind === 'semantic')).toBe(
      true,
    )
    expect(assertCurrent.mock.calls.length).toBeGreaterThanOrEqual(131)
  })

  it('keeps in-batch control, missing-boundary gaps and later facts in their original order', async () => {
    const source = { handle: 'physical-surface', session, assertCurrent: () => {} }
    const close = vi.fn<(source: NativeBoundarySource, token: string) => Promise<void>>(
      () => Promise.resolve(),
    )
    const publish =
      vi.fn<
        (
          session: NativeTerminalSession,
          effects: readonly NativeTerminalSemanticEffect[],
        ) => void
      >()
    const owner = new NativeTerminalQueryBoundaries(close, publish)
    await owner.consume(source, {
      droppedEffects: 0,
      semanticGeneration: 0,
      effects: [
        marker(1).effects[0]!,
        {
          kind: 'screen',
          sequence: 2,
          eventSerial: 2,
          action: 'clear',
          screen: 'normal',
        },
        marker(3).effects[0]!,
        {
          kind: 'semantic',
          sequence: 4,
          eventSerial: 4,
          action: 1,
          options: '',
          screen: 'normal',
          row: 4,
          column: 0,
        },
        marker(5).effects[0]!,
      ],
    })
    expect(publish).toHaveBeenCalledOnce()
    expect(
      publish.mock.calls[0]![1].map((effect) => [effect.eventSerial, effect.effect.kind]),
    ).toEqual([
      [1, 'semantic'],
      [2, 'semantic-gap'],
      [3, 'semantic'],
      [4, 'semantic-gap'],
      [5, 'semantic'],
    ])
    expect(publish.mock.calls[0]![1][1]?.effect).toEqual({
      kind: 'semantic-gap',
      controlCutoff: 2,
    })
    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledWith(source, '1')
      expect(close).toHaveBeenCalledWith(source, '3')
    })
    const snapshot = await owner.snapshot(source)
    expect(
      snapshot.effects
        .filter((effect) => effect.effect.kind === 'semantic')
        .map((effect) => effect.eventSerial),
    ).toEqual([5])
  })

  it('retains ordered partial facts followed by invalidation when processing fails, without failing PTY feed', async () => {
    let assertions = 0
    const source = {
      handle: 'physical-surface',
      session,
      assertCurrent() {
        if (++assertions === 4) throw new Error('internal-fact-failure')
      },
    }
    const close = vi.fn<(source: NativeBoundarySource, token: string) => Promise<void>>(
      () => Promise.resolve(),
    )
    const publish =
      vi.fn<
        (
          session: NativeTerminalSession,
          effects: readonly NativeTerminalSemanticEffect[],
        ) => void
      >()
    const owner = new NativeTerminalQueryBoundaries(close, publish)
    await expect(
      owner.consume(source, {
        droppedEffects: 0,
        semanticGeneration: 0,
        effects: [marker(1).effects[0]!, marker(2).effects[0]!, marker(3).effects[0]!],
      }),
    ).resolves.toBeUndefined()
    expect(publish).toHaveBeenCalledOnce()
    expect(
      publish.mock.calls[0]![1].map((effect) => [effect.eventSerial, effect.effect.kind]),
    ).toEqual([
      [1, 'semantic'],
      [3, 'semantic-gap'],
    ])
    await vi.waitFor(() =>
      expect(close.mock.calls.map(([, token]) => token)).toEqual(['1', '2', '3']),
    )
    expect(
      (await owner.snapshot(source)).effects.every(
        (effect) => effect.effect.kind === 'semantic-gap',
      ),
    ).toBe(true)
  })

  it('contains internal publication failure and immediately publishes a singleton invalidation gap', async () => {
    const source = { handle: 'physical-surface', session, assertCurrent: () => {} }
    const close = vi.fn<(source: NativeBoundarySource, token: string) => Promise<void>>(
      () => Promise.resolve(),
    )
    const publish =
      vi.fn<
        (
          session: NativeTerminalSession,
          effects: readonly NativeTerminalSemanticEffect[],
        ) => void
      >()
    publish.mockImplementationOnce(() => {
      throw new Error('internal-publication-failure')
    })
    const owner = new NativeTerminalQueryBoundaries(close, publish)
    await expect(
      owner.consume(source, {
        droppedEffects: 0,
        semanticGeneration: 0,
        effects: [marker(1).effects[0]!, marker(2).effects[0]!],
      }),
    ).resolves.toBeUndefined()
    expect(
      publish.mock.calls.map(([, effects]) =>
        effects.map((effect) => effect.effect.kind),
      ),
    ).toEqual([['semantic', 'semantic'], ['semantic-gap']])
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(2))
    expect(
      (await owner.snapshot(source)).effects.some(
        (effect) => effect.effect.kind === 'semantic',
      ),
    ).toBe(false)
  })

  it('emits out-of-band control and async retirement-failure gaps immediately as singleton lists', async () => {
    const source = { handle: 'physical-surface', session, assertCurrent: () => {} }
    const close = vi.fn<(source: NativeBoundarySource, token: string) => Promise<void>>(
      () => Promise.reject(new Error('native-close-failure')),
    )
    const publish =
      vi.fn<
        (
          session: NativeTerminalSession,
          effects: readonly NativeTerminalSemanticEffect[],
        ) => void
      >()
    const owner = new NativeTerminalQueryBoundaries(close, publish)
    await owner.consume(source, marker(1))
    publish.mockClear()
    await owner.controlApplied(source, 2)
    expect(publish.mock.calls[0]![1]).toHaveLength(1)
    expect(publish.mock.calls[0]![1][0]?.effect).toEqual({
      kind: 'semantic-gap',
      controlCutoff: 2,
    })
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(2))
    expect(publish.mock.calls[1]![1]).toHaveLength(1)
    expect(publish.mock.calls[1]![1][0]?.effect).toEqual({ kind: 'semantic-gap' })
    owner.forgetDestroyed(session.instanceId)
  })

  it('observes the whole source batch before cap removal so replaced native pins are not closed again', async () => {
    const source = { handle: 'physical-surface', session, assertCurrent: () => {} }
    const close = vi.fn<(source: NativeBoundarySource, token: string) => Promise<void>>(
      () => Promise.resolve(),
    )
    const publish =
      vi.fn<
        (
          session: NativeTerminalSession,
          effects: readonly NativeTerminalSemanticEffect[],
        ) => void
      >()
    const owner = new NativeTerminalQueryBoundaries(close, publish)
    for (let serial = 1; serial <= 511; serial++)
      await owner.consume(source, marker(serial))
    publish.mockClear()
    await owner.consume(source, {
      droppedEffects: 0,
      semanticGeneration: 0,
      effects: Array.from({ length: 131 }, (_, index) => marker(512 + index).effects[0]!),
    })
    await vi.waitFor(() => expect(close).toHaveBeenCalledWith(source, '131'))
    expect(close.mock.calls.some(([, token]) => Number(token) <= 130)).toBe(false)
    expect(publish).toHaveBeenCalledOnce()
    expect(publish.mock.calls[0]![1]).toHaveLength(131)
  })
})
