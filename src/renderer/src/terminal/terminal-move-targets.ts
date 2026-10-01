import type { WorkspaceState } from '../../../shared'

/** Both terminal entry points offer open, present workspaces beside the source. */
export function terminalMoveTargets(
  workspaces: readonly WorkspaceState[],
  sourceWorkspaceId: string,
): readonly WorkspaceState[] {
  return workspaces.filter(
    (target) => target.id !== sourceWorkspaceId && !target.missing && !target.closed,
  )
}
