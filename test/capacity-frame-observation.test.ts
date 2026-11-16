import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {} }))

import { matchesCapacityFrameColor } from '../src/main/smoke/capacity-frame-observation'

describe('terminal compositor diagnostic color evidence', () => {
  it('recognizes BGRA pixels and refuses swapped channels or transparent pixels', () => {
    const red = new Uint8Array([32, 16, 240, 255])
    expect(matchesCapacityFrameColor(red, [240, 16, 32])).toBe(true)
    expect(matchesCapacityFrameColor(red, [32, 16, 240])).toBe(false)
    expect(
      matchesCapacityFrameColor(new Uint8Array([32, 16, 240, 0]), [240, 16, 32]),
    ).toBe(false)
  })

  it('requires a matching majority so a cursor or stale edge cannot qualify a frame', () => {
    const bitmap = new Uint8Array([
      32, 16, 240, 255, 32, 16, 240, 255, 32, 16, 240, 255, 240, 16, 32, 255,
    ])
    expect(matchesCapacityFrameColor(bitmap, [240, 16, 32])).toBe(true)
    expect(matchesCapacityFrameColor(bitmap, [32, 16, 240])).toBe(false)
    bitmap[10] = 0
    expect(matchesCapacityFrameColor(bitmap, [240, 16, 32])).toBe(false)
  })

  it('refuses absent and incomplete pixel evidence', () => {
    expect(matchesCapacityFrameColor(new Uint8Array(), [240, 16, 32])).toBe(false)
    expect(matchesCapacityFrameColor(new Uint8Array([32, 16, 240]), [240, 16, 32])).toBe(
      false,
    )
  })
})
