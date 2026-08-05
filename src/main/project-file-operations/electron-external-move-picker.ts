import type { ExternalMovePickerPolicy, ExternalMovePickerSelection } from '../../shared'
import { dialog as electronDialog } from 'electron'

interface ElectronOpenDialogPort {
  showOpenDialog(options: {
    readonly title: string
    readonly buttonLabel: string
    readonly properties: (
      'openFile' | 'openDirectory' | 'multiSelections' | 'noResolveAliases'
    )[]
  }): Promise<{ readonly canceled: boolean; readonly filePaths: readonly string[] }>
}

export interface ExternalMovePickerPort {
  readonly policy: ExternalMovePickerPolicy
  pick(selection: ExternalMovePickerSelection): Promise<readonly string[] | undefined>
}

/** Electron edge for one user-initiated, application-host selection. */
export function createElectronExternalMovePicker(
  dialog: ElectronOpenDialogPort = electronDialog,
  platform: NodeJS.Platform = process.platform,
): ExternalMovePickerPort {
  const combined = platform === 'darwin'
  return {
    policy: combined
      ? {
          kind: 'mixed-multiple',
          limitation:
            'This platform can select multiple files and folders together in one native dialog.',
        }
      : {
          kind: 'files-or-single-directory',
          limitation:
            'This platform selects multiple files or one folder at a time; files and folders cannot be mixed in one native dialog.',
        },
    async pick(selection) {
      if (combined ? selection !== 'mixed' : selection === 'mixed') {
        throw new Error('The requested native selection mode is unavailable')
      }
      const properties: Array<
        'openFile' | 'openDirectory' | 'multiSelections' | 'noResolveAliases'
      > =
        selection === 'mixed'
          ? ['openFile', 'openDirectory', 'multiSelections', 'noResolveAliases']
          : selection === 'files'
            ? ['openFile', 'multiSelections']
            : ['openDirectory']
      const result = await dialog.showOpenDialog({
        title: 'Select external items to move into hvir',
        buttonLabel: 'Select for Move',
        properties,
      })
      return result.canceled ? undefined : [...result.filePaths]
    },
  }
}
