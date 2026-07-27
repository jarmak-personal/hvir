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

  useEffect(() => () => owner.dispose(), [owner])
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
    moveProps: (project: RegisteredProjectState, workspace: WorkspaceState) => ({
      runtimes: owner.runtimes,
      moveTargets: project.workspaces.filter(
        (target) => target.id !== workspace.id && !target.missing && !target.closed,
      ),
      onMaterializationChange: owner.retainWorkspace,
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
