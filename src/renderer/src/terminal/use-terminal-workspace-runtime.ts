import type { PreparedTerminalSession } from './terminal-workspace-model'
import { hostPathEquals, type HostPath } from '../../../shared'
import { useEffect, useRef, useSyncExternalStore } from 'react'

import type {
  ProjectState,
  RegisteredProjectState,
  WorkspaceState,
} from '../../../shared'
import { TerminalWorkspaceRuntimeOwner } from './terminal-workspace-runtime-owner'
import { useNewWorktreeMoveBadge } from './use-new-worktree-move-badge'
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
  const currentProject = useRef(projectState)
  currentProject.current = projectState
  const owner = useRef(new TerminalWorkspaceRuntimeOwner()).current
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
  useNewWorktreeMoveBadge({ projectState, acknowledgeWorkspaces, onError })

  useEffect(() => {
    const dispose = (): void => owner.disposeForRendererRollover()
    window.addEventListener('pagehide', dispose, { once: true })
    return () => window.removeEventListener('pagehide', dispose)
  }, [owner])
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
    openPrepared: async (
      root: HostPath,
      session: PreparedTerminalSession,
      signal: AbortSignal,
    ): Promise<void> => {
      const state = currentProject.current
      if (!state || !hostPathEquals(state.root, root))
        throw new Error('The setup workspace changed.')
      const id = state.activeWorkspaceId
      try {
        await transfer.prepare(id, signal)
        if (
          signal.aborted ||
          currentProject.current?.activeWorkspaceId !== id ||
          !owner.controller(id)?.addPrepared(session)
        )
          throw new Error('The terminal workspace is not ready.')
      } finally {
        transfer.release(id)
      }
    },
    materializedWorkspaceIds,
    sessionsObservation: owner.sessionsObservation,
    sessionsSurface: owner.sessionsSurface,
    focusProjectedSession: owner.focusProjectedSession.bind(owner),
    openTerminalSearch: () => owner.runtimes.openSearch(),
    moveProps: (project: RegisteredProjectState, workspace: WorkspaceState) => ({
      runtimes: owner.runtimes,
      moveTargets: project.workspaces.filter(
        (target) => target.id !== workspace.id && !target.missing && !target.closed,
      ),
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
