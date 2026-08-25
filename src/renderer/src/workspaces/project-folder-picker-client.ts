import {
  unwrapOperation,
  type BrowseHostResponse,
  type HostPath,
  type ProjectFolderPickerLease,
} from '../../../shared'

export interface ProjectFolderPickerPort {
  start(hostId: string): Promise<ProjectFolderPickerLease>
  browse(pickerId: string, path: string): Promise<BrowseHostResponse>
  createDirectory(
    pickerId: string,
    destinationParent: HostPath,
    name: string,
  ): Promise<HostPath>
  close(pickerId: string): Promise<void>
}

export const projectFolderPickerClient: ProjectFolderPickerPort = {
  async start(hostId) {
    return unwrapOperation(
      await window.hvir.invoke('project:folder-picker-start', { hostId }),
    )
  },
  async browse(pickerId, path) {
    return unwrapOperation(
      await window.hvir.invoke('project:folder-picker-browse', { pickerId, path }),
    )
  },
  async createDirectory(pickerId, destinationParent, name) {
    return unwrapOperation(
      await window.hvir.invoke('project:folder-picker-create-directory', {
        pickerId,
        destinationParent,
        name,
      }),
    )
  },
  async close(pickerId) {
    unwrapOperation(await window.hvir.invoke('project:folder-picker-close', { pickerId }))
  },
}
