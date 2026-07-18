import {
  hostPathEquals,
  type HostPath,
  type ProjectState,
  type RegisteredProjectState,
  type WorktreeDiscovery,
} from '../../shared'
import type { GitMutationGrant, GitMutationGrantRequest } from './mutation-authorization'
import type { ProjectWatchTarget } from '../project-watch'

export interface GitMutationRegistryPort {
  readonly active: ProjectWatchTarget & {
    readonly workspaceId: string
  }
  state(): ProjectState
  projectById(projectId: string): RegisteredProjectState | undefined
  reconcileWorktrees(
    projectId: string,
    discovery: WorktreeDiscovery,
  ): Promise<ProjectState>
  dismissWorkspace(projectId: string, workspaceId: string): Promise<ProjectState>
}

export interface GitMutationWorkerPort {
  pruneWorktrees(root: HostPath): Promise<WorktreeDiscovery>
  switchBranch(
    root: HostPath,
    branch: string,
    relatedWorktreeRoots: readonly HostPath[],
  ): Promise<void>
  fetch(root: HostPath): Promise<void>
  pull(root: HostPath, relatedWorktreeRoots: readonly HostPath[]): Promise<void>
}

export interface GitMutationWorkspacePort {
  serialize<T>(operation: () => Promise<T>): Promise<T>
  refresh(projectId: string): Promise<ProjectState>
  scheduleRefresh(projectId: string): void
  coalesceProjectOperation(
    projectId: string,
    operation: () => Promise<ProjectState>,
  ): Promise<ProjectState>
  invalidateProject(projectId: string): void
  settleProject(projectId: string): Promise<void>
  stopWatch(): Promise<void>
  replaceWatch(target?: ProjectWatchTarget): Promise<void>
}

export interface GitMutationCleanupPort {
  forgetWorkspaceSessions(root: HostPath): Promise<void>
  revokeWorkspace(root: HostPath): Promise<void>
  closeWorkspace(root: HostPath): Promise<void>
  clearHtmlPreviews(): void
}

export interface GitMutationCoordinatorOptions {
  readonly registry: GitMutationRegistryPort
  readonly worker: GitMutationWorkerPort
  readonly workspaces: GitMutationWorkspacePort
  readonly authorizations: {
    grant(request: GitMutationGrantRequest): GitMutationGrant
  }
  readonly cleanup: GitMutationCleanupPort
  readonly onError?: (message: string, error: unknown) => void
}

/** Coordinates the complete lifecycle of the bounded Git mutations exposed by hvir. */
export class GitMutationCoordinator {
  constructor(private readonly options: GitMutationCoordinatorOptions) {}

  pruneWorktrees(projectId: string): Promise<ProjectState> {
    const { workspaces } = this.options
    workspaces.invalidateProject(projectId)
    const settled = workspaces.settleProject(projectId)
    return workspaces.coalesceProjectOperation(projectId, async () => {
      await settled
      return this.performPrune(projectId)
    })
  }

  switchBranch(root: HostPath, branch: string): Promise<ProjectState> {
    return this.options.workspaces.serialize(async () => {
      const { registry, workspaces } = this.options
      this.assertActive(
        root,
        'Branch switch belongs to another workspace',
        'switching branches',
      )
      if (
        typeof branch !== 'string' ||
        branch.length === 0 ||
        branch.length > 1_024 ||
        branch.includes('\0')
      ) {
        throw new Error('Invalid branch target')
      }

      const projectId = registry.active.projectId
      workspaces.invalidateProject(projectId)
      await workspaces.settleProject(projectId)
      const grant = this.options.authorizations.grant({
        kind: 'branch-switch',
        projectId,
        root,
        target: branch,
      })
      try {
        await this.options.worker.switchBranch(
          root,
          branch,
          this.relatedWorktreeRoots(projectId),
        )
      } finally {
        grant.revoke()
      }
      return this.refreshAfterMutation(projectId, 'branch switch')
    })
  }

  fetch(root: HostPath): Promise<ProjectState> {
    return this.options.workspaces.serialize(async () => {
      const { registry } = this.options
      this.assertActive(root, 'Git fetching belongs to another workspace', 'fetching')
      const grant = this.options.authorizations.grant({
        kind: 'fetch',
        projectId: registry.active.projectId,
        root,
      })
      try {
        await this.options.worker.fetch(root)
      } finally {
        grant.revoke()
      }
      return registry.state()
    })
  }

  pull(root: HostPath): Promise<ProjectState> {
    return this.options.workspaces.serialize(async () => {
      const { registry, workspaces } = this.options
      this.assertActive(root, 'Git pulling belongs to another workspace', 'pulling')
      const projectId = registry.active.projectId
      workspaces.invalidateProject(projectId)
      await workspaces.settleProject(projectId)
      const grant = this.options.authorizations.grant({
        kind: 'pull',
        projectId,
        root,
      })
      try {
        await this.options.worker.pull(root, this.relatedWorktreeRoots(projectId))
      } finally {
        grant.revoke()
      }
      return this.refreshAfterMutation(projectId, 'pull')
    })
  }

  private async performPrune(projectId: string): Promise<ProjectState> {
    const { registry, cleanup } = this.options
    const project = registry.projectById(projectId)
    if (!project) throw new Error('Unknown project')
    if (project.connectionState !== 'connected') {
      throw new Error('Connect to the project host before pruning worktrees')
    }
    const targets = project.workspaces.filter(
      (workspace) => workspace.missing && workspace.prunableReason !== undefined,
    )
    if (targets.length === 0) throw new Error('Git reports no prunable worktrees')
    const prunesActiveWorkspace = targets.some(
      (workspace) => workspace.id === registry.active.workspaceId,
    )

    const grant = this.options.authorizations.grant({
      kind: 'worktree-prune',
      projectId,
      root: project.registeredRoot,
    })
    let discovery: WorktreeDiscovery
    try {
      discovery = await this.options.worker.pruneWorktrees(project.registeredRoot)
    } finally {
      grant.revoke()
    }

    await registry.reconcileWorktrees(projectId, discovery)
    for (const target of targets) {
      if (
        discovery.worktrees.some((worktree) => hostPathEquals(worktree.root, target.root))
      ) {
        continue
      }
      await cleanup.forgetWorkspaceSessions(target.root)
      await registry.dismissWorkspace(projectId, target.id)
      await Promise.all([
        cleanup.revokeWorkspace(target.root),
        cleanup.closeWorkspace(target.root),
      ])
    }
    if (prunesActiveWorkspace) {
      await this.options.workspaces.stopWatch()
      cleanup.clearHtmlPreviews()
      await this.options.workspaces.replaceWatch(registry.active)
    }
    return registry.state()
  }

  private assertActive(
    root: HostPath,
    wrongWorkspaceMessage: string,
    disconnectedOperation: string,
  ): void {
    const { active } = this.options.registry
    if (!hostPathEquals(root, active.root)) throw new Error(wrongWorkspaceMessage)
    if (active.host.connectionState !== 'connected') {
      throw new Error(`Reconnect before ${disconnectedOperation}`)
    }
  }

  private relatedWorktreeRoots(projectId: string): readonly HostPath[] {
    return (
      this.options.registry
        .projectById(projectId)
        ?.workspaces.filter((workspace) => !workspace.missing)
        .map((workspace) => workspace.root) ?? []
    )
  }

  private async refreshAfterMutation(
    projectId: string,
    operation: string,
  ): Promise<ProjectState> {
    try {
      return await this.options.workspaces.refresh(projectId)
    } catch (error) {
      this.report(`[git] workspace refresh after ${operation} failed`, error)
      this.options.workspaces.scheduleRefresh(projectId)
      return this.options.registry.state()
    }
  }

  private report(message: string, error: unknown): void {
    if (this.options.onError) this.options.onError(message, error)
    else console.error(message, error)
  }
}
