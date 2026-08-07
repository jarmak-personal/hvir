import { createGhosttyTerminalPane } from './ghostty-terminal-pane'
import type { TerminalPane } from './terminal-pane'
import type { TerminalRuntimeOptions } from './terminal-runtime-options'

type TerminalPaneFactoryOptions = Pick<
  TerminalRuntimeOptions,
  | 'composerSubmitMode'
  | 'metaEnterAliasesControl'
  | 'modifiedKeyProtocol'
  | 'theme'
  | 'typography'
  | 'cursorDefaults'
  | 'ligatures'
>

export function createTerminalRuntimePane(
  options: TerminalPaneFactoryOptions,
): Promise<TerminalPane> {
  return createGhosttyTerminalPane(options.theme, options.typography, {
    cursorDefaults: options.cursorDefaults,
    ligatures: options.ligatures,
    modifiedKeyProtocol: options.modifiedKeyProtocol,
    metaEnterAliasesControl: options.metaEnterAliasesControl,
    composerSubmitMode: options.composerSubmitMode,
  })
}
