import { useEffect, useRef } from 'react'

import type {
  ProjectState,
  RegisteredProjectState,
  WorkspaceState,
} from '../../../shared'
import { TerminalRuntimeRegistry } from './terminal-runtime'
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
  const runtimes = useRef(new TerminalRuntimeRegistry()).current
  const transfer = useTerminalWorkspaceTransfer({
    acceptProjectState,
    forgetWebViews,
    onError,
  })

  useEffect(() => () => runtimes.dispose(), [runtimes])
  useEffect(() => {
    runtimes.disposeMissingWorkspaces(
      projectState?.projects.flatMap((project) =>
        project.workspaces.map((workspace) => workspace.root),
      ) ?? [],
    )
  }, [projectState, runtimes])

  return {
    moveProps: (project: RegisteredProjectState, workspace: WorkspaceState) => ({
      runtimes,
      moveTargets: project.workspaces.filter(
        (target) => target.id !== workspace.id && !target.missing,
      ),
      onController: transfer.register,
      onTerminalMoved: transfer.complete,
      onAcknowledgeMoveTargets: (workspaceIds: readonly string[]) =>
        acknowledgeWorkspaces(project.id, workspaceIds),
      onError,
    }),
  }
}
