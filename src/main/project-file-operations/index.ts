import { hostPathEquals, type HostPath } from '../../shared'
import type { ProjectRegistry } from '../project-registry'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import {
  ProjectFileOperationCoordinator,
  type ProjectFileWorkspaceAuthority,
} from './project-file-operation-coordinator'

export * from './project-file-operation-coordinator'

export function createProjectFileOperationCoordinator(
  projects: Pick<ProjectRegistry, 'state' | 'hostById'>,
  resources: RendererResourceScopes,
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
    const host = projects.hostById(root.hostId)
    return host
      ? {
          projectId: match.project.id,
          workspaceId: match.workspace.id,
          root: match.workspace.root,
          host,
        }
      : undefined
  }
  return new ProjectFileOperationCoordinator({
    resolveWorkspace,
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
