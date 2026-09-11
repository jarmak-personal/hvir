import { hostPathEquals } from '../../shared/host-path'
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
    destination.root.hostId === 'local' &&
    hostPathEquals(workspace.root, destination.root),
  )
}
