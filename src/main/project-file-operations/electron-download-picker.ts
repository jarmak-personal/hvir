import { dialog } from 'electron'

export interface DownloadDirectoryPickerPort {
  pick(): Promise<string | undefined>
}

/** The native directory choice is approval to begin this download. */
export function createElectronDownloadDirectoryPicker(
  nativeDialog: Pick<typeof dialog, 'showOpenDialog'> = dialog,
): DownloadDirectoryPickerPort {
  return {
    async pick() {
      const result = await nativeDialog.showOpenDialog({
        title: 'Download to Folder',
        buttonLabel: 'Download Here',
        properties: ['openDirectory'],
      })
      return result.canceled || result.filePaths.length !== 1
        ? undefined
        : result.filePaths[0]
    },
  }
}
