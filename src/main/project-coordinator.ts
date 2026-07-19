import type {
  BrowseHostResponse,
  ConnectedHost,
  HostPath,
  ProjectHostOption,
  ProjectState,
  RegisteredProjectState,
} from '../shared'
import type { ProjectWatchTarget } from './project-watch'

export interface ProjectRegistryPort {
  readonly active: ProjectWatchTarget & { readonly workspaceId: string }
  state(): ProjectState
  projectById(projectId: string): RegisteredProjectState | undefined
  connectHost(hostId: string): Promise<ConnectedHost>
  disconnectHost(hostId: string): Promise<ProjectHostOption>
  browseHost(hostId: string, path: string): Promise<BrowseHostResponse>
  open(hostId: string, path: string): Promise<ProjectState>
  activate(projectId: string, workspaceId: string): Promise<ProjectState>
  closeProject(projectId: string): Promise<ProjectState>
  dismissWorkspace(projectId: string, workspaceId: string): Promise<ProjectState>
}

export interface ProjectWorkspacePort {
  serialize<T>(operation: () => Promise<T>): Promise<T>
  refresh(projectId: string): Promise<ProjectState>
  replaceWatch(target?: ProjectWatchTarget): Promise<void>
  invalidateProject(projectId: string): void
  settleProject(projectId: string): Promise<void>
}

export interface ProjectCleanupPort {
  revokeWorkspace(root: HostPath): Promise<void>
  closeWorkspace(root: HostPath): Promise<void>
  forgetWorkspaceSessions(root: HostPath): Promise<void>
}

export interface ProjectCoordinatorOptions {
  readonly registry: ProjectRegistryPort
  readonly workspaces: ProjectWorkspacePort
  readonly cleanup: ProjectCleanupPort
  readonly onError?: (message: string, error: unknown) => void
}

interface Transition {
  readonly generation: number
  readonly projects: readonly string[]
}

/** Coordinates project transitions while ProjectRegistry remains the state authority. */
export class ProjectCoordinator {
  private transitionGeneration = 0

  constructor(private readonly options: ProjectCoordinatorOptions) {}

  connectHost(hostId: string): Promise<ConnectedHost> {
    const transition = this.beginTransition()
    return this.options.workspaces.serialize(async () => {
      this.assertCurrent(transition)
      await this.settleTransition(transition)
      this.assertCurrent(transition)
      const connected = await this.options.registry.connectHost(hostId)
      this.assertCurrent(transition)
      if (this.options.registry.active.host.hostId === hostId) {
        await this.options.workspaces.replaceWatch(this.options.registry.active)
      }
      this.assertCurrent(transition)
      for (const project of this.options.registry.state().projects) {
        if (project.registeredRoot.hostId !== hostId) continue
        void this.options.workspaces
          .refresh(project.id)
          .catch((error) =>
            this.report(
              `[workspace] refresh after connect failed for ${project.id}`,
              error,
            ),
          )
      }
      return connected
    })
  }

  disconnectHost(hostId: string): Promise<ProjectHostOption> {
    const transition = this.beginTransition()
    return this.options.workspaces.serialize(async () => {
      this.assertCurrent(transition)
      await this.settleTransition(transition)
      this.assertCurrent(transition)
      const activeHost = this.options.registry.active.host.hostId === hostId
      const roots = this.options.registry
        .state()
        .projects.filter((project) => project.registeredRoot.hostId === hostId)
        .flatMap((project) => project.workspaces.map((workspace) => workspace.root))
      if (activeHost) await this.options.workspaces.replaceWatch()
      try {
        await Promise.all(roots.map((root) => this.options.cleanup.revokeWorkspace(root)))
        this.assertCurrent(transition)
        const disconnected = await this.options.registry.disconnectHost(hostId)
        this.assertCurrent(transition)
        return disconnected
      } finally {
        if (
          activeHost &&
          this.isCurrent(transition) &&
          this.options.registry.active.host.connectionState === 'connected'
        ) {
          await this.options.workspaces.replaceWatch(this.options.registry.active)
        }
      }
    })
  }

  async browseHost(hostId: string, path: string): Promise<BrowseHostResponse> {
    const generation = this.transitionGeneration
    const result = await this.options.registry.browseHost(hostId, path)
    if (generation !== this.transitionGeneration) throw staleTransitionError()
    return result
  }

  openProject(hostId: string, path: string): Promise<ProjectState> {
    const transition = this.beginTransition()
    return this.options.workspaces.serialize(async () => {
      this.assertCurrent(transition)
      await this.settleTransition(transition)
      this.assertCurrent(transition)
      await this.options.registry.open(hostId, path)
      this.assertCurrent(transition)
      await this.options.workspaces.replaceWatch()
      const projectId = this.options.registry.active.projectId
      this.options.workspaces.invalidateProject(projectId)
      await this.options.workspaces.settleProject(projectId)
      const state = await this.options.workspaces.refresh(projectId).catch((error) => {
        this.report('[workspace] discovery after registration failed', error)
        return this.options.registry.state()
      })
      this.assertCurrent(transition)
      await this.options.workspaces.replaceWatch(this.options.registry.active)
      return state
    })
  }

  switchWorkspace(projectId: string, workspaceId: string): Promise<ProjectState> {
    const transition = this.beginTransition()
    return this.options.workspaces.serialize(async () => {
      this.assertCurrent(transition)
      await this.settleTransition(transition)
      this.assertCurrent(transition)
      const state = await this.options.registry.activate(projectId, workspaceId)
      this.assertCurrent(transition)
      await this.options.workspaces.replaceWatch(this.options.registry.active)
      return state
    })
  }

  closeProject(projectId: string): Promise<ProjectState> {
    const transition = this.beginTransition()
    return this.options.workspaces.serialize(async () => {
      this.assertCurrent(transition)
      await this.settleTransition(transition)
      this.assertCurrent(transition)
      const wasActive = this.options.registry.active.projectId === projectId
      const roots =
        this.options.registry
          .projectById(projectId)
          ?.workspaces.map(({ root }) => root) ?? []
      if (wasActive) await this.options.workspaces.replaceWatch()
      try {
        const state = await this.options.registry.closeProject(projectId)
        await Promise.all(
          roots.flatMap((root) => [
            this.options.cleanup.revokeWorkspace(root),
            this.options.cleanup.closeWorkspace(root),
          ]),
        )
        this.assertCurrent(transition)
        return state
      } finally {
        if (
          wasActive &&
          this.isCurrent(transition) &&
          this.options.registry.active.host.connectionState === 'connected'
        ) {
          await this.options.workspaces.replaceWatch(this.options.registry.active)
        }
      }
    })
  }

  dismissWorkspace(projectId: string, workspaceId: string): Promise<ProjectState> {
    const transition = this.beginTransition()
    return this.options.workspaces.serialize(async () => {
      this.assertCurrent(transition)
      await this.settleTransition(transition)
      this.assertCurrent(transition)
      const workspace = this.options.registry
        .projectById(projectId)
        ?.workspaces.find((candidate) => candidate.id === workspaceId)
      const wasActive =
        this.options.registry.active.projectId === projectId &&
        this.options.registry.active.workspaceId === workspaceId
      if (workspace?.missing) {
        await this.options.cleanup.forgetWorkspaceSessions(workspace.root)
      }
      const state = await this.options.registry.dismissWorkspace(projectId, workspaceId)
      if (workspace) {
        await Promise.all([
          this.options.cleanup.revokeWorkspace(workspace.root),
          this.options.cleanup.closeWorkspace(workspace.root),
        ])
      }
      this.assertCurrent(transition)
      if (wasActive) {
        await this.options.workspaces.replaceWatch(this.options.registry.active)
      }
      return state
    })
  }

  private beginTransition(): Transition {
    const transition = {
      generation: ++this.transitionGeneration,
      projects: this.options.registry.state().projects.map((project) => project.id),
    }
    for (const projectId of transition.projects) {
      this.options.workspaces.invalidateProject(projectId)
    }
    return transition
  }

  private settleTransition(transition: Transition): Promise<void> {
    return Promise.all(
      transition.projects.map((projectId) =>
        this.options.workspaces.settleProject(projectId),
      ),
    ).then(() => undefined)
  }

  private isCurrent(transition: Transition): boolean {
    return transition.generation === this.transitionGeneration
  }

  private assertCurrent(transition: Transition): void {
    if (!this.isCurrent(transition)) throw staleTransitionError()
  }

  private report(message: string, error: unknown): void {
    if (this.options.onError) this.options.onError(message, error)
    else console.error(message, error)
  }
}

function staleTransitionError(): Error {
  return new Error('Project transition was superseded by a newer request')
}
