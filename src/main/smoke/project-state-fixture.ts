import { joinHostPath, type HostPath, type ProjectState } from '../../shared'
import type { ProjectHost } from '../project-host'
import type { ElectronSmokeMode } from './scenario-selection.mts'

/** Host-qualified project snapshots and their revision/observation authority. */
export function createSmokeProjectState(
  host: ProjectHost,
  smokeRoot: HostPath,
  smokeRemoteRoot: HostPath,
  smokeWebSwitchRoot: HostPath,
  mode: ElectronSmokeMode,
) {
  const repository = mode !== 'platform-contracts' && mode !== 'renderer-recovery'
  const projectReturn =
    mode === 'terminal-presentation' ||
    mode === 'document-review' ||
    mode === 'agent-workbench'
  const extensionDestinations =
    mode === 'extensions' &&
    (process.env.HVIR_SKILLAGER_MANAGEMENT_FIXTURE ||
      process.env.HVIR_SKILLAGER_EVIDENCE_CLI)
      ? { worktree: smokeWebSwitchRoot, project: joinHostPath(smokeRoot, 'packages') }
      : undefined
  let smokeProjectRevision = 0
  const commitSmokeProjectState = (state: ProjectState): ProjectState => ({
    ...state,
    revision: (smokeProjectRevision += 1),
  })
  const smokeProjectState = (
    connectionState = host.connectionState,
    missing = false,
  ): ProjectState =>
    extensionDestinationState(
      {
        revision: smokeProjectRevision,
        root: smokeRoot,
        connectionState,
        watchTier: host.watchTier,
        activeProjectId: 'smoke-project',
        activeWorkspaceId: 'smoke-workspace',
        projects: [
          {
            id: 'smoke-project',
            registeredRoot: smokeRoot,
            displayName: 'hvir',
            connectionState,
            watchTier: host.watchTier,
            activeWorkspaceId: 'smoke-workspace',
            workspaces: [
              {
                id: 'smoke-workspace',
                root: smokeRoot,
                name: 'hvir',
                main: true,
                closed: false,
                missing,
                // The platform-only group does not acquire unrelated Git-worker work.
                repository,
                changedFiles: 0,
              },
            ],
          },
        ],
      },
      extensionDestinations,
    )
  const smokeRemoteProjectState = (): ProjectState => ({
    revision: smokeProjectRevision,
    // Present remote chrome without widening the mounted local host authority.
    root: smokeRoot,
    connectionState: 'connected',
    watchTier: 'polling',
    activeProjectId: 'smoke-remote-project',
    activeWorkspaceId: 'smoke-workspace',
    projects: [
      {
        id: 'smoke-remote-project',
        registeredRoot: smokeRemoteRoot,
        displayName: 'remote-hvir',
        connectionState: 'connected',
        watchTier: 'polling',
        activeWorkspaceId: 'smoke-workspace',
        workspaces: [
          {
            id: 'smoke-workspace',
            root: smokeRoot,
            name: 'feature/header',
            main: true,
            closed: false,
            missing: false,
            repository: true,
            changedFiles: 0,
          },
        ],
      },
    ],
  })
  const smokeRemoteFileProjectState = (): ProjectState => ({
    revision: smokeProjectRevision,
    root: smokeRemoteRoot,
    connectionState: 'connected',
    watchTier: 'polling',
    activeProjectId: 'smoke-remote-file-project',
    activeWorkspaceId: 'smoke-remote-file-workspace',
    projects: [
      {
        id: 'smoke-remote-file-project',
        registeredRoot: smokeRemoteRoot,
        displayName: 'remote-hvir',
        connectionState: 'connected',
        watchTier: 'polling',
        activeWorkspaceId: 'smoke-remote-file-workspace',
        workspaces: [
          {
            id: 'smoke-remote-file-workspace',
            root: smokeRemoteRoot,
            name: 'feature/files',
            main: true,
            closed: false,
            missing: false,
            repository: false,
            changedFiles: 0,
          },
        ],
      },
    ],
  })
  const smokeProjectReturnState = (activeProjectId: string): ProjectState => {
    const primary = smokeProjectState().projects[0]!
    const secondaryWorkspaceId = 'smoke-project-return-workspace'
    const secondary = {
      id: 'smoke-project-return',
      registeredRoot: smokeWebSwitchRoot,
      displayName: 'return-fixture',
      connectionState: host.connectionState,
      watchTier: host.watchTier,
      activeWorkspaceId: secondaryWorkspaceId,
      workspaces: [
        {
          id: secondaryWorkspaceId,
          root: smokeWebSwitchRoot,
          name: 'return-fixture',
          main: true,
          closed: false,
          missing: false,
          repository: true,
          changedFiles: 0,
        },
      ],
    }
    const activeSecondary = activeProjectId === secondary.id
    return {
      revision: smokeProjectRevision,
      root: activeSecondary ? smokeWebSwitchRoot : smokeRoot,
      connectionState: host.connectionState,
      watchTier: host.watchTier,
      activeProjectId: activeSecondary ? secondary.id : primary.id,
      activeWorkspaceId: activeSecondary
        ? secondaryWorkspaceId
        : primary.activeWorkspaceId,
      projects: [primary, secondary],
    }
  }
  let smokeIpcProjectState = commitSmokeProjectState(
    projectReturn ? smokeProjectReturnState('smoke-project') : smokeProjectState(),
  )
  const smokeProjectObservationListeners = new Set<() => void>()
  const setSmokeProjectState = (state: ProjectState): ProjectState => {
    const committed = commitSmokeProjectState(state)
    smokeIpcProjectState = committed
    for (const listener of smokeProjectObservationListeners) listener()
    return committed
  }

  return {
    base: smokeProjectState,
    remotePresentation: smokeRemoteProjectState,
    remoteFiles: smokeRemoteFileProjectState,
    projectReturn: smokeProjectReturnState,
    get: () => smokeIpcProjectState,
    set: setSmokeProjectState,
    observe: (listener: () => void) => {
      smokeProjectObservationListeners.add(listener)
      return () => {
        smokeProjectObservationListeners.delete(listener)
      }
    },
  }
}

/** Opt-in native picker geometry uses registered metadata, not a discovery simulation. */
function extensionDestinationState(
  state: ProjectState,
  roots?: { readonly worktree: HostPath; readonly project: HostPath },
): ProjectState {
  if (!roots) return state
  const primary = state.projects[0]!,
    workspace = primary.workspaces[0]!
  return {
    ...state,
    projects: [
      {
        ...primary,
        workspaces: [
          workspace,
          {
            ...workspace,
            id: 'extension-feature',
            root: roots.worktree,
            name: 'feature/skill-reading',
            main: false,
            repository: false,
          },
        ],
      },
      {
        ...primary,
        id: 'extension-notes',
        registeredRoot: roots.project,
        displayName: 'Notes',
        activeWorkspaceId: 'extension-notes-root',
        workspaces: [
          {
            ...workspace,
            id: 'extension-notes-root',
            root: roots.project,
            name: 'Notes',
            repository: false,
          },
        ],
      },
    ],
  }
}
