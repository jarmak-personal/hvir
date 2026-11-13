import { createGhosttyTerminalPane } from './ghostty-terminal-pane'
import { createNativeTerminalPane } from './native-terminal-pane'
import type { TerminalRuntimePane } from './terminal-pane'
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

export async function createTerminalRuntimePane(
  options: TerminalPaneFactoryOptions,
): Promise<TerminalRuntimePane> {
  if ((await window.hvir.invoke('native-terminal:enabled', {})) === true)
    return createNativeTerminalPane()
  return createGhosttyTerminalPane(options.theme, options.typography, {
    cursorDefaults: options.cursorDefaults,
    ligatures: options.ligatures,
    modifiedKeyProtocol: options.modifiedKeyProtocol,
    metaEnterAliasesControl: options.metaEnterAliasesControl,
    composerSubmitMode: options.composerSubmitMode,
  })
}
