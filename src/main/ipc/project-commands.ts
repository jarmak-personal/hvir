import type { GitMutationCoordinator } from '../git/mutation-coordinator'
import type { ProjectCoordinator } from '../project-coordinator'
import type { RendererOwner } from '../renderer-resource-scopes'
import type { WorkspaceCoordinator } from '../workspace-coordinator'
import type { IpcDeps } from './deps'

type ProjectCommandDeps = Pick<
  IpcDeps,
  | 'connectHost'
  | 'disconnectHost'
  | 'browseHost'
  | 'openProject'
  | 'switchWorkspace'
  | 'refreshProject'
  | 'updateWatchInterests'
  | 'closeProject'
  | 'pruneWorktrees'
  | 'dismissWorkspace'
  | 'planWorkspaceClose'
  | 'closeWorkspace'
  | 'reopenWorkspace'
  | 'acknowledgeWorkspace'
  | 'switchGitBranch'
  | 'fetchGit'
  | 'pullGit'
>

/** Adapts project coordinators to IPC commands without putting policy in the root. */
export function createProjectCommands({
  projects,
  workspaces,
  git,
  withSshPresentation,
}: {
  readonly projects: ProjectCoordinator
  readonly workspaces: WorkspaceCoordinator
  readonly git: GitMutationCoordinator
  readonly withSshPresentation: <T>(owner: RendererOwner, operation: () => T) => T
}): ProjectCommandDeps {
  return {
    connectHost: (hostId, owner) =>
      withSshPresentation(owner, () => projects.connectHost(hostId)),
    disconnectHost: (hostId) => projects.disconnectHost(hostId),
    browseHost: (hostId, path, owner) =>
      withSshPresentation(owner, () => projects.browseHost(hostId, path)),
    openProject: (hostId, path, owner) =>
      withSshPresentation(owner, () => projects.openProject(hostId, path)),
    switchWorkspace: (projectId, workspaceId) =>
      projects.switchWorkspace(projectId, workspaceId),
    refreshProject: (projectId) => workspaces.refresh(projectId),
    updateWatchInterests: (paths) => workspaces.updateWatchInterests(paths),
    closeProject: (projectId) => projects.closeProject(projectId),
    pruneWorktrees: (projectId) => git.pruneWorktrees(projectId),
    dismissWorkspace: (projectId, workspaceId) =>
      projects.dismissWorkspace(projectId, workspaceId),
    planWorkspaceClose: (projectId, workspaceId) =>
      Promise.resolve(projects.planWorkspaceClose(projectId, workspaceId)),
    closeWorkspace: (projectId, workspaceId, expectedTerminalCount, terminateTerminals) =>
      projects.closeWorkspace(
        projectId,
        workspaceId,
        expectedTerminalCount,
        terminateTerminals,
      ),
    reopenWorkspace: (projectId, workspaceId) =>
      projects.reopenWorkspace(projectId, workspaceId),
    acknowledgeWorkspace: (projectId, workspaceId) =>
      projects.acknowledgeWorkspace(projectId, workspaceId),
    switchGitBranch: (root, branch) => git.switchBranch(root, branch),
    fetchGit: (root) => git.fetch(root),
    pullGit: (root) => git.pull(root),
  }
}
