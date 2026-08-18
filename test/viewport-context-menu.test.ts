import { describe, expect, it } from 'vitest'

import { boundedContextMenuPosition } from '../src/renderer/src/context-menu/viewport-context-menu'

describe('viewport context-menu placement', () => {
  it('keeps measured menus inside every viewport edge', () => {
    const menu = { width: 208, height: 280 }
    const viewport = { width: 480, height: 320 }

    expect(boundedContextMenuPosition({ x: -50, y: -20 }, menu, viewport)).toEqual({
      left: 8,
      top: 8,
    })
    expect(boundedContextMenuPosition({ x: 479, y: 319 }, menu, viewport)).toEqual({
      left: 264,
      top: 32,
    })
  })

  it('pins an oversized menu to the margin while CSS supplies internal scrolling', () => {
    expect(
      boundedContextMenuPosition(
        { x: 470, y: 310 },
        { width: 700, height: 900 },
        { width: 480, height: 320 },
      ),
    ).toEqual({ left: 8, top: 8 })
  })
})
