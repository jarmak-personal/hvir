import { BrowserWindow, dialog, type OpenDialogOptions } from 'electron'
import { basenameHostPath, localPath, LOCAL_HOST_ID } from '../../shared/host-path'
import { SETUP_LIMITS } from '../../shared/extensions/setup-proposal'
import type { ProjectHost } from '../project-host/project-host'
import type { RendererOwner } from '../renderer-resource-scopes'
import type { ExtensionSetupFilePicker } from './extension-setup'

export interface SetupDialogPort {
  choose(
    owner: RendererOwner,
    options: OpenDialogOptions,
  ): Promise<{ canceled: boolean; filePaths: string[] }>
}
export function createElectronExtensionSetup(
  host: Pick<ProjectHost, 'hostId' | 'readTextFilePrefix'>,
  port: SetupDialogPort = {
    choose: (owner, options) => {
      const window = BrowserWindow.getAllWindows().find(
        (entry) => entry.webContents.id === owner.id,
      )
      if (!window || window.isDestroyed()) throw new Error('Setup window is unavailable')
      return dialog.showOpenDialog(window, options)
    },
  },
): ExtensionSetupFilePicker {
  return {
    async choose(owner, current) {
      current()
      const chosen = await port.choose(owner, {
        title: 'Review extension setup',
        buttonLabel: 'Review setup',
        properties: ['openFile'],
        filters: [{ name: 'Setup JSON', extensions: ['json'] }],
      })
      current()
      if (chosen.canceled) return undefined
      const path = chosen.filePaths[0]
      if (chosen.filePaths.length !== 1 || !path?.startsWith('/') || path.includes('\0'))
        throw new Error('Choose one local JSON setup file')
      return localPath(path)
    },
    async read(path, current) {
      current()
      if (path.hostId !== LOCAL_HOST_ID || host.hostId !== LOCAL_HOST_ID)
        throw new Error('Setup files are selected on this machine')
      const snapshot = await host.readTextFilePrefix(path, SETUP_LIMITS.bytes)
      current()
      if (!snapshot.complete || snapshot.validUtf8 === false)
        throw new Error('Choose a UTF-8 JSON setup file no larger than 384 KiB')
      return { name: basenameHostPath(path), text: snapshot.content }
    },
  }
}
