import type { HostPath, ProjectState, RegisteredProjectState } from '../shared'

export interface WorkspaceRemovalRegistryPort {
  state(): ProjectState
  projectById(projectId: string): RegisteredProjectState | undefined
  dismissWorkspace(projectId: string, workspaceId: string): Promise<ProjectState>
}

export interface WorkspaceRemovalCleanupPort {
  forgetWorkspaceSessions(root: HostPath): Promise<void>
  revokeWorkspace(root: HostPath): Promise<void>
  closeWorkspaceWebPanes(root: HostPath): Promise<void>
  releaseHtmlPreviews(root: HostPath): void
}

export interface WorkspaceRemovalPort {
  removeMissingWorkspace(projectId: string, workspaceId: string): Promise<ProjectState>
}

/** Owns the shared resource and catalog lifecycle for a definitively missing workspace. */
export class WorkspaceRemovalCoordinator implements WorkspaceRemovalPort {
  constructor(
    private readonly registry: WorkspaceRemovalRegistryPort,
    private readonly cleanup: WorkspaceRemovalCleanupPort,
  ) {}

  async removeMissingWorkspace(
    projectId: string,
    workspaceId: string,
  ): Promise<ProjectState> {
    const project = this.registry.projectById(projectId)
    if (!project) throw new Error('Unknown project')
    const workspace = project.workspaces.find((candidate) => candidate.id === workspaceId)
    if (!workspace) return this.registry.state()
    if (!workspace.missing) throw new Error('Only removed worktrees can be dismissed')

    await this.cleanup.forgetWorkspaceSessions(workspace.root)
    const state = await this.registry.dismissWorkspace(projectId, workspaceId)
    await Promise.all([
      this.cleanup.revokeWorkspace(workspace.root),
      this.cleanup.closeWorkspaceWebPanes(workspace.root),
    ])
    this.cleanup.releaseHtmlPreviews(workspace.root)
    return state
  }
}
