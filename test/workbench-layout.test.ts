import { describe, expect, it } from 'vitest'

import {
  clamp,
  fitTerminalHeight,
} from '../src/renderer/src/workbench/workbench-layout-policy'

describe('workbench layout policy', () => {
  it('clamps tracks to the usable shell area', () => {
    expect(clamp(100, 160, 520)).toBe(160)
    expect(clamp(700, 160, 520)).toBe(520)
    expect(fitTerminalHeight(900, 800)).toBe(615)
    expect(fitTerminalHeight(20, 800)).toBe(160)
  })
})
