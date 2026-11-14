import { describe, expect, it, vi } from 'vitest'
import { drainNativeTerminalEffects } from '../src/workers/native-terminal-effects'
import { validNativeTerminalEffectBatch } from '../src/shared/native-terminal-effects'
const bytes = (value: string) => new TextEncoder().encode(value)
const empty = { result: 6, droppedEffects: 4n, semanticGeneration: 2n }
function event(kind = 3, overrides = {}) {
  return {
    result: 0,
    droppedEffects: 4n,
    semanticGeneration: 2n,
    event: {
      kind,
      action: 0,
      screen: 0,
      row: 0,
      column: 0,
      sequence: 1n,
      eventSerial: 1n,
      data: bytes(''),
      extra: bytes(''),
      truncated: false,
      ...overrides,
    },
  }
}
describe('single native copied effect drain', () => {
  it('preserves complete OSC52 payload/selection/provenance and out-of-band gaps', () => {
    const payload = 'YQ=='.repeat(16384)
    const next = vi
      .fn()
      .mockReturnValueOnce(
        event(5, { action: 1, data: bytes(payload), extra: bytes('pc') }),
      )
      .mockReturnValue(empty)
    const result = drainNativeTerminalEffects(next)
    expect(result).toEqual({
      result: 0,
      droppedEffects: 4,
      semanticGeneration: 2,
      effects: [
        {
          kind: 'clipboard',
          protocol: 'osc-52',
          data: payload,
          selection: 'pc',
          sequence: 1,
          eventSerial: 1,
        },
      ],
    })
    expect(validNativeTerminalEffectBatch(result)).toBe(true)
    expect(next).toHaveBeenCalledTimes(2)
  })
  it('copies title/CWD/notification and post-mutation semantic coordinates without inventing retained identities', () => {
    const next = vi
      .fn()
      .mockReturnValueOnce(event(1, { data: bytes('title') }))
      .mockReturnValueOnce(
        event(2, { eventSerial: 2n, data: bytes('file://remote/home/me') }),
      )
      .mockReturnValueOnce(
        event(4, { eventSerial: 3n, action: 1, data: bytes('t'), extra: bytes('b') }),
      )
      .mockReturnValueOnce(
        event(6, {
          eventSerial: 4n,
          action: 7,
          screen: 1,
          row: 50,
          column: 3,
          data: bytes('exit=0'),
        }),
      )
      .mockReturnValue(empty)
    const batch = drainNativeTerminalEffects(next)
    expect(batch.effects.map((item) => item.kind)).toEqual([
      'title',
      'cwd',
      'notification',
      'semantic',
    ])
    expect(batch.effects[3]).toEqual({
      kind: 'semantic',
      action: 7,
      screen: 'alternate',
      row: 50,
      column: 3,
      options: 'exit=0',
      sequence: 1,
      eventSerial: 4,
    })
  })
  it('keeps binary palette RGB out of UTF8 decoding and preserves ignored progress facts', () => {
    const next = vi
      .fn()
      .mockReturnValueOnce(
        event(7, {
          action: 0,
          screen: 4,
          row: 0,
          column: 1,
          data: new Uint8Array([255, 0, 128]),
        }),
      )
      .mockReturnValueOnce(event(10, { action: 2, row: 0xffffffff, eventSerial: 2n }))
      .mockReturnValue(empty)
    const result = drainNativeTerminalEffects(next)
    expect(result.effects).toEqual([
      {
        kind: 'palette',
        action: 0,
        operation: 4,
        targetClass: 0,
        targetIndex: 1,
        rgb: [255, 0, 128],
        sequence: 1,
        eventSerial: 1,
      },
      { kind: 'progress', action: 2, sequence: 1, eventSerial: 2 },
    ])
    expect(validNativeTerminalEffectBatch(result)).toBe(true)
  })
  it('rejects duplicate/reversed native serials before a batch can gain policy authority', () => {
    for (const serial of [1n, 0n]) {
      const next = vi
        .fn()
        .mockReturnValueOnce(event())
        .mockReturnValueOnce(event(3, { eventSerial: serial }))
      expect(() => drainNativeTerminalEffects(next)).toThrow(
        'native-effect-serial-invalid',
      )
    }
    expect(
      validNativeTerminalEffectBatch({
        effects: [
          { kind: 'bell', sequence: 1, eventSerial: 1 },
          { kind: 'bell', sequence: 1, eventSerial: 1 },
        ],
        droppedEffects: 0,
        semanticGeneration: 0,
      }),
    ).toBe(false)
  })
  it('requires real empty after the exact bounded131 records', () => {
    let serial = 0
    const next = vi.fn(() =>
      ++serial <= 131 ? event(3, { eventSerial: BigInt(serial) }) : empty,
    )
    expect(drainNativeTerminalEffects(next).effects).toHaveLength(131)
    expect(next).toHaveBeenCalledTimes(132)
    let forever = 0
    expect(() =>
      drainNativeTerminalEffects(() => event(3, { eventSerial: BigInt(++forever) })),
    ).toThrow('native-effect-drain-bound')
  })
  it('rejects truncated/invalid UTF8 and oversized data before product delivery', () => {
    for (const overrides of [
      { truncated: true },
      { data: new Uint8Array([255]) },
      { data: new Uint8Array(128 * 1024 + 1) },
      { sequence: -1n },
      { eventSerial: 0n },
    ])
      expect(() => drainNativeTerminalEffects(() => event(1, overrides))).toThrow()
    expect(
      validNativeTerminalEffectBatch({
        effects: [{ kind: 'unknown', sequence: 1, eventSerial: 1 }],
        droppedEffects: 0,
        semanticGeneration: 0,
      }),
    ).toBe(false)
    expect(drainNativeTerminalEffects(() => ({ ...empty, result: 4 })).result).toBe(4)
  })
})
