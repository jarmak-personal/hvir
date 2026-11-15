import { isNativeTerminalPane, type TerminalRuntimePane } from './terminal-pane'
import { terminalColorThemeEquals, TERMINAL_COLOR_KEYS } from './terminal-palette'
import type { NativeTerminalAppearance } from '../../../shared/native-terminal-appearance'
import type { TerminalRuntimeOptions } from './terminal-runtime-options'

export function runtimeCanInteract(
  options: Pick<TerminalRuntimeOptions, 'active' | 'presentation'>,
): boolean {
  return options.active && options.presentation === 'visible'
}

/** Synchronize the latest presentation options after asynchronous pane construction. */
export function synchronizePanePresentationOptions(
  pane: TerminalRuntimePane,
  options: TerminalRuntimeOptions,
): void {
  if (isNativeTerminalPane(pane)) {
    pane.setAppearance(nativePaneAppearance(options))
    return
  }
  pane.setTheme(options.theme)
  pane.setTypography(options.typography)
  pane.setCursorDefaults(options.cursorDefaults)
  pane.setLigatures(options.ligatures)
}

/** Apply mutable presentation settings without replacing the pane or its native state. */
export function applyLivePaneOptions(
  pane: TerminalRuntimePane | undefined,
  previous: TerminalRuntimeOptions,
  next: TerminalRuntimeOptions,
): boolean {
  const typographyChanged =
    next.typography.fontFamily !== previous.typography.fontFamily ||
    next.typography.fontSize !== previous.typography.fontSize
  if (pane && isNativeTerminalPane(pane)) {
    if (
      typographyChanged ||
      !terminalColorThemeEquals(next.theme, previous.theme) ||
      next.cursorDefaults.shape !== previous.cursorDefaults.shape ||
      next.cursorDefaults.blink !== previous.cursorDefaults.blink ||
      next.ligatures !== previous.ligatures
    )
      pane.setAppearance(nativePaneAppearance(next))
    return false // Native completion owns its refit and query invalidation.
  }
  if (typographyChanged) pane?.setTypography(next.typography)
  if (!terminalColorThemeEquals(next.theme, previous.theme)) pane?.setTheme(next.theme)
  if (
    next.cursorDefaults.shape !== previous.cursorDefaults.shape ||
    next.cursorDefaults.blink !== previous.cursorDefaults.blink
  ) {
    pane?.setCursorDefaults(next.cursorDefaults)
  }
  if (next.ligatures !== previous.ligatures) pane?.setLigatures(next.ligatures)
  return typographyChanged
}

/** Map the existing palette/settings once; native receives no free-form config. */
export function nativePaneAppearance(
  options: Pick<
    TerminalRuntimeOptions,
    'theme' | 'typography' | 'cursorDefaults' | 'ligatures'
  >,
): NativeTerminalAppearance {
  const colors = TERMINAL_COLOR_KEYS.map((key) =>
    Number.parseInt(options.theme[key].slice(1), 16),
  )
  const background = colors[0]!
  const brightness =
    ((background >>> 16) * 299 +
      ((background >>> 8) & 255) * 587 +
      (background & 255) * 114) /
    1000
  return {
    ...options.typography,
    ligatures: options.ligatures,
    cursorShape: options.cursorDefaults.shape,
    cursorBlink: options.cursorDefaults.blink,
    appearance: brightness < 128 ? 'dark' : 'light',
    colors,
  }
}
