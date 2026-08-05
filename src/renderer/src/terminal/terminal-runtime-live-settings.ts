import type { TerminalPane } from './terminal-pane'
import { terminalColorThemeEquals } from './terminal-palette'
import type { TerminalRuntimeOptions } from './terminal-runtime-options'

export function runtimeCanInteract(
  options: Pick<TerminalRuntimeOptions, 'active' | 'presentation'>,
): boolean {
  return options.active && options.presentation === 'visible'
}

/** Apply mutable presentation settings without replacing the pane or its native state. */
export function applyLivePaneOptions(
  pane: TerminalPane | undefined,
  previous: TerminalRuntimeOptions,
  next: TerminalRuntimeOptions,
): boolean {
  const typographyChanged =
    next.typography.fontFamily !== previous.typography.fontFamily ||
    next.typography.fontSize !== previous.typography.fontSize
  if (typographyChanged) pane?.setTypography(next.typography)
  if (!terminalColorThemeEquals(next.theme, previous.theme)) pane?.setTheme(next.theme)
  return typographyChanged
}
