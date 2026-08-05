import type { ComponentProps, ReactElement } from 'react'

import type { ProjectState } from '../../../shared'
import { TerminalWorkspace } from './TerminalWorkspace'
import type { useTerminalWorkspaceRuntime } from './use-terminal-workspace-runtime'

type WorkspaceProps = ComponentProps<typeof TerminalWorkspace>
type WorkspaceRuntime = ReturnType<typeof useTerminalWorkspaceRuntime>

interface TerminalWorkspaceCollectionProps {
  readonly state?: ProjectState
  readonly runtime: WorkspaceRuntime
  readonly railCompact: WorkspaceProps['railCompact']
  readonly onRailCompact: WorkspaceProps['onRailCompact']
  readonly onRollup: WorkspaceProps['onRollup']
  readonly onOpenPath: WorkspaceProps['onOpenPath']
  readonly onOpenWebLink: WorkspaceProps['onOpenWebLink']
  readonly preferences: WorkspaceProps['preferences']
  readonly onOpenSettings: WorkspaceProps['onOpenSettings']
  readonly onOpenTerminalSettings: WorkspaceProps['onOpenTerminalSettings']
  readonly onOpenHarnessSettings: WorkspaceProps['onOpenHarnessSettings']
  readonly onAddHarness: WorkspaceProps['onAddHarness']
}

/** Mounts only selected, retained-session, or admitted-transfer workspace owners. */
export function TerminalWorkspaceCollection({
  state,
  runtime,
  railCompact,
  onRailCompact,
  onRollup,
  onOpenPath,
  onOpenWebLink,
  preferences,
  onOpenSettings,
  onOpenTerminalSettings,
  onOpenHarnessSettings,
  onAddHarness,
}: TerminalWorkspaceCollectionProps): ReactElement {
  const materialized = new Set(runtime.materializedWorkspaceIds)
  return (
    <>
      {state?.projects.flatMap((project) =>
        project.workspaces
          .filter(
            (workspace) =>
              !workspace.closed &&
              (workspace.id === state.activeWorkspaceId ||
                materialized.has(workspace.id)),
          )
          .map((workspace) => (
            <TerminalWorkspace
              key={workspace.id}
              workspaceId={workspace.id}
              cwd={workspace.root}
              label={workspace.name}
              available={!workspace.missing}
              visible={workspace.id === state.activeWorkspaceId}
              railCompact={railCompact}
              onRailCompact={onRailCompact}
              connectionState={project.connectionState}
              {...runtime.moveProps(project, workspace)}
              onRollup={onRollup}
              onOpenPath={onOpenPath}
              onOpenWebLink={onOpenWebLink}
              preferences={preferences}
              onOpenSettings={onOpenSettings}
              onOpenTerminalSettings={onOpenTerminalSettings}
              onOpenHarnessSettings={onOpenHarnessSettings}
              onAddHarness={onAddHarness}
            />
          )),
      )}
    </>
  )
}
