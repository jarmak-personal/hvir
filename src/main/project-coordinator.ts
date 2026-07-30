import {
  LOCAL_HOST_ID,
  type BrowseHostResponse,
  type ConnectedHost,
  type HostPath,
  type ProjectHostOption,
  type ProjectState,
  type RegisteredProjectState,
  type WorkspaceClosePlan,
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
  closeWorkspace(projectId: string, workspaceId: string): Promise<ProjectState>
  restoreWorkspaceAfterFailedClose(
    projectId: string,
    workspaceId: string,
  ): Promise<ProjectState>
  reopenWorkspace(projectId: string, workspaceId: string): Promise<ProjectState>
  dismissWorkspace(projectId: string, workspaceId: string): Promise<ProjectState>
  acknowledgeWorkspace(projectId: string, workspaceId: string): Promise<ProjectState>
}

export interface ProjectWorkspacePort {
  serialize<T>(operation: () => Promise<T>): Promise<T>
  refresh(projectId: string): Promise<ProjectState>
  replaceWatch(target?: ProjectWatchTarget): Promise<void>
  invalidateProject(projectId: string): void
  settleProject(projectId: string, obsoleteRefresh?: 'wait' | 'skip'): Promise<void>
}

export interface ProjectCleanupPort {
  revokeWorkspace(root: HostPath): Promise<void>
  closeWorkspaceWebPanes(root: HostPath): Promise<void>
  workspaceTerminalIds(root: HostPath): readonly string[]
  closeWorkspaceTerminals(root: HostPath): void
  forgetWorkspaceSessions(root: HostPath): Promise<void>
}

export interface ProjectHostControlDiagnostic {
  readonly operation: 'connect' | 'disconnect'
  readonly hostKind: 'local' | 'ssh'
}

export interface ProjectCoordinatorOptions {
  readonly registry: ProjectRegistryPort
  readonly workspaces: ProjectWorkspacePort
  readonly cleanup: ProjectCleanupPort
  readonly onError?: (message: string, error: unknown) => void
  readonly onHostControlDiagnostic?: (event: ProjectHostControlDiagnostic) => void
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
      const connected = await this.controlHost('connect', hostId, () =>
        this.options.registry.connectHost(hostId),
      )
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
        const disconnected = await this.controlHost('disconnect', hostId, () =>
          this.options.registry.disconnectHost(hostId),
        )
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
            this.options.cleanup.closeWorkspaceWebPanes(root),
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

  planWorkspaceClose(projectId: string, workspaceId: string): WorkspaceClosePlan {
    const workspace = this.closeableWorkspace(projectId, workspaceId)
    return {
      terminalCount: new Set(this.options.cleanup.workspaceTerminalIds(workspace.root))
        .size,
    }
  }

  closeWorkspace(
    projectId: string,
    workspaceId: string,
    expectedTerminalCount: number,
    terminateTerminals: boolean,
  ): Promise<ProjectState> {
    const transition = this.beginTransition()
    return this.options.workspaces.serialize(async () => {
      this.assertCurrent(transition)
      await this.settleTransition(transition)
      this.assertCurrent(transition)
      const workspace = this.closeableWorkspace(projectId, workspaceId)
      const terminalCount = new Set(
        this.options.cleanup.workspaceTerminalIds(workspace.root),
      ).size
      if (
        !Number.isSafeInteger(expectedTerminalCount) ||
        expectedTerminalCount < 0 ||
        terminalCount !== expectedTerminalCount
      ) {
        throw new Error('Workspace terminal count changed; review the close again')
      }
      if (terminalCount > 0 && terminateTerminals !== true) {
        throw new Error('Confirm terminal termination before closing this workspace')
      }
      const state = await this.options.registry.closeWorkspace(projectId, workspaceId)
      const cleanups = await Promise.allSettled([
        Promise.resolve().then(() =>
          this.options.cleanup.closeWorkspaceTerminals(workspace.root),
        ),
        this.options.cleanup.forgetWorkspaceSessions(workspace.root),
        this.options.cleanup.revokeWorkspace(workspace.root),
        this.options.cleanup.closeWorkspaceWebPanes(workspace.root),
      ])
      const failures: unknown[] = []
      for (const result of cleanups) {
        if (result.status === 'rejected') failures.push(result.reason as unknown)
      }
      if (failures.length > 0) {
        try {
          await this.options.registry.restoreWorkspaceAfterFailedClose(
            projectId,
            workspaceId,
          )
        } catch (error) {
          failures.push(error)
        }
        throw new AggregateError(failures, 'Workspace close cleanup failed')
      }
      this.assertCurrent(transition)
      return state
    })
  }

  reopenWorkspace(projectId: string, workspaceId: string): Promise<ProjectState> {
    const transition = this.beginTransition()
    return this.options.workspaces.serialize(async () => {
      this.assertCurrent(transition)
      await this.settleTransition(transition)
      this.assertCurrent(transition)
      const state = await this.options.registry.reopenWorkspace(projectId, workspaceId)
      this.assertCurrent(transition)
      await this.options.workspaces.replaceWatch(this.options.registry.active)
      return state
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
          this.options.cleanup.closeWorkspaceWebPanes(workspace.root),
        ])
      }
      this.assertCurrent(transition)
      if (wasActive) {
        await this.options.workspaces.replaceWatch(this.options.registry.active)
      }
      return state
    })
  }

  acknowledgeWorkspace(projectId: string, workspaceId: string): Promise<ProjectState> {
    return this.options.workspaces.serialize(() =>
      this.options.registry.acknowledgeWorkspace(projectId, workspaceId),
    )
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

  private closeableWorkspace(
    projectId: string,
    workspaceId: string,
  ): RegisteredProjectState['workspaces'][number] {
    const workspace = this.options.registry
      .projectById(projectId)
      ?.workspaces.find((candidate) => candidate.id === workspaceId)
    if (!workspace) throw new Error('Unknown project workspace')
    if (
      this.options.registry.active.projectId === projectId &&
      this.options.registry.active.workspaceId === workspaceId
    ) {
      throw new Error('Select another workspace before closing this one')
    }
    if (workspace.missing) throw new Error('Only present workspaces can be closed')
    if (workspace.closed) throw new Error('Workspace is already closed')
    return workspace
  }

  private settleTransition(transition: Transition): Promise<void> {
    return Promise.all(
      transition.projects.map((projectId) =>
        this.options.workspaces.settleProject(projectId, 'skip'),
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

  private async controlHost<T>(
    operation: ProjectHostControlDiagnostic['operation'],
    hostId: string,
    control: () => Promise<T>,
  ): Promise<T> {
    try {
      return await control()
    } catch (error) {
      try {
        this.options.onHostControlDiagnostic?.({
          operation,
          hostKind: hostId === LOCAL_HOST_ID ? 'local' : 'ssh',
        })
      } catch {
        // Diagnostics is a droppable observer and never owns host control.
      }
      throw error
    }
  }
}

function staleTransitionError(): Error {
  return new Error('Project transition was superseded by a newer request')
}
