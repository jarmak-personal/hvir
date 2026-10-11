import { useEffect, useRef, useSyncExternalStore } from 'react'

import type {
  ProjectState,
  RegisteredProjectState,
  WorkspaceState,
} from '../../../shared'
import {
  SessionsProjectionCoordinator,
  createSessionsMainObservationPort,
} from '../sessions/sessions-projection-coordinator'
import { TerminalWorkspaceRuntimeOwner } from './terminal-workspace-runtime-owner'
import { SessionsTerminalCommandCoordinator } from './sessions-terminal-command-coordinator'
import { terminalMoveTargets } from './terminal-move-targets'
import { useNewWorktreeMoveBadge } from './use-new-worktree-move-badge'
import { TerminalCommandCoordinator } from './terminal-command-coordinator'
import { useTerminalWorkspaceTransfer } from './use-terminal-workspace-transfer'

export function useTerminalWorkspaceRuntime({
  projectState,
  acceptProjectState,
  forgetWebViews,
  acknowledgeWorkspaces,
  onError,
}: {
  readonly projectState?: ProjectState
  readonly acceptProjectState: (state: ProjectState) => void
  readonly forgetWebViews: (terminalId: string) => void
  readonly acknowledgeWorkspaces: (
    projectId: string,
    workspaceIds: readonly string[],
  ) => Promise<void>
  readonly onError: (message: string) => void
}) {
  const owner = useRef(new TerminalWorkspaceRuntimeOwner()).current
  const sessionsProjectionRef = useRef<SessionsProjectionCoordinator | undefined>(
    undefined,
  )
  sessionsProjectionRef.current ??= new SessionsProjectionCoordinator(
    createSessionsMainObservationPort(window.hvir),
    owner.sessionsObservation,
  )
  const sessionsProjection = sessionsProjectionRef.current
  const materializedWorkspaceIds = useSyncExternalStore(
    owner.subscribe,
    owner.snapshot,
    owner.snapshot,
  )
  const eligibleWorkspaceIds = useRef<ReadonlySet<string>>(new Set())
  eligibleWorkspaceIds.current = new Set(
    projectState?.projects.flatMap((project) =>
      project.workspaces
        .filter((workspace) => !workspace.closed)
        .map((workspace) => workspace.id),
    ) ?? [],
  )
  const transfer = useTerminalWorkspaceTransfer({
    owner,
    canMaterialize: (workspaceId) => eligibleWorkspaceIds.current.has(workspaceId),
    acceptProjectState,
    forgetWebViews,
    onError,
  })
  const commandContext = useRef({ projectState, acceptProjectState })
  commandContext.current = { projectState, acceptProjectState }
  const sessionsCommands = useRef<SessionsTerminalCommandCoordinator | undefined>(
    undefined,
  )
  sessionsCommands.current ??= new SessionsTerminalCommandCoordinator({
    api: window.hvir,
    state: () => commandContext.current.projectState,
    snapshot: sessionsProjection.snapshot,
    accept: (state) => {
      commandContext.current.projectState = state
      commandContext.current.acceptProjectState(state)
    },
    prepare: transfer.prepare,
    release: transfer.release,
    controller: (workspaceId) => owner.controller(workspaceId),
    complete: transfer.complete,
  })
  useEffect(() => {
    const commands = new TerminalCommandCoordinator({
      api: window.hvir,
      state: () => commandContext.current.projectState,
      accept: (state) => {
        commandContext.current.projectState = state
        commandContext.current.acceptProjectState(state)
      },
      prepare: transfer.prepare,
      release: transfer.release,
      controller: (workspace) => owner.controller(workspace),
    })
    const requested = window.hvir.on('terminal:command-requested', (request) => {
      void commands
        .open(request)
        .catch((reason: unknown) =>
          onError(reason instanceof Error ? reason.message : 'Terminal handoff failed'),
        )
    })
    const revoked = window.hvir.on('terminal:command-revoked', ({ ticket }) =>
      commands.revoke(ticket),
    )
    return () => {
      commands.dispose()
      void requested()
      void revoked()
    }
  }, [owner, transfer.prepare, transfer.release, onError])
  useNewWorktreeMoveBadge({ projectState, acknowledgeWorkspaces, onError })

  useEffect(() => {
    const dispose = (): void => {
      sessionsProjection.dispose()
      owner.disposeForRendererRollover()
    }
    window.addEventListener('pagehide', dispose, { once: true })
    return () => window.removeEventListener('pagehide', dispose)
  }, [owner, sessionsProjection])
  useEffect(() => {
    owner.pruneWorkspaces(eligibleWorkspaceIds.current)
    owner.runtimes.disposeMissingWorkspaces(
      projectState?.projects.flatMap((project) =>
        project.workspaces
          .filter((workspace) => !workspace.closed)
          .map((workspace) => workspace.root),
      ) ?? [],
    )
  }, [owner, projectState])

  return {
    materializedWorkspaceIds,
    sessionsProjection,
    sessionsCommands: sessionsCommands.current,
    sessionsObservation: owner.sessionsObservation,
    sessionsSurface: owner.sessionsSurface,
    focusProjectedSession: owner.focusProjectedSession.bind(owner),
    openTerminalSearch: () => owner.runtimes.openSearch(),
    moveProps: (project: RegisteredProjectState, workspace: WorkspaceState) => ({
      runtimes: owner.runtimes,
      sessionsProjection,
      moveTargets: terminalMoveTargets(project.workspaces, workspace.id),
      onMaterializationChange: owner.retainWorkspace,
      onSessionsSource: owner.registerSessionsSource,
      onSessionsChanged: owner.sessionsChanged,
      onController: transfer.register,
      onPrepareMoveTarget: transfer.prepare,
      onReleaseMoveTarget: transfer.release,
      onTerminalMoved: transfer.complete,
      onAcknowledgeMoveTargets: (workspaceIds: readonly string[]) =>
        acknowledgeWorkspaces(project.id, workspaceIds),
      onError,
    }),
  }
}
