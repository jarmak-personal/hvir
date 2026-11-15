import {
  MAX_MONOSPACE_FONT_STACK_LENGTH,
  MIN_TERMINAL_TEXT_SIZE,
  MAX_TERMINAL_TEXT_SIZE,
} from './interface-typography'

const APPEARANCE_KEYS = new Set([
  'fontFamily',
  'fontSize',
  'ligatures',
  'cursorShape',
  'cursorBlink',
  'appearance',
  'colors',
])

/** Bounded presentation values only; this grants no Ghostty configuration authority. */
export interface NativeTerminalAppearance {
  readonly fontFamily: string
  readonly fontSize: number
  readonly ligatures: boolean
  readonly cursorShape: 'block' | 'hollow-block' | 'bar' | 'underline'
  readonly cursorBlink: 'terminal' | 'blinking' | 'steady'
  readonly appearance: 'dark' | 'light'
  /** background, foreground, cursor, cursor text, selection background/foreground, ANSI16. */
  readonly colors: readonly number[]
}

export function validNativeTerminalAppearance(
  value: unknown,
): value is NativeTerminalAppearance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as NativeTerminalAppearance
  return (
    Object.keys(v).length === 7 &&
    Object.keys(v).every((key) => APPEARANCE_KEYS.has(key)) &&
    typeof v.fontFamily === 'string' &&
    v.fontFamily.length > 0 &&
    v.fontFamily.length <= MAX_MONOSPACE_FONT_STACK_LENGTH &&
    // The native ABI independently caps its copied UTF-8 storage.
    new TextEncoder().encode(v.fontFamily).byteLength <= 1024 &&
    Array.from(v.fontFamily).every((character) => {
      const code = character.codePointAt(0)!
      return code > 31 && code !== 127
    }) &&
    Number.isInteger(v.fontSize) &&
    v.fontSize >= MIN_TERMINAL_TEXT_SIZE &&
    v.fontSize <= MAX_TERMINAL_TEXT_SIZE &&
    typeof v.ligatures === 'boolean' &&
    ['block', 'hollow-block', 'bar', 'underline'].includes(v.cursorShape) &&
    ['terminal', 'blinking', 'steady'].includes(v.cursorBlink) &&
    ['dark', 'light'].includes(v.appearance) &&
    Array.isArray(v.colors) &&
    v.colors.length === 22 &&
    Array.from(v.colors).every(
      (color) => Number.isInteger(color) && color >= 0 && color <= 0xffffff,
    )
  )
}

/** Shaping changes share the typography invalidation boundary even at equal metrics. */
export function nativeTerminalTypographyChanged(
  previous: NativeTerminalAppearance | undefined,
  next: NativeTerminalAppearance,
): boolean {
  return (
    !previous ||
    previous.fontFamily !== next.fontFamily ||
    previous.fontSize !== next.fontSize ||
    previous.ligatures !== next.ligatures
  )
}

export function nativeTerminalAppearanceEquals(
  previous: NativeTerminalAppearance | undefined,
  next: NativeTerminalAppearance,
): boolean {
  return (
    !!previous &&
    !nativeTerminalTypographyChanged(previous, next) &&
    previous.cursorShape === next.cursorShape &&
    previous.cursorBlink === next.cursorBlink &&
    previous.appearance === next.appearance &&
    previous.colors.length === next.colors.length &&
    previous.colors.every((color, index) => color === next.colors[index])
  )
}
