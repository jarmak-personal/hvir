import {
  hostPathEquals,
  type MoveTerminalRequest,
  type MoveTerminalResponse,
  type PlanTerminalMoveRequest,
  type ProjectState,
  type RegisteredProjectState,
  type HostPath,
  type TerminalMovePlan,
} from '../../shared'
import type { RendererOwner } from '../renderer-resource-scopes'
import type { TerminalMoveSessionStore } from './session-registry'

export interface TerminalMoveProjectPort {
  readonly active: {
    readonly projectId: string
    readonly workspaceId: string
  }
  state(): ProjectState
  projectById(projectId: string): RegisteredProjectState | undefined
  activate(
    projectId: string,
    workspaceId: string,
    options?: { readonly emit?: boolean; readonly acknowledge?: boolean },
  ): Promise<ProjectState>
}

export interface TerminalMoveWorkspacePort {
  serialize<T>(operation: () => Promise<T>): Promise<T>
  replaceWatch(): Promise<void>
}

export interface TerminalMovePtyPort {
  get(id: string):
    | {
        readonly ownerId: number
        readonly ownerGeneration: number
        readonly workspaceRoot: HostPath
      }
    | undefined
  reassignWorkspace(
    id: string,
    ownerId: number,
    sourceRoot: HostPath,
    targetRoot: HostPath,
    ownerGeneration?: number,
  ): unknown
}

export interface TerminalMoveResourcePort {
  reassignWorkspaceResource(
    owner: RendererOwner,
    type: 'pty-session',
    id: string,
    sourceRoot: HostPath,
    targetRoot: HostPath,
  ): void
  disposeResource(owner: RendererOwner, type: 'web-pane', id: string): Promise<boolean>
}

export interface TerminalMoveWebPanePort {
  /** Validates the confirmed pane snapshot and blocks new panes until released. */
  blockTerminalMove(
    terminalId: string,
    ownerId: number,
    ownerGeneration: number,
    workspaceRoot: HostPath,
    expectedPaneIds: readonly string[],
  ): () => void
  paneIdsForTerminal(
    terminalId: string,
    ownerId: number,
    ownerGeneration: number,
    workspaceRoot: HostPath,
  ): readonly string[]
  hasPendingForTerminal(
    terminalId: string,
    ownerId: number,
    ownerGeneration: number,
  ): boolean
  closeTerminal(
    terminalId: string,
    ownerId: number,
    ownerGeneration: number,
  ): Promise<void>
}

export interface TerminalWorkspaceMoveCoordinatorOptions {
  readonly projects: TerminalMoveProjectPort
  readonly workspaces: TerminalMoveWorkspacePort
  readonly sessions: TerminalMoveSessionStore
  readonly ptys: TerminalMovePtyPort
  readonly resources: TerminalMoveResourcePort
  readonly webPanes: TerminalMoveWebPanePort
  readonly onError?: (message: string, error: unknown) => void
}

/** Atomically changes terminal presentation authority without changing launch context. */
export class TerminalWorkspaceMoveCoordinator {
  constructor(private readonly options: TerminalWorkspaceMoveCoordinatorOptions) {}

  plan(request: PlanTerminalMoveRequest, owner: RendererOwner): TerminalMovePlan {
    const { project, source, target } = this.resolveWorkspaces(request)
    const recovery = this.options.sessions.get(request.terminalId)
    if (!recovery || !hostPathEquals(recovery.workspaceRoot, source.root)) {
      throw new Error('Terminal recovery metadata is not ready in the source workspace')
    }
    const live = this.options.ptys.get(request.terminalId)
    if (
      !live ||
      live.ownerId !== owner.id ||
      live.ownerGeneration !== owner.generation ||
      !hostPathEquals(live.workspaceRoot, source.root)
    ) {
      throw new Error('Terminal is no longer live in the source workspace')
    }
    if (
      this.options.webPanes.hasPendingForTerminal(
        request.terminalId,
        owner.id,
        owner.generation,
      )
    ) {
      throw new Error('A web pane is still opening; wait for it to finish before moving')
    }
    return {
      terminalId: request.terminalId,
      terminalTitle: recovery.title,
      sourceProjectId: project.id,
      sourceWorkspaceId: source.id,
      sourceWorkspaceName: source.name,
      sourceRoot: source.root,
      targetWorkspaceId: target.id,
      targetWorkspaceName: target.name,
      targetRoot: target.root,
      webPaneIds: this.options.webPanes.paneIdsForTerminal(
        request.terminalId,
        owner.id,
        owner.generation,
        source.root,
      ),
    }
  }

  move(
    request: MoveTerminalRequest,
    owner: RendererOwner,
  ): Promise<MoveTerminalResponse> {
    return this.options.workspaces.serialize(async () => {
      const plan = this.plan(request, owner)
      const releaseWebPaneBlock = this.options.webPanes.blockTerminalMove(
        plan.terminalId,
        owner.id,
        owner.generation,
        plan.sourceRoot,
        request.expectedWebPaneIds,
      )

      try {
        await this.options.sessions.move({
          id: plan.terminalId,
          sourceRoot: plan.sourceRoot,
          targetRoot: plan.targetRoot,
        })
        try {
          for (const paneId of plan.webPaneIds) {
            await this.options.resources.disposeResource(owner, 'web-pane', paneId)
          }
          await this.options.webPanes.closeTerminal(
            plan.terminalId,
            owner.id,
            owner.generation,
          )
        } catch (error) {
          await this.rollbackSession(plan).catch((rollbackError) => {
            throw new AggregateError(
              [error, rollbackError],
              'Web pane cleanup and terminal move rollback failed',
            )
          })
          throw error
        }
        let ptyMoved = false
        let resourceMoved = false
        try {
          this.options.ptys.reassignWorkspace(
            plan.terminalId,
            owner.id,
            plan.sourceRoot,
            plan.targetRoot,
            owner.generation,
          )
          ptyMoved = true
          this.options.resources.reassignWorkspaceResource(
            owner,
            'pty-session',
            plan.terminalId,
            plan.sourceRoot,
            plan.targetRoot,
          )
          resourceMoved = true
        } catch (error) {
          await this.rollbackLiveMove(plan, owner, { ptyMoved, resourceMoved }).catch(
            (rollbackError) => {
              throw new AggregateError(
                [error, rollbackError],
                'Terminal move and rollback failed',
              )
            },
          )
          throw error
        }

        let state: ProjectState
        try {
          state = await this.options.projects.activate(
            plan.sourceProjectId,
            plan.targetWorkspaceId,
            { emit: false },
          )
        } catch (error) {
          await this.rollbackLiveMove(plan, owner, {
            ptyMoved: true,
            resourceMoved: true,
          }).catch((rollbackError) => {
            throw new AggregateError(
              [error, rollbackError],
              'Terminal activation and rollback failed',
            )
          })
          throw error
        }

        await this.options.workspaces
          .replaceWatch()
          .catch((error) =>
            this.report('[terminal] watch replacement after move failed', error),
          )
        return { state, workspaceRoot: plan.targetRoot }
      } finally {
        releaseWebPaneBlock()
      }
    })
  }

  private resolveWorkspaces(request: PlanTerminalMoveRequest) {
    const state = this.options.projects.state()
    const project = state.projects.find((candidate) =>
      candidate.workspaces.some(
        (workspace) => workspace.id === request.sourceWorkspaceId,
      ),
    )
    const source = project?.workspaces.find(
      (workspace) => workspace.id === request.sourceWorkspaceId,
    )
    const target = project?.workspaces.find(
      (workspace) => workspace.id === request.targetWorkspaceId,
    )
    if (!project || !source || !target) {
      throw new Error('Move target must be a worktree in the source project')
    }
    if (
      project.id !== state.activeProjectId ||
      source.id !== state.activeWorkspaceId ||
      this.options.projects.active.projectId !== project.id ||
      this.options.projects.active.workspaceId !== source.id
    ) {
      throw new Error('Source workspace is no longer active')
    }
    if (source.id === target.id) throw new Error('Terminal is already in this workspace')
    if (target.missing) throw new Error('Target worktree is no longer present')
    if (
      source.root.hostId !== project.registeredRoot.hostId ||
      target.root.hostId !== project.registeredRoot.hostId
    ) {
      throw new Error('Terminal cannot move to another host')
    }
    return { project, source, target }
  }

  private async rollbackLiveMove(
    plan: TerminalMovePlan,
    owner: RendererOwner,
    applied: { readonly ptyMoved: boolean; readonly resourceMoved: boolean },
  ): Promise<void> {
    const failures: unknown[] = []
    if (applied.resourceMoved) {
      try {
        this.options.resources.reassignWorkspaceResource(
          owner,
          'pty-session',
          plan.terminalId,
          plan.targetRoot,
          plan.sourceRoot,
        )
      } catch (error) {
        failures.push(error)
      }
    }
    if (applied.ptyMoved) {
      try {
        this.options.ptys.reassignWorkspace(
          plan.terminalId,
          owner.id,
          plan.targetRoot,
          plan.sourceRoot,
          owner.generation,
        )
      } catch (error) {
        failures.push(error)
      }
    }
    try {
      await this.rollbackSession(plan)
    } catch (error) {
      failures.push(error)
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Terminal move rollback failed')
    }
  }

  private rollbackSession(plan: TerminalMovePlan): Promise<unknown> {
    return this.options.sessions.move({
      id: plan.terminalId,
      sourceRoot: plan.targetRoot,
      targetRoot: plan.sourceRoot,
    })
  }

  private report(message: string, error: unknown): void {
    if (this.options.onError) this.options.onError(message, error)
    else console.error(message, error)
  }
}
