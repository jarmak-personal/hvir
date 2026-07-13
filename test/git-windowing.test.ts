import { describe, expect, it } from 'vitest'

import { virtualRange } from '../src/renderer/src/git/virtual-range'

describe('Git list windowing', () => {
  it('keeps a deep history window independent of accumulated commit count', () => {
    const range = virtualRange(100_000, 48, 2_000_000, 480, 8)

    expect(range.start).toBeGreaterThan(0)
    expect(range.end).toBeLessThan(100_000)
    expect(range.end - range.start).toBeLessThanOrEqual(27)
  })

  it('clamps change/detail windows at both ends', () => {
    expect(virtualRange(50, 28, 0, 280, 4)).toEqual({ start: 0, end: 14 })
    expect(virtualRange(50, 28, 1_400, 280, 4)).toEqual({ start: 46, end: 50 })
  })
})
