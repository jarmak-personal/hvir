import { hostPathEquals, type HostPath } from '../../shared/host-path'
import type { ProjectState } from '../../shared/workspace-types'
import type { SkillagerDestination } from '../../shared/skillager-exposure'

/** Registration is independent of focus; closed/missing destinations grant no operation. */
export function skillagerDestinationAvailable(
  state: ProjectState,
  destination: SkillagerDestination,
): boolean {
  const project = state.projects.find((item) => item.id === destination.projectId)
  const workspace = project?.workspaces.find(
    (item) => item.id === destination.workspaceId,
  )
  return Boolean(
    project?.connectionState === 'connected' &&
    workspace &&
    !workspace.closed &&
    !workspace.missing &&
    hostPathEquals(workspace.root, destination.root),
  )
}

export function skillagerWorkspaceAvailable(
  state: ProjectState,
  root: HostPath,
): boolean {
  return state.projects.some((project) =>
    project.workspaces.some(
      (workspace) =>
        hostPathEquals(workspace.root, root) &&
        skillagerDestinationAvailable(state, {
          projectId: project.id,
          workspaceId: workspace.id,
          root,
        }),
    ),
  )
}
