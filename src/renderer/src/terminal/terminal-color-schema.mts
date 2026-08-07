import type { TerminalColorTheme } from './terminal-pane'

/** The complete bounded color contract shared by generated and runtime palettes. */
export const TERMINAL_COLOR_PATTERN = /^#[0-9a-f]{6}$/i
export const TERMINAL_COLOR_KEYS = [
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

export type TerminalColorKey = (typeof TERMINAL_COLOR_KEYS)[number]
