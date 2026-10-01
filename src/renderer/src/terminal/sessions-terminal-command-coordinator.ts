import {
  asSessionsTerminalHandle,
  hostPathEquals,
  sessionsWorkspaceQualifier,
  unwrapOperation,
  type HvirApi,
  type HostPath,
  type MoveTerminalResponse,
  type ProjectState,
  type SessionsProjectionRow,
  type SessionsProjectionSnapshot,
  type SessionsProjectHandle,
  type TerminalMovePlan,
} from '../../../shared'
import type {
  SessionsCommandPort,
  SessionsLaunchChoices,
} from '../sessions/sessions-command-port'
import { terminalMoveTargets } from './terminal-move-targets'
import type { TerminalWorkspaceController } from './terminal-workspace-command-port'

interface CommandWorkspace {
  readonly projectId: string
  readonly workspaceId: string
  readonly root: HostPath
}

export interface SessionsTerminalCommandPorts {
  readonly api: Pick<HvirApi, 'invoke'>
  state(): ProjectState | undefined
  snapshot(): SessionsProjectionSnapshot
  accept(state: ProjectState): void
  prepare(workspaceId: string, forLaunch?: boolean, signal?: AbortSignal): Promise<void>
  release(workspaceId: string): void
  controller(workspaceId: string): TerminalWorkspaceController | undefined
  complete(
    id: string,
    sourceId: string,
    targetId: string,
    response: MoveTerminalResponse,
  ): void
}

/** Selects command context, then delegates to the existing terminal owners. */
export class SessionsTerminalCommandCoordinator implements SessionsCommandPort {
  constructor(private readonly ports: SessionsTerminalCommandPorts) {}

  async launchChoices(
    project: SessionsProjectHandle,
    snapshot: SessionsProjectionSnapshot,
    signal: AbortSignal,
  ): Promise<SessionsLaunchChoices> {
    this.assertSnapshot(snapshot, signal)
    const observed = snapshot.workspaces.find(
      (workspace) => workspace.projectId === project,
    )
    if (!observed) throw new Error('This project is no longer available in Sessions.')
    const source = this.resolveQualifier(observed.qualifier)
    const nativeProject = this.ports
      .state()
      ?.projects.find((candidate) => candidate.id === source.projectId)
    const root = nativeProject?.workspaces.find((workspace) =>
      hostPathEquals(workspace.root, nativeProject.registeredRoot),
    )
    if (!root || root.closed || root.missing)
      throw new Error(
        'The project root workspace is unavailable. Reopen it from the project view.',
      )
    const target = { projectId: source.projectId, workspaceId: root.id, root: root.root }
    const read = async (
      force: boolean,
      currentSignal: AbortSignal,
    ): Promise<SessionsLaunchChoices> => {
      this.assertWorkspace(target, currentSignal)
      const [profiles, providers, probes] = await Promise.all([
        this.ports.api.invoke('harness:profiles', { root: target.root }),
        this.ports.api.invoke('harness:catalog', undefined),
        this.ports.api.invoke('harness:probe-profiles', { root: target.root, force }),
      ])
      this.assertWorkspace(target, currentSignal)
      return {
        profiles,
        providers,
        probes,
        refresh: (nextSignal) => read(true, nextSignal),
        start: async (profile, nextSignal) => {
          this.assertWorkspace(target, nextSignal)
          const latestProfiles = await this.ports.api.invoke('harness:profiles', {
            root: target.root,
          })
          this.assertWorkspace(target, nextSignal)
          const latest = latestProfiles.find(
            (candidate) =>
              candidate.id === profile.id &&
              candidate.launchRevision === profile.launchRevision,
          )
          if (!latest) {
            throw new Error(
              'This launch profile changed or is unavailable. Reopen the launcher before starting it.',
            )
          }
          await this.select(target, nextSignal)
          try {
            await this.ports.prepare(target.workspaceId, true, nextSignal)
            this.assertWorkspace(target, nextSignal, true)
            const id = this.ports
              .controller(target.workspaceId)
              ?.launchSession?.(latest.id, latest.launchRevision)
            if (!id) throw new Error('The selected launch profile is no longer ready.')
            return asSessionsTerminalHandle(id)
          } finally {
            this.ports.release(target.workspaceId)
          }
        },
      }
    }
    return read(false, signal)
  }

  moveChoices(row: SessionsProjectionRow, snapshot: SessionsProjectionSnapshot) {
    this.assertRow(row, snapshot)
    const source = this.resolveQualifier(row.workspace.qualifier)
    const project = this.ports
      .state()
      ?.projects.find((candidate) => candidate.id === source.projectId)
    return terminalMoveTargets(project?.workspaces ?? [], source.workspaceId).map(
      (workspace) => ({ id: workspace.id, name: workspace.name }),
    )
  }

  async planMove(
    row: SessionsProjectionRow,
    snapshot: SessionsProjectionSnapshot,
    targetId: string,
    signal: AbortSignal,
  ): Promise<TerminalMovePlan> {
    this.assertSnapshot(snapshot, signal)
    if (!this.moveChoices(row, snapshot).some((target) => target.id === targetId))
      throw new Error('The target workspace is no longer available.')
    const source = this.resolveQualifier(row.workspace.qualifier)
    await this.selectSession(row, snapshot, signal)
    const plan = unwrapOperation(
      await this.ports.api.invoke('terminal:plan-move', {
        terminalId: row.handle,
        expectedInstanceId: row.livePty?.handle,
        sourceWorkspaceId: source.workspaceId,
        targetWorkspaceId: targetId,
      }),
    )
    signal.throwIfAborted()
    this.currentRow(row)
    return plan
  }

  async move(
    row: SessionsProjectionRow,
    plan: TerminalMovePlan,
    signal: AbortSignal,
  ): Promise<void> {
    const current = this.currentRow(row)
    const snapshot = this.ports.snapshot()
    this.assertSnapshot(snapshot, signal)
    const source = this.resolveQualifier(current.workspace.qualifier)
    if (source.workspaceId !== plan.sourceWorkspaceId || plan.terminalId !== row.handle)
      throw new Error('The selected terminal workspace changed.')
    if (
      !this.moveChoices(current, snapshot).some(
        (target) => target.id === plan.targetWorkspaceId,
      )
    )
      throw new Error('The target workspace is no longer available.')
    await this.selectSession(current, snapshot, signal)
    try {
      await this.ports.prepare(plan.targetWorkspaceId, false, signal)
      signal.throwIfAborted()
      this.currentRow(row)
      const response = unwrapOperation(
        await this.ports.api.invoke('terminal:move', {
          terminalId: row.handle,
          expectedInstanceId: row.livePty?.handle,
          sourceWorkspaceId: plan.sourceWorkspaceId,
          targetWorkspaceId: plan.targetWorkspaceId,
          expectedWebPaneIds: plan.webPaneIds,
        }),
      )
      // A committed transfer must reconcile its owners even if its UI has departed.
      this.ports.complete(
        row.handle,
        plan.sourceWorkspaceId,
        plan.targetWorkspaceId,
        response,
      )
    } finally {
      this.ports.release(plan.targetWorkspaceId)
    }
  }

  private async selectSession(
    row: SessionsProjectionRow,
    snapshot: SessionsProjectionSnapshot,
    signal: AbortSignal,
  ): Promise<void> {
    this.assertRow(row, snapshot)
    signal.throwIfAborted()
    const result = await this.ports.api.invoke('sessions:open', {
      demandGeneration: snapshot.demandGeneration,
      sourceRevision: snapshot.sourceRevision,
      handle: row.handle,
      projectId: row.project.id,
      workspaceId: row.workspace.id,
      workspaceQualifier: row.workspace.qualifier,
      livePty: row.livePty,
    })
    signal.throwIfAborted()
    if (result.outcome !== 'opened')
      throw new Error(
        'The exact live session is no longer available. Refresh Sessions and try again.',
      )
    this.ports.accept(result.state)
  }

  private async select(target: CommandWorkspace, signal: AbortSignal): Promise<void> {
    this.assertWorkspace(target, signal)
    const state = unwrapOperation(
      await this.ports.api.invoke('project:switch', {
        projectId: target.projectId,
        workspaceId: target.workspaceId,
      }),
    )
    signal.throwIfAborted()
    this.ports.accept(state)
    this.assertWorkspace(target, signal, true)
  }

  private assertWorkspace(
    target: CommandWorkspace,
    signal: AbortSignal,
    selected = false,
  ): void {
    signal.throwIfAborted()
    const state = this.ports.state()
    const project = state?.projects.find((candidate) => candidate.id === target.projectId)
    const workspace = project?.workspaces.find(
      (candidate) => candidate.id === target.workspaceId,
    )
    if (
      !workspace ||
      workspace.closed ||
      workspace.missing ||
      !hostPathEquals(workspace.root, target.root)
    )
      throw new Error('The selected workspace is no longer available.')
    if (project?.connectionState !== 'connected')
      throw new Error(
        'The host is disconnected. Reconnect from the project view before trying again.',
      )
    if (
      selected &&
      (state?.activeProjectId !== target.projectId ||
        state.activeWorkspaceId !== target.workspaceId)
    )
      throw new Error('The selected workspace changed before the command completed.')
  }

  private resolveQualifier(
    qualifier: SessionsProjectionRow['workspace']['qualifier'],
  ): CommandWorkspace {
    const state = this.ports.state()
    if (state)
      for (const [projectIndex, project] of state.projects.entries()) {
        for (const [workspaceIndex, workspace] of project.workspaces.entries()) {
          if (
            sessionsWorkspaceQualifier(state.revision, projectIndex, workspaceIndex) ===
            qualifier
          ) {
            return {
              projectId: project.id,
              workspaceId: workspace.id,
              root: workspace.root,
            }
          }
        }
      }
    throw new Error('The workspace selection is stale. Refresh Sessions and try again.')
  }

  private assertSnapshot(
    snapshot: SessionsProjectionSnapshot,
    signal: AbortSignal,
  ): void {
    signal.throwIfAborted()
    const current = this.ports.snapshot()
    if (
      snapshot.status !== 'available' ||
      current.demandGeneration !== snapshot.demandGeneration ||
      current.sourceRevision !== snapshot.sourceRevision
    )
      throw new Error('Sessions changed before the command could start.')
  }

  private assertRow(
    row: SessionsProjectionRow,
    snapshot: SessionsProjectionSnapshot,
  ): void {
    if (
      snapshot.status !== 'available' ||
      !snapshot.rows.some(
        (candidate) =>
          candidate.handle === row.handle &&
          candidate.workspace.qualifier === row.workspace.qualifier,
      )
    )
      throw new Error('The session selection is stale.')
    this.currentRow(row)
  }

  private currentRow(row: SessionsProjectionRow): SessionsProjectionRow {
    const snapshot = this.ports.snapshot()
    const current = snapshot.rows.find((candidate) => candidate.handle === row.handle)
    if (
      snapshot.status !== 'available' ||
      !current ||
      current.lifecycle !== 'live' ||
      current.connectionState !== 'connected' ||
      current.workspace.id !== row.workspace.id ||
      current.livePty?.handle !== row.livePty?.handle ||
      current.livePty?.rendererGeneration !== row.livePty?.rendererGeneration ||
      current.livePty?.rendererOwnerId !== row.livePty?.rendererOwnerId
    )
      throw new Error('The exact live session changed or disconnected.')
    return current
  }
}
