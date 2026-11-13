import { describe, expect, it, vi } from 'vitest'
import { discardNativeTerminalEffects } from '../src/workers/native-terminal-effects'

describe('unsupported native effect mailbox housekeeping', () => {
  it('consumes repeated normal-feed effects without accumulated metadata or side effects', () => {
    let pending = 0
    const next = vi.fn(() => ({ result: pending-- > 0 ? 0 : 6 }))
    for (let feed = 0; feed < 200; feed++) {
      pending = 10
      expect(discardNativeTerminalEffects(next)).toEqual({ result: 0, discarded: 10 })
      expect(pending).toBe(-1)
    }
    expect(next).toHaveBeenCalledTimes(2200)
  })
  it('drains all FIFO and latest slots then requires the actual empty result', () => {
    let pending = 130
    const next = vi.fn(() => ({ result: pending-- > 0 ? 0 : 6 }))
    expect(discardNativeTerminalEffects(next)).toEqual({ result: 0, discarded: 130 })
    expect(next).toHaveBeenCalledTimes(131)
  })
  it('preserves native failure and bounds a producer that never reports empty', () => {
    const failed = vi.fn(() => ({ result: 4 }))
    expect(discardNativeTerminalEffects(failed)).toEqual({ result: 4, discarded: 0 })
    expect(failed).toHaveBeenCalledTimes(1)
    const forever = vi.fn(() => ({ result: 0 }))
    expect(discardNativeTerminalEffects(forever)).toEqual({ result: 5, discarded: 131 })
    expect(forever).toHaveBeenCalledTimes(131)
  })
})
