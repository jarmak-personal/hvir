import { describe, expect, it } from 'vitest'

import {
  measureVariableRows,
  variableVirtualRange,
  virtualRange,
} from '../src/renderer/src/git/virtual-range'

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

  it('windows mixed commit and expanded-file rows by their measured offsets', () => {
    const measurements = measureVariableRows([40, 28, 28, 40, 28, 40])
    const range = variableVirtualRange(measurements, 68, 40, 1)

    expect(range.start).toBe(1)
    expect(range.end).toBe(5)
    expect(measurements.offsets).toEqual([0, 40, 68, 96, 136, 164, 204])
    expect(measurements.totalHeight).toBe(204)
  })

  it('keeps a mixed-height deep window bounded', () => {
    const heights = Array.from({ length: 100_000 }, (_, index) =>
      index % 4 === 0 ? 40 : 28,
    )
    const measurements = measureVariableRows(heights)
    const range = variableVirtualRange(measurements, 2_000_000, 480, 8)

    expect(range.start).toBeGreaterThan(0)
    expect(range.end).toBeLessThan(heights.length)
    expect(range.end - range.start).toBeLessThanOrEqual(34)
  })
})
