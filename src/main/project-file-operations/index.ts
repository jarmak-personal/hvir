import {
  hostPathEquals,
  LOCAL_HOST_ID,
  type HostPath,
  type ProjectState,
} from '../../shared'
import type { ProjectHost } from '../project-host/project-host'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import {
  ProjectFileOperationCoordinator,
  type ProjectFileWorkspaceAuthority,
} from './project-file-operation-coordinator'
import { ElectronClipboardFileSource } from './electron-clipboard-files'
import type { ExternalMovePickerPort } from './electron-external-move-picker'
import { createElectronExternalMovePicker } from './electron-external-move-picker'
import { ExternalFileGrantRegistry } from './external-file-grants'

export * from './project-file-operation-coordinator'
export * from './clipboard-file-list'
export * from './external-file-grants'
export * from './electron-external-move-picker'
export * from './external-file-move'
export * from './verified-project-copy'
export * from './project-entry-organization'
export * from './project-entry-removal'
export * from './delete-project-entry'
export * from './staging-cleanup'

export function createProjectFileOperationCoordinator(
  projects: { state(): ProjectState },
  hosts: { hostById(hostId: string): ProjectHost | undefined },
  resources: RendererResourceScopes,
  externalMovePicker?: ExternalMovePickerPort,
): ProjectFileOperationCoordinator {
  const resolveWorkspace = (
    root: HostPath,
  ): ProjectFileWorkspaceAuthority | undefined => {
    const matches = projects
      .state()
      .projects.flatMap((project) =>
        project.workspaces
          .filter(
            (workspace) =>
              !workspace.closed &&
              !workspace.missing &&
              hostPathEquals(workspace.root, root),
          )
          .map((workspace) => ({ project, workspace })),
      )
    if (matches.length !== 1) return undefined
    const match = matches[0]!
    const host = hosts.hostById(root.hostId)
    return host
      ? {
          projectId: match.project.id,
          workspaceId: match.workspace.id,
          root: match.workspace.root,
          host,
        }
      : undefined
  }
  const sourceHost = hosts.hostById(LOCAL_HOST_ID)
  if (!sourceHost?.fileTransfer) {
    throw new Error('The application host cannot provide external file streaming')
  }
  const externalFiles = new ExternalFileGrantRegistry({
    sourceHost,
    registeredRoots: () =>
      projects
        .state()
        .projects.flatMap((project) => [
          project.registeredRoot,
          ...project.workspaces
            .filter((workspace) => !workspace.missing)
            .map((workspace) => workspace.root),
        ]),
    resources: {
      isRendererCurrent: (owner) => resources.isCurrent(owner),
      registerGrant: (owner, _grantId, revoke) =>
        resources.register(
          owner,
          { lifetime: 'renderer', type: 'external-file-grant' },
          revoke,
        ),
    },
  })
  const clipboardFiles = new ElectronClipboardFileSource()
  return new ProjectFileOperationCoordinator({
    resolveWorkspace,
    externalFiles,
    externalMovePicker: externalMovePicker ?? createElectronExternalMovePicker(),
    readClipboardPaths: () => clipboardFiles.readPaths(),
    resources: {
      isRendererCurrent: (owner) => resources.isCurrent(owner),
      registerOperation: (owner, root, operationId, revoke) =>
        resources.register(
          owner,
          {
            lifetime: 'workspace',
            type: 'project-file-operation',
            root,
            id: operationId,
          },
          revoke,
        ),
    },
  })
}
