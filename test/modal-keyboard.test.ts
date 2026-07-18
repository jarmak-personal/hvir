import { describe, expect, it } from 'vitest'

import { nextModalFocusIndex } from '../src/renderer/src/workbench/modal-keyboard-model'

describe('modal keyboard ownership', () => {
  it('traps forward and reverse focus at dialog boundaries', () => {
    expect(nextModalFocusIndex(2, 3, false)).toBe(0)
    expect(nextModalFocusIndex(0, 3, true)).toBe(2)
    expect(nextModalFocusIndex(-1, 3, false)).toBe(0)
    expect(nextModalFocusIndex(-1, 0, false)).toBeUndefined()
  })
})
