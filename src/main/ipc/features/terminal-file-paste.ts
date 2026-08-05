import type { ElectronClipboardFilePaste } from '../../terminal/electron-clipboard-file-paste'
import type { IpcRegistrar } from '../authority-router'

type TerminalFileClipboard = Pick<ElectronClipboardFilePaste, 'read'>

export function registerTerminalFilePasteIpc(
  ipc: IpcRegistrar,
  terminalFileClipboard: TerminalFileClipboard,
): void {
  ipc.handle('terminal:resolve-file-clipboard', (_request, context) => {
    context.owner()
    return terminalFileClipboard.read()
  })
}
