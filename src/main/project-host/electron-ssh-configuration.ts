import { dialog } from 'electron'
import { userInfo } from 'node:os'

import { localPath } from '../../shared/host-path'
import type { ProjectHostCatalog } from './project-host-catalog'
import type { SshConfigurationPort } from './ssh-configuration-port'

/** Native identity picker and local-account defaults around the catalog-owned capability. */
export function createElectronSshConfiguration(
  catalog: Pick<ProjectHostCatalog, 'refreshHosts' | 'addSshHost'>,
): SshConfigurationPort {
  return {
    defaults: () => ({ username: userInfo().username, port: 22 }),
    refreshHosts: () => catalog.refreshHosts(),
    addSshHost: (request, assertActive) => catalog.addSshHost(request, assertActive),
    async pickIdentity(assertActive) {
      assertActive()
      const result = await dialog.showOpenDialog({
        title: 'Choose SSH identity file',
        buttonLabel: 'Use identity file',
        properties: ['openFile', 'showHiddenFiles'],
      })
      assertActive()
      return result.canceled || !result.filePaths[0]
        ? undefined
        : localPath(result.filePaths[0])
    },
  }
}
