import type { HostPath, ProjectState } from '../../shared'
import type { ProjectHost } from '../project-host'
export function createSessionsProjectState(
  host: ProjectHost,
  smokeRoot: HostPath,
  smokeWebSwitchRoot: HostPath,
  smokeCloseableRoot: HostPath,
  smokeRemoteRoot: HostPath,
  smokeProjectState: () => ProjectState,
): ProjectState {
  const smokeProjectRevision = smokeProjectState().revision
  const smokeSessionsProjectionState = (): ProjectState => ({
    revision: smokeProjectRevision,
    root: smokeRoot,
    connectionState: 'connected',
    watchTier: host.watchTier,
    activeProjectId: `project:${smokeRoot.hostId}:${smokeRoot.path}`,
    activeWorkspaceId: `workspace:${smokeRoot.hostId}:${smokeRoot.path}`,
    projects: [
      {
        id: `project:${smokeRoot.hostId}:${smokeRoot.path}`,
        registeredRoot: smokeRoot,
        displayName: 'Primary project',
        connectionState: 'connected',
        watchTier: host.watchTier,
        activeWorkspaceId: `workspace:${smokeRoot.hostId}:${smokeRoot.path}`,
        workspaces: [
          {
            ...smokeProjectState().projects[0]!.workspaces[0]!,
            id: `workspace:${smokeRoot.hostId}:${smokeRoot.path}`,
            name: 'main',
          },
          {
            id: `workspace:${smokeWebSwitchRoot.hostId}:${smokeWebSwitchRoot.path}`,
            root: smokeWebSwitchRoot,
            name: 'feature/sessions',
            main: false,
            closed: false,
            missing: false,
            repository: true,
            changedFiles: 0,
          },
        ],
      },
      {
        id: `project:${smokeCloseableRoot.hostId}:${smokeCloseableRoot.path}`,
        registeredRoot: smokeCloseableRoot,
        displayName: 'Secondary project',
        connectionState: 'connected',
        watchTier: host.watchTier,
        activeWorkspaceId: `workspace:${smokeCloseableRoot.hostId}:${smokeCloseableRoot.path}`,
        workspaces: [
          {
            id: `workspace:${smokeCloseableRoot.hostId}:${smokeCloseableRoot.path}`,
            root: smokeCloseableRoot,
            name: 'main',
            main: true,
            closed: false,
            missing: false,
            repository: true,
            changedFiles: 0,
          },
        ],
      },
      {
        id: `project:${smokeRemoteRoot.hostId}:${smokeRemoteRoot.path}`,
        registeredRoot: smokeRemoteRoot,
        displayName: 'Disconnected project',
        connectionState: 'disconnected',
        watchTier: 'polling',
        activeWorkspaceId: `workspace:${smokeRemoteRoot.hostId}:${smokeRemoteRoot.path}`,
        workspaces: [
          {
            id: `workspace:${smokeRemoteRoot.hostId}:${smokeRemoteRoot.path}`,
            root: smokeRemoteRoot,
            name: 'remote-main',
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

  return smokeSessionsProjectionState()
}
