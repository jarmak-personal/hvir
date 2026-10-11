import { homedir } from 'node:os'
import { join } from 'node:path'
import { BrowserWindow, dialog, type OpenDialogOptions } from 'electron'
import type { RendererOwner } from '../renderer-resource-scopes'
import type { ExtensionConnectionDialog } from './connector-connection'

export interface ConnectionDialogPort {
  choose(
    owner: RendererOwner,
    options: OpenDialogOptions,
  ): Promise<{ canceled: boolean; filePaths: string[] }>
}
function windowFor(owner: RendererOwner): BrowserWindow {
  const window = BrowserWindow.getAllWindows().find(
    (entry) => entry.webContents.id === owner.id,
  )
  if (!window || window.isDestroyed())
    throw new Error('Program connection window is unavailable')
  return window
}

/** Environment locations are metadata candidates, never executable discovery commands. */
export function createElectronConnectorConnection(
  port: ConnectionDialogPort = {
    choose: (owner, options) => dialog.showOpenDialog(windowFor(owner), options),
  },
  folders: readonly string[] = [
    ...(process.env['PATH'] ?? '').split(':', 24),
    join(homedir(), '.local/bin'),
    join(homedir(), 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ],
): ExtensionConnectionDialog {
  return {
    folders,
    async choose(owner, program, candidates) {
      const result = await port.choose(owner, {
        title: candidates.length
          ? `Choose which installed ${program} to connect`
          : `Locate installed ${program}`,
        buttonLabel: 'Use program',
        properties: ['openFile'],
        ...(candidates[0] ? { defaultPath: candidates[0] } : {}),
      })
      if (result.canceled) return undefined
      const selected = result.filePaths[0]
      if (
        result.filePaths.length !== 1 ||
        !selected?.startsWith('/') ||
        selected.includes('\0')
      )
        throw new Error('Choose one installed local executable file')
      return selected
    },
  }
}
