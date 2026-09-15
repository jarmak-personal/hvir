import { BrowserWindow, dialog as electronDialog, webContents } from 'electron'
import { localPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import type { RendererOwner } from '../renderer-resource-scopes'
import { SkillagerError } from './skillager-port'
import type { SkillagerFolderPicker } from './skillager-setup-port'

interface DirectoryDialog {
  showOpenDialog(
    parent: BrowserWindow,
    options: {
      title: string
      buttonLabel: string
      defaultPath: string
      properties: ['openDirectory']
    },
  ): Promise<{ canceled: boolean; filePaths: string[] }>
}
function ownerWindow(owner: RendererOwner): BrowserWindow | undefined {
  const contents = webContents.fromId(owner.id)
  return contents ? (BrowserWindow.fromWebContents(contents) ?? undefined) : undefined
}

/** One parented native selection. Revocation settles callers without queuing OS dialogs. */
export function createSkillagerFolderPicker(
  host: Pick<ProjectHost, 'realpath'>,
  dialog: DirectoryDialog = electronDialog,
  windowForOwner: (owner: RendererOwner) => BrowserWindow | undefined = ownerWindow,
): SkillagerFolderPicker {
  let pending = false
  return {
    choose(owner, current, signal) {
      if (signal.aborted)
        return Promise.reject(
          new SkillagerError('cancelled', 'Library folder selection cancelled.'),
        )
      if (pending)
        return Promise.reject(
          new SkillagerError(
            'busy',
            'Dismiss the open folder chooser before choosing another library folder.',
          ),
        )
      const parent = windowForOwner(owner)
      if (!parent)
        return Promise.reject(
          new SkillagerError('cancelled', 'The owning window is unavailable.'),
        )
      pending = true
      return new Promise((resolve, reject) => {
        const cancel = () =>
          reject(new SkillagerError('cancelled', 'Library folder selection cancelled.'))
        signal.addEventListener('abort', cancel, { once: true })
        void (async () => {
          try {
            const result = await dialog.showOpenDialog(parent, {
              title: 'Choose your personal Skillager library folder',
              buttonLabel: 'Choose library folder',
              defaultPath: current.path,
              properties: ['openDirectory'],
            })
            if (signal.aborted) return
            const path =
              result.canceled || result.filePaths.length !== 1
                ? undefined
                : await host.realpath(localPath(result.filePaths[0]!))
            if (!signal.aborted) resolve(path)
          } catch {
            if (!signal.aborted)
              reject(
                new SkillagerError(
                  'unavailable',
                  'Could not select the local library folder.',
                ),
              )
          } finally {
            pending = false
            signal.removeEventListener('abort', cancel)
          }
        })()
      })
    },
  }
}
