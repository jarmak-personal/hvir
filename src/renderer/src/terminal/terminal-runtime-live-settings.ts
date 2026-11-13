import { isNativeTerminalPane, type TerminalRuntimePane } from './terminal-pane'
import { terminalColorThemeEquals } from './terminal-palette'
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
  if (isNativeTerminalPane(pane)) return
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
  if (pane && isNativeTerminalPane(pane)) return false
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
