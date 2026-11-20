import { describe, expect, it } from 'vitest'
import {
  nativeTerminalPackedPixelLayout,
  validNativeTerminalViewGrant,
} from '../src/shared/native-terminal-presentation'

describe('held-frame packed pixel geometry', () => {
  it.each([
    [3840, 2160, 15360, 33177600],
    [5120, 2880, 20480, 58982400],
    [1, 1, 4, 4],
  ])('derives exact %sx%s owned storage', (width, height, stride, byteLength) => {
    expect(nativeTerminalPackedPixelLayout(width, height)).toEqual({
      stride,
      byteLength,
    })
  })
  it.each([
    [0, 32],
    [-1, 32],
    [32, 0],
    [32, 8193],
    [8193, 32],
    [1.5, 32],
    [Infinity, 32],
    [NaN, 32],
    [Number.MAX_SAFE_INTEGER, 32],
  ])('refuses invalid image geometry %s/%s', (width, height) => {
    expect(nativeTerminalPackedPixelLayout(width, height)).toBeUndefined()
  })
  it('does not widen terminal authority to tiny packed images', () => {
    expect(
      validNativeTerminalViewGrant({
        viewId: 'a'.repeat(36),
        nativeEpoch: 'b'.repeat(36),
        attachment: 1,
        geometrySerial: 1,
        width: 1,
        height: 1,
        backingScale: 1,
      }),
    ).toBe(false)
  })
})
