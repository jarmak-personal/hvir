import { describe, expect, it } from 'vitest'

import {
  fontFamilyStack,
  normalizeFontPreference,
  normalizeInterfaceScale,
  normalizeTerminalTextSize,
  SYSTEM_INTERFACE_FONT_STACK,
  SYSTEM_MONOSPACE_FONT_STACK,
} from '../src/renderer/src/settings/typography-settings'

describe('typography settings policy', () => {
  it('uses platform-provided generic stacks without requiring bundled fonts', () => {
    expect(SYSTEM_INTERFACE_FONT_STACK).toContain('system-ui')
    expect(SYSTEM_INTERFACE_FONT_STACK).toMatch(/sans-serif$/)
    expect(SYSTEM_INTERFACE_FONT_STACK).not.toContain('Inter')
    expect(SYSTEM_MONOSPACE_FONT_STACK).toContain('ui-monospace')
    expect(SYSTEM_MONOSPACE_FONT_STACK).toMatch(/monospace$/)
    expect(SYSTEM_MONOSPACE_FONT_STACK).not.toContain('JetBrains Mono')
  })

  it('prepends one normalized custom family and always retains a generic fallback', () => {
    const preference = normalizeFontPreference({
      mode: 'custom',
      family: '  Example   Mono  ',
    })

    expect(preference).toEqual({ mode: 'custom', family: 'Example Mono' })
    expect(fontFamilyStack(preference, 'monospace')).toMatch(
      /^"Example Mono".*monospace$/,
    )
  })

  it('falls back safely for blank, multi-family, control, and malformed values', () => {
    for (const value of [
      { mode: 'custom', family: '' },
      { mode: 'custom', family: 'One, Two' },
      { mode: 'custom', family: 'Bad\nFont' },
      { mode: 'custom', family: 42 },
      { mode: 'unexpected', family: 'Example' },
      null,
    ]) {
      expect(normalizeFontPreference(value)).toEqual({ mode: 'system', family: '' })
    }
  })

  it('normalizes stored scale and terminal size into bounded values', () => {
    expect(normalizeInterfaceScale(Number.NaN)).toBe(1)
    expect(normalizeInterfaceScale(0.2)).toBe(0.8)
    expect(normalizeInterfaceScale(1.234)).toBe(1.25)
    expect(normalizeInterfaceScale(4)).toBe(1.5)
    expect(normalizeTerminalTextSize(Number.POSITIVE_INFINITY)).toBe(13)
    expect(normalizeTerminalTextSize(2)).toBe(10)
    expect(normalizeTerminalTextSize(17.7)).toBe(18)
    expect(normalizeTerminalTextSize(40)).toBe(24)
  })
})
