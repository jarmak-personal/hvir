import type { AppTheme } from '../theme-model'
import {
  GENERATED_TERMINAL_THEME_CATALOG,
  GENERATED_TERMINAL_THEME_CATALOG_PROVENANCE,
} from './generated-terminal-theme-catalog'
import {
  normalizeTerminalColorTheme,
  terminalThemeForAppearance,
} from './terminal-palette'
import type { TerminalColorTheme } from './terminal-pane'

export const DEFAULT_TERMINAL_THEME_IDS = {
  dark: 'hvir-default-dark',
  light: 'hvir-default-light',
} as const

export const TERMINAL_THEME_SEARCH_RESULT_LIMIT = 48

export interface TerminalThemeCatalogEntry {
  readonly id: string
  readonly name: string
  readonly source: 'hvir' | 'ghostty'
  readonly palette: TerminalColorTheme
}

export interface TerminalThemeSearchResult {
  readonly entries: readonly TerminalThemeCatalogEntry[]
  readonly total: number
  readonly limited: boolean
}

const BUILTIN_DEFAULTS: readonly TerminalThemeCatalogEntry[] = [
  {
    id: DEFAULT_TERMINAL_THEME_IDS.dark,
    name: 'Hvir Dark',
    source: 'hvir',
    palette: terminalThemeForAppearance('dark'),
  },
  {
    id: DEFAULT_TERMINAL_THEME_IDS.light,
    name: 'Hvir Light',
    source: 'hvir',
    palette: terminalThemeForAppearance('light'),
  },
]

export const TERMINAL_THEME_CATALOG_SOURCE = GENERATED_TERMINAL_THEME_CATALOG_PROVENANCE

export const TERMINAL_THEME_CATALOG: readonly TerminalThemeCatalogEntry[] = Object.freeze(
  [
    ...BUILTIN_DEFAULTS,
    ...GENERATED_TERMINAL_THEME_CATALOG.map((theme) =>
      Object.freeze({
        id: theme.id,
        name: theme.name,
        source: 'ghostty' as const,
        palette: normalizeTerminalColorTheme(theme.palette, 'dark'),
      }),
    ),
  ],
)

const THEME_BY_ID = new Map(TERMINAL_THEME_CATALOG.map((theme) => [theme.id, theme]))

export function normalizeTerminalThemeId(value: unknown, appearance: AppTheme): string {
  return typeof value === 'string' && THEME_BY_ID.has(value)
    ? value
    : DEFAULT_TERMINAL_THEME_IDS[appearance]
}

export function terminalThemeCatalogEntry(
  value: unknown,
  appearance: AppTheme,
): TerminalThemeCatalogEntry {
  return THEME_BY_ID.get(normalizeTerminalThemeId(value, appearance))!
}

export function terminalThemePalette(
  appearance: AppTheme,
  lightThemeId: unknown,
  darkThemeId: unknown,
): TerminalColorTheme {
  return terminalThemeCatalogEntry(
    appearance === 'light' ? lightThemeId : darkThemeId,
    appearance,
  ).palette
}

export function searchTerminalThemes(
  query: string,
  limit = TERMINAL_THEME_SEARCH_RESULT_LIMIT,
): TerminalThemeSearchResult {
  const boundedLimit = Math.max(0, Math.min(TERMINAL_THEME_SEARCH_RESULT_LIMIT, limit))
  const normalizedQuery = query.trim().toLocaleLowerCase('en-US')
  const matches = normalizedQuery
    ? TERMINAL_THEME_CATALOG.filter((theme) =>
        theme.name.toLocaleLowerCase('en-US').includes(normalizedQuery),
      )
    : TERMINAL_THEME_CATALOG
  return {
    entries: matches.slice(0, boundedLimit),
    total: matches.length,
    limited: matches.length > boundedLimit,
  }
}
