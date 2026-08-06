import type { AppTheme } from '../theme-model'
import type { TerminalColorTheme } from './terminal-pane'

const COLOR = /^#[0-9a-f]{6}$/i
const COLOR_KEYS = [
  'background',
  'foreground',
  'cursor',
  'cursorText',
  'selectionBackground',
  'selectionForeground',
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const satisfies readonly (keyof TerminalColorTheme)[]
const COLOR_KEY_SET: ReadonlySet<string> = new Set(COLOR_KEYS)

// Preserve the established dark presentation, including ghostty-web defaults
// for the cursor/selection text and bright ANSI entries hvir previously omitted.
const DARK_TERMINAL_THEME = defineTheme({
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

// Replace the former Canvas filter with its visually equivalent bounded colors;
// keep the established light terminal surface background as the real base color.
const LIGHT_TERMINAL_THEME = defineTheme({
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

/** The documented hvir palette for one application appearance. */
export function terminalThemeForAppearance(theme: AppTheme): TerminalColorTheme {
  return theme === 'light' ? LIGHT_TERMINAL_THEME : DARK_TERMINAL_THEME
}

/** Accept one complete bounded palette or fail closed to the appearance default. */
export function normalizeTerminalColorTheme(
  value: unknown,
  appearance: AppTheme,
): TerminalColorTheme {
  const fallback = terminalThemeForAppearance(appearance)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback
  const candidate = value as Record<string, unknown>
  const keys = Object.keys(candidate)
  if (keys.length !== COLOR_KEYS.length || keys.some((key) => !COLOR_KEY_SET.has(key))) {
    return fallback
  }
  const normalized = {} as Record<keyof TerminalColorTheme, string>
  for (const key of COLOR_KEYS) {
    const color = candidate[key]
    if (
      !Object.hasOwn(candidate, key) ||
      typeof color !== 'string' ||
      !COLOR.test(color)
    ) {
      return fallback
    }
    normalized[key] = color.toLowerCase()
  }
  return Object.freeze(normalized)
}

export function terminalColorThemeEquals(
  left: TerminalColorTheme,
  right: TerminalColorTheme,
): boolean {
  return left === right || COLOR_KEYS.every((key) => left[key] === right[key])
}

function defineTheme(theme: TerminalColorTheme): TerminalColorTheme {
  return Object.freeze(theme)
}
