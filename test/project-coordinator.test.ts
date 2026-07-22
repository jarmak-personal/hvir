/* eslint-disable @typescript-eslint/unbound-method -- assertions inspect typed Vitest port mocks */

import { describe, expect, it, vi } from 'vitest'

import {
  ProjectCoordinator,
  type ProjectCleanupPort,
  type ProjectRegistryPort,
  type ProjectWorkspacePort,
} from '../src/main/project-coordinator'
import type { ProjectHost } from '../src/main/project-host'
import {
  asHostId,
  hostPath,
  localPath,
  type ProjectHostOption,
  type ProjectState,
} from '../src/shared'

const remoteRoot = hostPath(asHostId('dev'), '/project')
const remoteOtherRoot = hostPath(asHostId('dev'), '/project-worktree')
const localRoot = localPath('/other')

function projectState(activeProjectId = 'project-1'): ProjectState {
  const activeRemote = activeProjectId === 'project-1'
  return {
    root: activeRemote ? remoteRoot : localRoot,
    connectionState: 'connected',
    watchTier: activeRemote ? 'polling' : 'native',
    activeProjectId,
    activeWorkspaceId: activeRemote ? 'workspace-1' : 'workspace-2',
    projects: [
      {
        id: 'project-1',
        registeredRoot: remoteRoot,
        displayName: 'project',
        connectionState: 'connected',
        watchTier: 'polling',
        activeWorkspaceId: 'workspace-1',
        workspaces: [
          {
            id: 'workspace-1',
            root: remoteRoot,
            name: 'project',
            main: true,
            missing: false,
            repository: true,
            changedFiles: 0,
          },
          {
            id: 'workspace-missing',
            root: remoteOtherRoot,
            name: 'project-worktree',
            main: false,
            missing: true,
            repository: true,
            changedFiles: 0,
          },
        ],
      },
      {
        id: 'project-2',
        registeredRoot: localRoot,
        displayName: 'other',
        connectionState: 'connected',
        watchTier: 'native',
        activeWorkspaceId: 'workspace-2',
        workspaces: [
          {
            id: 'workspace-2',
            root: localRoot,
            name: 'other',
            main: true,
            missing: false,
            repository: false,
            changedFiles: 0,
          },
        ],
      },
    ],
  }
}

function fixture() {
  let state = projectState()
  const remoteHost = {
    hostId: remoteRoot.hostId,
    connectionState: 'connected',
    watchTier: 'polling',
  } as unknown as ProjectHost
  const localHost = {
    hostId: localRoot.hostId,
    connectionState: 'connected',
    watchTier: 'native',
  } as unknown as ProjectHost
  let active = {
    host: remoteHost,
    root: remoteRoot,
    projectId: 'project-1',
    workspaceId: 'workspace-1',
  }
  const connected = {
    host: {
      hostId: 'dev',
      label: 'dev',
      kind: 'ssh',
      connectionState: 'connected',
      watchTier: 'polling',
    } as ProjectHostOption,
    suggestedPath: '/project',
  }
  const registry: ProjectRegistryPort = {
    get active() {
      return active
    },
    state: () => state,
    projectById: (id) => state.projects.find((project) => project.id === id),
    connectHost: vi.fn<ProjectRegistryPort['connectHost']>(() =>
      Promise.resolve(connected),
    ),
    disconnectHost: vi.fn<ProjectRegistryPort['disconnectHost']>(() => {
      Object.assign(remoteHost, { connectionState: 'disconnected' })
      return Promise.resolve({
        ...connected.host,
        connectionState: 'disconnected' as const,
      })
    }),
    browseHost: vi.fn<ProjectRegistryPort['browseHost']>(() =>
      Promise.resolve({ path: remoteRoot, directories: [] }),
    ),
    open: vi.fn<ProjectRegistryPort['open']>(() => Promise.resolve(state)),
    activate: vi.fn<ProjectRegistryPort['activate']>((projectId, workspaceId) => {
      const remote = projectId === 'project-1'
      active = {
        host: remote ? remoteHost : localHost,
        root: remote ? remoteRoot : localRoot,
        projectId,
        workspaceId,
      }
      state = projectState(projectId)
      return Promise.resolve(state)
    }),
    closeProject: vi.fn<ProjectRegistryPort['closeProject']>(() => {
      active = {
        host: localHost,
        root: localRoot,
        projectId: 'project-2',
        workspaceId: 'workspace-2',
      }
      state = { ...projectState('project-2'), projects: projectState().projects.slice(1) }
      return Promise.resolve(state)
    }),
    dismissWorkspace: vi.fn<ProjectRegistryPort['dismissWorkspace']>(() =>
      Promise.resolve(state),
    ),
    acknowledgeWorkspace: vi.fn<ProjectRegistryPort['acknowledgeWorkspace']>(() =>
      Promise.resolve(state),
    ),
  }
  let serializeCalls = 0
  const workspaces: ProjectWorkspacePort = {
    serialize: <T>(operation: () => Promise<T>): Promise<T> => {
      serializeCalls++
      return operation()
    },
    refresh: vi.fn<ProjectWorkspacePort['refresh']>(() => Promise.resolve(state)),
    replaceWatch: vi.fn<ProjectWorkspacePort['replaceWatch']>(() => Promise.resolve()),
    invalidateProject: vi.fn(),
    settleProject: vi.fn<ProjectWorkspacePort['settleProject']>(() => Promise.resolve()),
  }
  const cleanup: ProjectCleanupPort = {
    revokeWorkspace: vi.fn<ProjectCleanupPort['revokeWorkspace']>(() =>
      Promise.resolve(),
    ),
    closeWorkspace: vi.fn<ProjectCleanupPort['closeWorkspace']>(() => Promise.resolve()),
    forgetWorkspaceSessions: vi.fn<ProjectCleanupPort['forgetWorkspaceSessions']>(() =>
      Promise.resolve(),
    ),
  }
  const errors: string[] = []
  const hostDiagnostics: Array<{
    operation: 'connect' | 'disconnect'
    hostKind: 'local' | 'ssh'
  }> = []
  const coordinator = new ProjectCoordinator({
    registry,
    workspaces,
    cleanup,
    onError: (message) => errors.push(message),
    onHostControlDiagnostic: (event) => hostDiagnostics.push(event),
  })
  return {
    coordinator,
    registry,
    workspaces,
    cleanup,
    remoteHost,
    get active() {
      return active
    },
    get serializeCalls() {
      return serializeCalls
    },
    errors,
    hostDiagnostics,
  }
}

describe('ProjectCoordinator', () => {
  it('opens through one serialized transition and installs the discovered watch', async () => {
    const result = fixture()
    const { coordinator, registry, workspaces } = result

    await coordinator.openProject('dev', '/project')

    expect(result.serializeCalls).toBe(1)
    expect(registry.open).toHaveBeenCalledWith('dev', '/project')
    expect(workspaces.refresh).toHaveBeenCalledWith('project-1')
    expect(vi.mocked(workspaces.replaceWatch).mock.calls).toEqual([
      [],
      [expect.objectContaining({ root: remoteRoot })],
    ])
  })

  it('reconnects the active host, replaces its watch, and refreshes only that host', async () => {
    const { coordinator, registry, workspaces } = fixture()

    await coordinator.connectHost('dev')

    expect(registry.connectHost).toHaveBeenCalledWith('dev')
    expect(workspaces.replaceWatch).toHaveBeenCalledWith(
      expect.objectContaining({ root: remoteRoot }),
    )
    expect(workspaces.refresh).toHaveBeenCalledTimes(1)
    expect(workspaces.refresh).toHaveBeenCalledWith('project-1')
  })

  it('switches workspaces and atomically replaces the active watch', async () => {
    const { coordinator, registry, workspaces } = fixture()

    await coordinator.switchWorkspace('project-2', 'workspace-2')

    expect(registry.activate).toHaveBeenCalledWith('project-2', 'workspace-2')
    expect(workspaces.replaceWatch).toHaveBeenCalledWith(
      expect.objectContaining({ root: localRoot, projectId: 'project-2' }),
    )
  })

  it('disconnects after stale work settles and revokes host-qualified workspaces', async () => {
    const { coordinator, registry, workspaces, cleanup } = fixture()

    await coordinator.disconnectHost('dev')

    expect(workspaces.replaceWatch).toHaveBeenCalledWith()
    expect(registry.disconnectHost).toHaveBeenCalledWith('dev')
    expect(cleanup.revokeWorkspace).toHaveBeenCalledWith(remoteRoot)
    expect(cleanup.revokeWorkspace).toHaveBeenCalledWith(remoteOtherRoot)
  })

  it('reports closed host-control diagnostics while preserving connect failures', async () => {
    const { coordinator, registry, hostDiagnostics } = fixture()
    vi.mocked(registry.connectHost).mockRejectedValueOnce(
      new Error('ssh password TOKEN=hvir-private rejected'),
    )

    await expect(coordinator.connectHost('dev')).rejects.toThrow('TOKEN=hvir-private')
    expect(hostDiagnostics).toEqual([{ operation: 'connect', hostKind: 'ssh' }])
    expect(JSON.stringify(hostDiagnostics)).not.toContain('TOKEN')
  })

  it('reports disconnect control failure separately from cleanup', async () => {
    const { coordinator, registry, hostDiagnostics } = fixture()
    vi.mocked(registry.disconnectHost).mockRejectedValueOnce(
      new Error('remote control failed'),
    )

    await expect(coordinator.disconnectHost('dev')).rejects.toThrow(
      'remote control failed',
    )
    expect(hostDiagnostics).toEqual([{ operation: 'disconnect', hostKind: 'ssh' }])
  })

  it('closes one project, cleans its resources, and watches the fallback project', async () => {
    const { coordinator, registry, workspaces, cleanup } = fixture()

    await coordinator.closeProject('project-1')

    expect(registry.closeProject).toHaveBeenCalledWith('project-1')
    expect(cleanup.closeWorkspace).toHaveBeenCalledWith(remoteRoot)
    expect(cleanup.closeWorkspace).toHaveBeenCalledWith(remoteOtherRoot)
    expect(vi.mocked(workspaces.replaceWatch).mock.calls).toEqual([
      [],
      [expect.objectContaining({ root: localRoot, projectId: 'project-2' })],
    ])
  })

  it('forgets recovery state before dismissing a missing workspace', async () => {
    const { coordinator, registry, cleanup } = fixture()

    await coordinator.dismissWorkspace('project-1', 'workspace-missing')

    expect(cleanup.forgetWorkspaceSessions).toHaveBeenCalledWith(remoteOtherRoot)
    expect(registry.dismissWorkspace).toHaveBeenCalledWith(
      'project-1',
      'workspace-missing',
    )
  })

  it('rejects a delayed connect after a newer switch and leaks no stale watch', async () => {
    const { coordinator, registry, workspaces } = fixture()
    let finishConnect: (() => void) | undefined
    vi.mocked(registry.connectHost).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishConnect = () =>
            resolve({
              host: {
                hostId: 'dev',
                label: 'dev',
                kind: 'ssh',
                connectionState: 'connected',
                watchTier: 'polling',
              },
              suggestedPath: '/project',
            })
        }),
    )
    const connect = coordinator.connectHost('dev')
    await vi.waitFor(() => expect(finishConnect).toBeTypeOf('function'))
    const switched = coordinator.switchWorkspace('project-2', 'workspace-2')
    finishConnect?.()

    await expect(connect).rejects.toThrow('superseded')
    await switched
    expect(workspaces.refresh).not.toHaveBeenCalled()
    expect(workspaces.replaceWatch).toHaveBeenCalledTimes(1)
  })

  it('cancels a transition superseded while stale refreshes are settling', async () => {
    const { coordinator, registry, workspaces } = fixture()
    let finishSettlement: (() => void) | undefined
    vi.mocked(workspaces.settleProject).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSettlement = resolve
        }),
    )
    const opening = coordinator.openProject('dev', '/project')
    await vi.waitFor(() => expect(finishSettlement).toBeTypeOf('function'))
    const switched = coordinator.switchWorkspace('project-2', 'workspace-2')
    finishSettlement?.()

    await expect(opening).rejects.toThrow('superseded')
    await switched
    expect(registry.open).not.toHaveBeenCalled()
    expect(registry.activate).toHaveBeenCalledWith('project-2', 'workspace-2')
  })

  it('rejects a browse result completed after a lifecycle transition', async () => {
    const { coordinator, registry } = fixture()
    let finishBrowse: (() => void) | undefined
    vi.mocked(registry.browseHost).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishBrowse = () => resolve({ path: remoteRoot, directories: [] })
        }),
    )
    const browse = coordinator.browseHost('dev', '/project')
    const switched = coordinator.switchWorkspace('project-2', 'workspace-2')
    finishBrowse?.()

    await expect(browse).rejects.toThrow('superseded')
    await switched
  })

  it('recovers from watch replacement failure on the next transition', async () => {
    const { coordinator, workspaces } = fixture()
    vi.mocked(workspaces.replaceWatch).mockRejectedValueOnce(new Error('watch failed'))

    await expect(coordinator.openProject('dev', '/project')).rejects.toThrow(
      'watch failed',
    )
    await expect(
      coordinator.switchWorkspace('project-2', 'workspace-2'),
    ).resolves.toMatchObject({ activeProjectId: 'project-2' })
  })
})
