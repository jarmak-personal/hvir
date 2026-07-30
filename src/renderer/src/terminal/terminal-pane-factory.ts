import { createGhosttyTerminalPane } from './ghostty-terminal-pane'
import type { TerminalPane } from './terminal-pane'
import type { TerminalRuntimeOptions } from './terminal-runtime-options'
import { baseTerminalTheme } from './terminal-runtime-presentation'

type TerminalPaneFactoryOptions = Pick<
  TerminalRuntimeOptions,
  'composerSubmitMode' | 'metaEnterAliasesControl' | 'modifiedKeyProtocol' | 'typography'
>

export function createTerminalRuntimePane(
  options: TerminalPaneFactoryOptions,
): Promise<TerminalPane> {
  return createGhosttyTerminalPane(baseTerminalTheme(), options.typography, {
    modifiedKeyProtocol: options.modifiedKeyProtocol,
    metaEnterAliasesControl: options.metaEnterAliasesControl,
    composerSubmitMode: options.composerSubmitMode,
  })
}
