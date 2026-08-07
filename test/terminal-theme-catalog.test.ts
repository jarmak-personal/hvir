import { describe, expect, it } from 'vitest'

import {
  DEFAULT_TERMINAL_THEME_IDS,
  normalizeTerminalThemeId,
  searchTerminalThemes,
  terminalThemeCatalogEntry,
  terminalThemePalette,
  TERMINAL_THEME_CATALOG,
  TERMINAL_THEME_CATALOG_SOURCE,
  TERMINAL_THEME_SEARCH_RESULT_LIMIT,
} from '../src/renderer/src/terminal/terminal-theme-catalog'
import { terminalThemeForAppearance } from '../src/renderer/src/terminal/terminal-palette'

describe('terminal theme catalog policy', () => {
  it('keeps exact hvir defaults beside the generated Ghostty collection', () => {
    expect(TERMINAL_THEME_CATALOG).toHaveLength(
      TERMINAL_THEME_CATALOG_SOURCE.expectedThemeCount + 2,
    )
    expect(terminalThemeCatalogEntry(DEFAULT_TERMINAL_THEME_IDS.dark, 'dark')).toEqual({
      id: DEFAULT_TERMINAL_THEME_IDS.dark,
      name: 'Hvir Dark',
      source: 'hvir',
      palette: terminalThemeForAppearance('dark'),
    })
    expect(terminalThemeCatalogEntry(DEFAULT_TERMINAL_THEME_IDS.light, 'light')).toEqual({
      id: DEFAULT_TERMINAL_THEME_IDS.light,
      name: 'Hvir Light',
      source: 'hvir',
      palette: terminalThemeForAppearance('light'),
    })
    expect(TERMINAL_THEME_CATALOG.at(2)?.source).toBe('ghostty')
  })

  it('normalizes removed or malformed IDs while allowing any catalog theme per appearance', () => {
    expect(normalizeTerminalThemeId(undefined, 'dark')).toBe(
      DEFAULT_TERMINAL_THEME_IDS.dark,
    )
    expect(normalizeTerminalThemeId('removed-theme', 'light')).toBe(
      DEFAULT_TERMINAL_THEME_IDS.light,
    )
    expect(normalizeTerminalThemeId(DEFAULT_TERMINAL_THEME_IDS.dark, 'light')).toBe(
      DEFAULT_TERMINAL_THEME_IDS.dark,
    )
  })

  it('resolves separate selected palettes for the effective appearance', () => {
    const dark = searchTerminalThemes('Catppuccin Mocha').entries[0]!
    const light = searchTerminalThemes('Alabaster').entries[0]!

    expect(terminalThemePalette('dark', light.id, dark.id)).toBe(dark.palette)
    expect(terminalThemePalette('light', light.id, dark.id)).toBe(light.palette)
    expect(terminalThemePalette('dark', 'missing', 'missing')).toBe(
      terminalThemeForAppearance('dark'),
    )
  })

  it('searches names case-insensitively and caps synchronous preview results', () => {
    const all = searchTerminalThemes('')
    expect(all.entries).toHaveLength(TERMINAL_THEME_SEARCH_RESULT_LIMIT)
    expect(all.total).toBe(TERMINAL_THEME_CATALOG.length)
    expect(all.limited).toBe(true)

    const exact = searchTerminalThemes('cAtPpUcCiN mOcHa')
    expect(exact.entries.map((theme) => theme.name)).toEqual(['Catppuccin Mocha'])
    expect(exact.limited).toBe(false)
    expect(searchTerminalThemes('no such bundled theme').entries).toEqual([])
    expect(searchTerminalThemes('', 5).entries).toHaveLength(5)
    expect(searchTerminalThemes('', 10_000).entries).toHaveLength(
      TERMINAL_THEME_SEARCH_RESULT_LIMIT,
    )
  })
})
