import { describe, expect, it } from 'vitest'

import { EffectGeneration } from '../src/renderer/src/terminal/effect-generation'

describe('terminal effect generations', () => {
  it('invalidates stale completions and makes repeated cleanup idempotent', () => {
    const generation = new EffectGeneration()
    const first = generation.begin()
    expect(generation.isCurrent(first)).toBe(true)
    generation.invalidate(first)
    expect(generation.isCurrent(first)).toBe(false)
    const afterCleanup = generation.snapshot()
    generation.invalidate(first)
    expect(generation.snapshot()).toBe(afterCleanup)

    const second = generation.begin()
    expect(generation.isCurrent(second)).toBe(true)
    expect(generation.isCurrent(first)).toBe(false)
  })
})
