/* eslint-disable @typescript-eslint/unbound-method -- assertions inspect typed Vitest port mocks */

import { describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ProjectCoordinator,
  type ProjectCleanupPort,
  type ProjectHostControlPort,
  type ProjectRegistryPort,
  type ProjectWorkspacePort,
} from '../src/main/project-coordinator'
import { ProjectHostCatalog, type ProjectHost } from '../src/main/project-host'
import { ProjectRegistry } from '../src/main/project-registry'
import type { WorkspaceRemovalPort } from '../src/main/workspace-removal-coordinator'
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
    revision: 0,
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
            closed: false,
            missing: false,
            repository: true,
            changedFiles: 0,
          },
          {
            id: 'workspace-missing',
            root: remoteOtherRoot,
            name: 'project-worktree',
            main: false,
            closed: false,
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
            closed: false,
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
    connect: vi.fn(() => Promise.resolve()),
    exec: vi.fn<ProjectHost['exec']>(() =>
      Promise.resolve({ code: 0, signal: null, stdout: '/project\n', stderr: '' }),
    ),
    realpath: vi.fn<ProjectHost['realpath']>((path) => Promise.resolve(path)),
    stat: vi.fn<ProjectHost['stat']>(() =>
      Promise.resolve({ type: 'dir', size: 0, mtimeMs: 0, mode: 0o755 }),
    ),
    readdir: vi.fn<ProjectHost['readdir']>(() => Promise.resolve([])),
  } as unknown as ProjectHost
  const localHost = {
    hostId: localRoot.hostId,
    connectionState: 'connected',
    watchTier: 'native',
    connect: vi.fn(() => Promise.resolve()),
    exec: vi.fn<ProjectHost['exec']>(),
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
  const hosts: ProjectHostControlPort = {
    materializeHost: vi.fn<ProjectHostControlPort['materializeHost']>((id) =>
      Promise.resolve(id === 'local' ? localHost : remoteHost),
    ),
    hostById: (id) =>
      id === 'dev' ? remoteHost : id === 'local' ? localHost : undefined,
    listHosts: () => [
      connected.host,
      {
        hostId: 'local',
        label: 'Local',
        kind: 'local',
        connectionState: 'connected',
        watchTier: 'native',
      },
    ],
    disconnectHost: vi.fn<ProjectHostControlPort['disconnectHost']>(() => {
      Object.assign(remoteHost, { connectionState: 'disconnected' })
      return Promise.resolve({
        ...connected.host,
        connectionState: 'disconnected' as const,
      })
    }),
  }
  const registry: ProjectRegistryPort = {
    get active() {
      return active
    },
    state: () => state,
    projectById: (id) => state.projects.find((project) => project.id === id),
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
    closeWorkspace: vi.fn<ProjectRegistryPort['closeWorkspace']>(() =>
      Promise.resolve(state),
    ),
    restoreWorkspaceAfterFailedClose: vi.fn<
      ProjectRegistryPort['restoreWorkspaceAfterFailedClose']
    >(() => Promise.resolve(state)),
    reopenWorkspace: vi.fn<ProjectRegistryPort['reopenWorkspace']>(
      (projectId, workspaceId) => {
        const remote = projectId === 'project-1'
        active = {
          host: remote ? remoteHost : localHost,
          root: remote ? remoteRoot : localRoot,
          projectId,
          workspaceId,
        }
        state = projectState(projectId)
        return Promise.resolve(state)
      },
    ),
    acknowledgeWorkspace: vi.fn<ProjectRegistryPort['acknowledgeWorkspace']>(() =>
      Promise.resolve(state),
    ),
  }
  let serializeCalls = 0
  let serialized = Promise.resolve()
  const workspaces: ProjectWorkspacePort = {
    serialize: <T>(operation: () => Promise<T>): Promise<T> => {
      serializeCalls++
      const result = serialized.then(operation)
      serialized = result.then(
        () => undefined,
        () => undefined,
      )
      return result
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
    closeWorkspaceWebPanes: vi.fn<ProjectCleanupPort['closeWorkspaceWebPanes']>(() =>
      Promise.resolve(),
    ),
    workspaceTerminalIds: vi.fn<ProjectCleanupPort['workspaceTerminalIds']>(() => []),
    closeWorkspaceTerminals: vi.fn<ProjectCleanupPort['closeWorkspaceTerminals']>(),
    forgetWorkspaceSessions: vi.fn<ProjectCleanupPort['forgetWorkspaceSessions']>(() =>
      Promise.resolve(),
    ),
  }
  const removal: WorkspaceRemovalPort = {
    removeMissingWorkspace: vi.fn(() => Promise.resolve(state)),
  }
  const errors: string[] = []
  const hostDiagnostics: Array<{
    operation: 'connect' | 'disconnect'
    hostKind: 'local' | 'ssh'
  }> = []
  const coordinator = new ProjectCoordinator({
    registry,
    hosts,
    workspaces,
    cleanup,
    removal,
    onError: (message) => errors.push(message),
    onHostControlDiagnostic: (event) => hostDiagnostics.push(event),
  })
  return {
    coordinator,
    registry,
    hosts,
    workspaces,
    cleanup,
    removal,
    remoteHost,
    localHost,
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
  it('connects and browses through the real local catalog and filesystem', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hvir-coordinator-local-'))
    let catalog: ProjectHostCatalog | undefined
    let registry: ProjectRegistry | undefined
    try {
      await mkdir(join(root, 'zeta'))
      await mkdir(join(root, 'alpha'))
      await writeFile(join(root, 'file.txt'), 'not a directory')
      catalog = await ProjectHostCatalog.create({
        prompter: { prompt: () => Promise.resolve(undefined) },
        trustFile: localPath(join(root, 'known-hosts.json')),
        home: root,
        agentSocket: '',
      })
      registry = await ProjectRegistry.create(
        localPath(root),
        catalog,
        join(root, 'projects.json'),
        () => undefined,
      )
      const { workspaces, cleanup, removal } = fixture()
      const coordinator = new ProjectCoordinator({
        registry,
        hosts: catalog,
        workspaces,
        cleanup,
        removal,
      })
      const canonicalRoot = await realpath(root)

      await expect(coordinator.connectHost('local')).resolves.toMatchObject({
        host: { hostId: 'local', connectionState: 'connected' },
        suggestedPath: canonicalRoot,
      })
      await expect(coordinator.browseHost('local', root)).resolves.toEqual({
        path: localPath(canonicalRoot),
        directories: [
          { name: 'alpha', type: 'dir' },
          { name: 'zeta', type: 'dir' },
        ],
      })
      const missing = join(root, 'missing')
      await expect(coordinator.browseHost('local', missing)).rejects.toMatchObject({
        message: `Folder not found: ${missing}`,
        cause: { code: 'ENOENT' },
      })
    } finally {
      try {
        await registry?.dispose()
      } finally {
        try {
          await catalog?.dispose()
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      }
    }
  })

  it('suggests the active local root or local home without running a remote pwd', async () => {
    const { coordinator, localHost } = fixture()
    await expect(coordinator.connectHost('local')).resolves.toMatchObject({
      suggestedPath: homedir(),
      host: { hostId: 'local', connectionState: 'connected' },
    })
    await coordinator.switchWorkspace('project-2', 'workspace-2')
    await expect(coordinator.connectHost('local')).resolves.toMatchObject({
      suggestedPath: '/other',
    })
    expect(localHost.exec).not.toHaveBeenCalled()
  })

  it.each([
    { code: 0, stdout: '  /home/remote\n', expected: '/home/remote' },
    { code: 0, stdout: 'relative\n', expected: '/project' },
    { code: 0, stdout: '', expected: '/project' },
    { code: 1, stdout: '/ignored', expected: '/project' },
  ])(
    'preserves remote pwd suggestion rules for $code/$stdout',
    async ({ code, stdout, expected }) => {
      const { coordinator, remoteHost } = fixture()
      vi.mocked(remoteHost.exec).mockResolvedValueOnce({
        code,
        stdout,
        signal: null,
        stderr: '',
      })
      await expect(coordinator.connectHost('dev')).resolves.toMatchObject({
        suggestedPath: expected,
      })
      expect(remoteHost.exec).toHaveBeenCalledWith('pwd', [])
    },
  )

  it('falls back to the remote filesystem root when no project on that host is active', async () => {
    const { coordinator, remoteHost, workspaces } = fixture()
    await coordinator.switchWorkspace('project-2', 'workspace-2')
    vi.mocked(workspaces.replaceWatch).mockClear()
    vi.mocked(remoteHost.exec).mockResolvedValueOnce({
      code: 1,
      stdout: '',
      signal: null,
      stderr: '',
    })
    await expect(coordinator.connectHost('dev')).resolves.toMatchObject({
      suggestedPath: '/',
    })
    expect(workspaces.replaceWatch).not.toHaveBeenCalled()
    expect(workspaces.refresh).toHaveBeenCalledWith('project-1')
  })

  it('preserves materialization, pwd, and presentation lookup failures', async () => {
    const { coordinator, hosts, remoteHost, hostDiagnostics } = fixture()
    vi.mocked(hosts.materializeHost).mockRejectedValueOnce(
      new Error('Unknown SSH host alias: absent'),
    )
    await expect(coordinator.connectHost('absent')).rejects.toThrow(
      'Unknown SSH host alias: absent',
    )
    vi.mocked(remoteHost.exec).mockRejectedValueOnce(new Error('remote pwd failed'))
    await expect(coordinator.connectHost('dev')).rejects.toThrow('remote pwd failed')
    hosts.listHosts = () => []
    await expect(coordinator.connectHost('dev')).rejects.toThrow(
      'Unknown project host: dev',
    )
    expect(hostDiagnostics).toEqual(
      Array.from({ length: 3 }, () => ({ operation: 'connect', hostKind: 'ssh' })),
    )
  })

  it('browses canonical host-qualified directories in name order', async () => {
    const { coordinator, remoteHost } = fixture()
    vi.mocked(remoteHost.realpath).mockResolvedValueOnce(remoteRoot)
    vi.mocked(remoteHost.readdir).mockResolvedValueOnce([
      { name: 'zeta', type: 'dir' },
      { name: 'file.txt', type: 'file' },
      { name: 'linked-dir', type: 'symlink' },
      { name: 'alpha', type: 'dir' },
    ])
    await expect(coordinator.browseHost('dev', '/alias')).resolves.toEqual({
      path: remoteRoot,
      directories: [
        { name: 'alpha', type: 'dir' },
        { name: 'zeta', type: 'dir' },
      ],
    })
    expect(remoteHost.realpath).toHaveBeenCalledWith(hostPath(asHostId('dev'), '/alias'))
    expect(remoteHost.stat).toHaveBeenCalledWith(remoteRoot)
    expect(remoteHost.readdir).toHaveBeenCalledWith(remoteRoot)
  })

  it('rejects missing/disconnected hosts and relative paths before browsing', async () => {
    const { coordinator, remoteHost } = fixture()
    await expect(coordinator.browseHost('absent', '/')).rejects.toThrow(
      'Connect to absent before browsing folders',
    )
    await expect(coordinator.browseHost('dev', 'relative')).rejects.toThrow(
      'Folder path must be absolute',
    )
    Object.assign(remoteHost, { connectionState: 'disconnected' })
    await expect(coordinator.browseHost('dev', '/')).rejects.toThrow(
      'Connect to dev before browsing folders',
    )
    expect(remoteHost.realpath).not.toHaveBeenCalled()
  })

  it.each([
    [2, 'Folder not found'],
    ['ENOENT', 'Folder not found'],
    [3, 'Cannot access folder'],
    ['EACCES', 'Cannot access folder'],
  ])('maps browse error %s at the host boundary', async (code, message) => {
    const { coordinator, remoteHost } = fixture()
    const reason = Object.assign(new Error('host detail'), { code })
    vi.mocked(remoteHost.realpath).mockRejectedValueOnce(reason)
    await expect(coordinator.browseHost('dev', '/project')).rejects.toMatchObject({
      message: `${message}: /project`,
      cause: reason,
    })
  })

  it('rejects non-directories and preserves unmapped browse failures', async () => {
    const { coordinator, remoteHost } = fixture()
    vi.mocked(remoteHost.stat).mockResolvedValueOnce({
      type: 'file',
      size: 0,
      mtimeMs: 0,
      mode: 0o644,
    })
    await expect(coordinator.browseHost('dev', '/project')).rejects.toThrow(
      'Not a directory: /project',
    )
    expect(remoteHost.readdir).not.toHaveBeenCalled()
    const error = new Error('directory read failed')
    vi.mocked(remoteHost.readdir).mockRejectedValueOnce(error)
    await expect(coordinator.browseHost('dev', '/project')).rejects.toBe(error)
  })

  it('restores the active watch after disconnect or cleanup failure while the transition owns it', async () => {
    const { coordinator, hosts, cleanup, workspaces, hostDiagnostics } = fixture()
    vi.mocked(hosts.disconnectHost).mockRejectedValueOnce(new Error('disconnect failed'))
    await expect(coordinator.disconnectHost('dev')).rejects.toThrow('disconnect failed')
    expect(vi.mocked(workspaces.replaceWatch).mock.calls).toEqual([
      [],
      [expect.objectContaining({ root: remoteRoot })],
    ])
    vi.mocked(workspaces.replaceWatch).mockClear()
    vi.mocked(hosts.disconnectHost).mockClear()
    vi.mocked(cleanup.revokeWorkspace).mockRejectedValueOnce(new Error('cleanup failed'))
    await expect(coordinator.disconnectHost('dev')).rejects.toThrow('cleanup failed')
    expect(vi.mocked(workspaces.replaceWatch).mock.calls).toEqual([
      [],
      [expect.objectContaining({ root: remoteRoot })],
    ])
    expect(hosts.disconnectHost).not.toHaveBeenCalled()
    expect(hostDiagnostics).toEqual([{ operation: 'disconnect', hostKind: 'ssh' }])
  })

  it('does not restore a stale watch when disconnect is superseded during cleanup', async () => {
    const { coordinator, hosts, cleanup, workspaces } = fixture()
    let finish!: () => void
    vi.mocked(cleanup.revokeWorkspace).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const disconnect = coordinator.disconnectHost('dev')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const switchWorkspace = coordinator.switchWorkspace('project-2', 'workspace-2')
    finish()
    await expect(disconnect).rejects.toThrow('superseded')
    await switchWorkspace
    expect(hosts.disconnectHost).not.toHaveBeenCalled()
    expect(vi.mocked(workspaces.replaceWatch).mock.calls).toEqual([
      [],
      [expect.objectContaining({ root: localRoot })],
    ])
  })

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
    const { coordinator, hosts, remoteHost, workspaces } = fixture()

    await coordinator.connectHost('dev')

    expect(hosts.materializeHost).toHaveBeenCalledWith('dev')
    expect(remoteHost.connect).toHaveBeenCalledOnce()
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
    const { coordinator, hosts, workspaces, cleanup } = fixture()

    await coordinator.disconnectHost('dev')

    expect(workspaces.replaceWatch).toHaveBeenCalledWith()
    expect(hosts.disconnectHost).toHaveBeenCalledWith('dev')
    expect(cleanup.revokeWorkspace).toHaveBeenCalledWith(remoteRoot)
    expect(cleanup.revokeWorkspace).toHaveBeenCalledWith(remoteOtherRoot)
  })

  it('reports closed host-control diagnostics while preserving connect failures', async () => {
    const { coordinator, remoteHost, hostDiagnostics } = fixture()
    vi.mocked(remoteHost.connect).mockRejectedValueOnce(
      new Error('ssh password TOKEN=hvir-private rejected'),
    )

    await expect(coordinator.connectHost('dev')).rejects.toThrow('TOKEN=hvir-private')
    expect(hostDiagnostics).toEqual([{ operation: 'connect', hostKind: 'ssh' }])
    expect(JSON.stringify(hostDiagnostics)).not.toContain('TOKEN')
  })

  it('reports disconnect control failure separately from cleanup', async () => {
    const { coordinator, hosts, hostDiagnostics } = fixture()
    vi.mocked(hosts.disconnectHost).mockRejectedValueOnce(
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
    expect(cleanup.closeWorkspaceWebPanes).toHaveBeenCalledWith(remoteRoot)
    expect(cleanup.closeWorkspaceWebPanes).toHaveBeenCalledWith(remoteOtherRoot)
    expect(vi.mocked(workspaces.replaceWatch).mock.calls).toEqual([
      [],
      [expect.objectContaining({ root: localRoot, projectId: 'project-2' })],
    ])
  })

  it('requires an exact destructive terminal plan before closing workspace resources', async () => {
    const { coordinator, registry, cleanup } = fixture()
    vi.mocked(cleanup.workspaceTerminalIds).mockReturnValue([
      'terminal-1',
      'terminal-1',
      'terminal-2',
    ])

    expect(coordinator.planWorkspaceClose('project-2', 'workspace-2')).toEqual({
      terminalCount: 2,
    })
    await expect(
      coordinator.closeWorkspace('project-2', 'workspace-2', 1, true),
    ).rejects.toThrow('terminal count changed')
    await expect(
      coordinator.closeWorkspace('project-2', 'workspace-2', 2, false),
    ).rejects.toThrow('Confirm terminal termination')

    await coordinator.closeWorkspace('project-2', 'workspace-2', 2, true)

    expect(registry.closeWorkspace).toHaveBeenCalledWith('project-2', 'workspace-2')
    expect(cleanup.closeWorkspaceTerminals).toHaveBeenCalledWith(localRoot)
    expect(cleanup.forgetWorkspaceSessions).toHaveBeenCalledWith(localRoot)
    expect(cleanup.revokeWorkspace).toHaveBeenCalledWith(localRoot)
    expect(cleanup.closeWorkspaceWebPanes).toHaveBeenCalledWith(localRoot)
  })

  it('applies the same host-qualified close contract to an SSH workspace', async () => {
    const { coordinator, cleanup } = fixture()
    await coordinator.switchWorkspace('project-2', 'workspace-2')

    expect(coordinator.planWorkspaceClose('project-1', 'workspace-1')).toEqual({
      terminalCount: 0,
    })
    await coordinator.closeWorkspace('project-1', 'workspace-1', 0, false)

    expect(cleanup.closeWorkspaceTerminals).toHaveBeenCalledWith(remoteRoot)
    expect(cleanup.forgetWorkspaceSessions).toHaveBeenCalledWith(remoteRoot)
    expect(cleanup.revokeWorkspace).toHaveBeenCalledWith(remoteRoot)
    expect(cleanup.closeWorkspaceWebPanes).toHaveBeenCalledWith(remoteRoot)
  })

  it('restores an open catalog record when confirmed-close cleanup fails', async () => {
    const { coordinator, registry, cleanup } = fixture()
    vi.mocked(cleanup.revokeWorkspace).mockRejectedValueOnce(
      new Error('resource cleanup failed'),
    )

    await expect(
      coordinator.closeWorkspace('project-2', 'workspace-2', 0, false),
    ).rejects.toThrow('Workspace close cleanup failed')

    expect(registry.restoreWorkspaceAfterFailedClose).toHaveBeenCalledWith(
      'project-2',
      'workspace-2',
    )
    expect(cleanup.closeWorkspaceTerminals).toHaveBeenCalledWith(localRoot)
    expect(cleanup.forgetWorkspaceSessions).toHaveBeenCalledWith(localRoot)
    expect(cleanup.closeWorkspaceWebPanes).toHaveBeenCalledWith(localRoot)
  })

  it('never closes the active workspace and reopens a closed workspace through activation', async () => {
    const { coordinator, registry, workspaces } = fixture()

    expect(() => coordinator.planWorkspaceClose('project-1', 'workspace-1')).toThrow(
      'Select another workspace',
    )
    await coordinator.reopenWorkspace('project-2', 'workspace-2')

    expect(registry.reopenWorkspace).toHaveBeenCalledWith('project-2', 'workspace-2')
    expect(workspaces.replaceWatch).toHaveBeenCalledWith(
      expect.objectContaining({ root: localRoot }),
    )
  })

  it('dismisses a missing workspace through the shared removal lifecycle', async () => {
    const { coordinator, removal } = fixture()

    await coordinator.dismissWorkspace('project-1', 'workspace-missing')

    expect(removal.removeMissingWorkspace).toHaveBeenCalledWith(
      'project-1',
      'workspace-missing',
    )
  })

  it('rejects a delayed connect after a newer switch and leaks no stale watch', async () => {
    const { coordinator, remoteHost, workspaces } = fixture()
    let finishConnect: (() => void) | undefined
    vi.mocked(remoteHost.connect).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishConnect = resolve
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
    expect(workspaces.settleProject).toHaveBeenCalledWith(expect.any(String), 'skip')
    expect(registry.open).not.toHaveBeenCalled()
    expect(registry.activate).toHaveBeenCalledWith('project-2', 'workspace-2')
  })

  it('rejects a browse result completed after a lifecycle transition', async () => {
    const { coordinator, remoteHost } = fixture()
    let finishBrowse: (() => void) | undefined
    vi.mocked(remoteHost.realpath).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishBrowse = () => resolve(remoteRoot)
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
