import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  normalizeTerminalColorTheme,
  terminalColorThemeEquals,
  terminalThemeForAppearance,
} from '../src/renderer/src/terminal/terminal-palette'

describe('terminal palette policy', () => {
  it('defines complete documented dark and light palettes', () => {
    expect(terminalThemeForAppearance('dark')).toEqual({
      background: '#111318',
      foreground: '#d8dee9',
      cursor: '#d8dee9',
      cursorText: '#000000',
      selectionBackground: '#39445a',
      selectionForeground: '#ffffff',
      black: '#20242c',
      red: '#e06c75',
      green: '#98c379',
      yellow: '#e5c07b',
      blue: '#61afef',
      magenta: '#c678dd',
      cyan: '#56b6c2',
      white: '#d8dee9',
      brightBlack: '#666666',
      brightRed: '#f14c4c',
      brightGreen: '#23d18b',
      brightYellow: '#f5f543',
      brightBlue: '#3b8eea',
      brightMagenta: '#d670d6',
      brightCyan: '#29b8db',
      brightWhite: '#e5e5e5',
    })
    expect(terminalThemeForAppearance('light')).toEqual({
      background: '#ecece7',
      foreground: '#1c222d',
      cursor: '#1c222d',
      cursorText: '#ffffff',
      selectionBackground: '#b2bdd3',
      selectionForeground: '#000000',
      black: '#d8dce4',
      red: '#d46069',
      green: '#2e590f',
      yellow: '#5e3900',
      blue: '#1a68a8',
      magenta: '#a557bc',
      cyan: '#10707c',
      white: '#1c222d',
      brightBlack: '#999999',
      brightRed: '#ff6d6d',
      brightGreen: '#00823c',
      brightYellow: '#242400',
      brightBlue: '#3487e3',
      brightMagenta: '#bb55bb',
      brightCyan: '#007fa2',
      brightWhite: '#1a1a1a',
    })
    expect(Object.isFrozen(terminalThemeForAppearance('dark'))).toBe(true)
    expect(Object.isFrozen(terminalThemeForAppearance('light'))).toBe(true)
  })

  it('normalizes one complete strict palette without widening color syntax', () => {
    const candidate = {
      ...terminalThemeForAppearance('dark'),
      red: '#E06C75',
    }

    const normalized = normalizeTerminalColorTheme(candidate, 'light')

    expect(normalized).toEqual(terminalThemeForAppearance('dark'))
    expect(normalized).not.toBe(terminalThemeForAppearance('dark'))
    expect(Object.isFrozen(normalized)).toBe(true)
  })

  it.each([
    null,
    [],
    {},
    { ...terminalThemeForAppearance('dark'), red: '#fff' },
    { ...terminalThemeForAppearance('dark'), red: 'rgb(255, 0, 0)' },
    { ...terminalThemeForAppearance('dark'), red: '#ff000080' },
    { ...terminalThemeForAppearance('dark'), red: 0xff0000 },
    { ...terminalThemeForAppearance('dark'), opacity: '#000000' },
  ])(
    'fails an invalid or incomplete palette closed to the appearance default',
    (value) => {
      expect(normalizeTerminalColorTheme(value, 'light')).toBe(
        terminalThemeForAppearance('light'),
      )
    },
  )

  it('compares complete palette values rather than object identity', () => {
    const dark = terminalThemeForAppearance('dark')
    expect(terminalColorThemeEquals(dark, { ...dark })).toBe(true)
    expect(terminalColorThemeEquals(dark, { ...dark, background: '#000000' })).toBe(false)
  })

  it('keeps terminal Canvas presentation free of post-render color filters', () => {
    const themesCss = readFileSync(
      new URL('../src/renderer/src/themes.css', import.meta.url),
      'utf8',
    )

    expect(themesCss).not.toMatch(/terminal[^}]*filter\s*:/s)
    expect(themesCss).not.toContain('hue-rotate(')
    expect(themesCss).not.toContain('invert(')
  })
})
