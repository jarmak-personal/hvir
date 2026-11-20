import { describe, expect, it } from 'vitest'
import { normalizeNativeTerminalPixels } from '../src/workers/native-terminal-pixels'

describe('off-thread compatibility pixel normalization', () => {
  it('converts BGRA premultiplication to exact RGBA straight alpha without mutating the source allocation', () => {
    const source = Uint8Array.of(0, 32, 64, 128, 255, 0, 0, 255, 99, 88, 77, 0)
    const copied = source.slice()
    expect(normalizeNativeTerminalPixels(copied, 12, 1)).toBe(copied)
    expect(copied).toEqual(Uint8Array.of(128, 64, 0, 128, 0, 0, 255, 255, 0, 0, 0, 0))
    expect(source).toEqual(Uint8Array.of(0, 32, 64, 128, 255, 0, 0, 255, 99, 88, 77, 0))
  })
  it('normalizes bottom-left rows without changing the color-space interpretation', () => {
    const copied = Uint8Array.of(255, 0, 0, 255, 0, 0, 255, 255)
    expect(normalizeNativeTerminalPixels(copied, 4, 2)).toEqual(
      Uint8Array.of(255, 0, 0, 255, 0, 0, 255, 255),
    )
  })
  it('preserves the independently owned packed allocation when normalizing', () => {
    const storage = new ArrayBuffer(16),
      bytes = new Uint8Array(storage)
    bytes.set([0, 0, 255, 255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 0])
    expect(normalizeNativeTerminalPixels(bytes, 8, 2)).toBe(bytes)
    expect(bytes.buffer).toBe(storage)
    expect(bytes).toEqual(
      Uint8Array.of(0, 255, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255, 0, 0, 255, 255),
    )
  })
  it('rejects malformed layouts, oversize copies and shared mutable storage', () => {
    for (const [bytes, stride, origin] of [
      [new Uint8Array(3), 4, 1],
      [new Uint8Array(4), 3, 1],
      [new Uint8Array(4), 4, 3],
      [new Uint8Array(8193 * 4), 4, 1],
      [new Uint8Array(new SharedArrayBuffer(4)), 4, 1],
    ] as const)
      expect(() => normalizeNativeTerminalPixels(bytes, stride, origin)).toThrow()
  })
})
