import { basename, dirname } from 'node:path'
import {
  BrowserWindow,
  dialog,
  type OpenDialogOptions,
  type OpenDialogReturnValue,
} from 'electron'
import { localPath } from '../../shared/host-path'
import type { RendererOwner } from '../renderer-resource-scopes'

import type { ExtensionPackagePicker } from './package-addition'

/** Only the native dialog supplies a source. Linux selects folders through their manifest. */
export function createElectronPackagePicker(
  show: (
    owner: RendererOwner,
    options: OpenDialogOptions,
  ) => Promise<OpenDialogReturnValue> = (owner, options) => {
    const window = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.id === owner.id,
    )
    if (!window || window.isDestroyed())
      throw new Error('Extension picker window is unavailable')
    return dialog.showOpenDialog(window, options)
  },
  platform: NodeJS.Platform = process.platform,
): ExtensionPackagePicker {
  return {
    async pick(owner) {
      const mixed = platform === 'darwin'
      const result = await show(owner, {
        title: mixed
          ? 'Add extension ZIP or directory'
          : 'Add extension ZIP or hvir-extension.json',
        buttonLabel: 'Add extension',
        properties: mixed
          ? ['openFile', 'openDirectory', 'noResolveAliases']
          : ['openFile'],
        filters: [
          {
            name: mixed ? 'Extension packages' : 'Extension ZIP or package manifest',
            extensions: mixed ? ['zip'] : ['zip', 'json'],
          },
        ],
      })
      if (result.canceled) return undefined
      const path = result.filePaths[0]
      if (result.filePaths.length !== 1 || !path?.startsWith('/') || path.includes('\0'))
        throw new Error('Select one local extension ZIP or directory')
      if (path.toLowerCase().endsWith('.zip')) return localPath(path)
      if (!mixed && basename(path) !== 'hvir-extension.json')
        throw new Error(
          'Select a ZIP or the hvir-extension.json inside the extension directory',
        )
      return localPath(mixed ? path : dirname(path))
    },
  }
}
