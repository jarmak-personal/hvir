import {
  unwrapOperation,
  type ProjectState,
  type WorkspaceClosePlan,
} from '../../../shared'

interface WorkspaceSessionActionsOptions {
  readonly runTransition: (
    operation: () => Promise<ProjectState>,
  ) => Promise<ProjectState | undefined>
  readonly ensureProjectConnected: (projectId: string) => Promise<void>
  readonly reportError: (reason: unknown) => void
}

/** Renderer adapter for the closed-workspace lifecycle IPC owned by main. */
export function createWorkspaceSessionActions(options: WorkspaceSessionActionsOptions) {
  return {
    planWorkspaceClose: async (
      projectId: string,
      workspaceId: string,
    ): Promise<WorkspaceClosePlan | undefined> => {
      try {
        return unwrapOperation(
          await window.hvir.invoke('workspace:plan-close', {
            projectId,
            workspaceId,
          }),
        )
      } catch (reason) {
        options.reportError(reason)
        return undefined
      }
    },
    closeWorkspace: async (
      projectId: string,
      workspaceId: string,
      plan: WorkspaceClosePlan,
      terminateTerminals: boolean,
    ): Promise<void> => {
      await options.runTransition(async () =>
        unwrapOperation(
          await window.hvir.invoke('workspace:close', {
            projectId,
            workspaceId,
            expectedTerminalCount: plan.terminalCount,
            terminateTerminals,
          }),
        ),
      )
    },
    reopenWorkspace: async (projectId: string, workspaceId: string): Promise<void> => {
      await options.runTransition(async () => {
        await options.ensureProjectConnected(projectId)
        return unwrapOperation(
          await window.hvir.invoke('workspace:reopen', { projectId, workspaceId }),
        )
      })
    },
  }
}
