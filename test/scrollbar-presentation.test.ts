import { describe, expect, it } from 'vitest'

import { scrollbarAxisPresentation } from '../src/renderer/src/scrollbars/scrollbar-presentation'

describe('scrollbar presentation geometry', () => {
  it('omits a thumb when content does not overflow', () => {
    expect(scrollbarAxisPresentation(100, 100, 100, 0)).toBeUndefined()
    expect(scrollbarAxisPresentation(0, 100, 300, 0)).toBeUndefined()
  })

  it('maps the scroll range onto the overlay track', () => {
    expect(scrollbarAxisPresentation(100, 100, 400, 150)).toEqual({
      thumbLength: 25,
      thumbOffset: 37.5,
      travel: 75,
      maximum: 300,
    })
  })

  it('keeps a draggable minimum thumb and clamps stale positions', () => {
    expect(scrollbarAxisPresentation(80, 40, 4_000, 9_000)).toEqual({
      thumbLength: 24,
      thumbOffset: 56,
      travel: 56,
      maximum: 3_960,
    })
    expect(scrollbarAxisPresentation(80, 40, 4_000, -50)?.thumbOffset).toBe(0)
  })
})
