import type { WorkspaceState } from '../../../shared'

/** Git is an optional workspace capability; plain directories stay file-first. */
export function workspaceGitEnabled(
  workspace: Pick<WorkspaceState, 'repository' | 'missing'> | undefined,
): boolean {
  return workspace?.repository === true && !workspace.missing
}
