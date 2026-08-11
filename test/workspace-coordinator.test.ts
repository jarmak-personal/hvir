/* eslint-disable @typescript-eslint/unbound-method -- assertions inspect typed Vitest port mocks */

import { describe, expect, it, vi } from 'vitest'

import type { ProjectHost } from '../src/main/project-host'
import {
  WorkspaceCoordinator,
  type WorkspaceRegistryPort,
  type WorkspaceWatchPort,
} from '../src/main/workspace-coordinator'
import {
  WORKSPACE_ACTIVITY_FIELDS,
  WORKSPACE_ACTIVITY_SCHEMA,
  WORKSPACE_ACTIVITY_STATUS_LIMIT,
  localPath,
  type ProjectState,
  type WorkspaceActivityResult,
  type WorktreeDiscovery,
} from '../src/shared'

const root = localPath('/project')
const staleRoot = localPath('/project-stale')
const otherStaleRoot = localPath('/project-other-stale')
const host = {
  hostId: root.hostId,
  connectionState: 'connected',
  watchTier: 'native',
} as unknown as ProjectHost

const discovered: WorktreeDiscovery = {
  repository: true,
  worktrees: [{ root, detached: false, bare: false }],
}

const workspaceActivity: WorkspaceActivityResult = {
  changedFiles: 3,
  status: {
    schema: WORKSPACE_ACTIVITY_SCHEMA,
    fields: WORKSPACE_ACTIVITY_FIELDS,
    statusLimit: WORKSPACE_ACTIVITY_STATUS_LIMIT,
    statusEntryCount: 3,
    statusTruncated: false,
    statusDigest: 'a'.repeat(64),
  },
}

function projectState(): ProjectState {
  return {
    revision: 0,
    root,
    connectionState: 'connected',
    watchTier: 'native',
    activeProjectId: 'project-1',
    activeWorkspaceId: 'workspace-1',
    projects: [
      {
        id: 'project-1',
        registeredRoot: root,
        displayName: 'project',
        connectionState: 'connected',
        watchTier: 'native',
        activeWorkspaceId: 'workspace-1',
        workspaces: [
          {
            id: 'workspace-1',
            root,
            name: 'project',
            main: true,
            closed: false,
            missing: false,
            repository: true,
            changedFiles: 0,
          },
        ],
      },
    ],
  }
}

function projectWithStaleWorkspace(
  missing: boolean,
  activeWorkspaceId = 'workspace-1',
): ProjectState['projects'][number] {
  const project = projectState().projects[0]!
  return {
    ...project,
    activeWorkspaceId,
    workspaces: [
      ...project.workspaces,
      {
        id: 'workspace-stale',
        root: staleRoot,
        name: 'project-stale',
        main: false,
        closed: false,
        missing,
        repository: true,
        changedFiles: 0,
      },
    ],
  }
}

function fixture() {
  let state = projectState()
  let active = {
    host,
    root,
    projectId: 'project-1',
    workspaceId: 'workspace-1',
  }
  const registry: WorkspaceRegistryPort = {
    get active() {
      return active
    },
    state: () => state,
    projectById: vi.fn((id) => state.projects.find((project) => project.id === id)),
    reconcileWorktrees: vi.fn((_id, discovery: WorktreeDiscovery) => {
      state = {
        ...state,
        projects: state.projects.map((project) => ({
          ...project,
          workspaces: discovery.worktrees.map((worktree) => ({
            id: 'workspace-1',
            root: worktree.root,
            name: 'project',
            main: true,
            closed: false,
            missing: false,
            repository: discovery.repository,
            changedFiles: 0,
          })),
        })),
      }
      return Promise.resolve(state)
    }),
    updateWorkspaceActivity: vi.fn(
      (_id, results: ReadonlyMap<string, WorkspaceActivityResult>) => {
        state = {
          ...state,
          projects: state.projects.map((project) => ({
            ...project,
            workspaces: project.workspaces.map((workspace) => ({
              ...workspace,
              changedFiles:
                results.get(workspace.id)?.changedFiles ?? workspace.changedFiles,
            })),
          })),
        }
        return Promise.resolve(state)
      },
    ),
  }
  const discovery = {
    discover: vi.fn<() => Promise<WorktreeDiscovery>>(() => Promise.resolve(discovered)),
    workspaceActivity: vi.fn(() => Promise.resolve(workspaceActivity)),
  }
  const removal = {
    removeMissingWorkspace: vi.fn((_projectId: string, workspaceId: string) => {
      if (active.workspaceId === workspaceId) {
        active = { ...active, root, workspaceId: 'workspace-1' }
      }
      return Promise.resolve(state)
    }),
  }
  const errors: string[] = []
  const watches: WorkspaceWatchPort[] = []
  const createWatch = vi.fn((target: WorkspaceWatchPort['target']) => {
    const watch: WorkspaceWatchPort = {
      target,
      updateInterests: vi.fn(),
      dispose: vi.fn(() => Promise.resolve()),
    }
    watches.push(watch)
    return watch
  })
  const coordinator = new WorkspaceCoordinator({
    registry,
    discovery,
    removal,
    emitWatch: vi.fn(),
    createWatch,
    onError: (message) => errors.push(message),
  })
  return {
    coordinator,
    registry,
    discovery,
    removal,
    watches,
    createWatch,
    errors,
    setActive: (nextRoot: typeof root, workspaceId: string) => {
      active = { ...active, root: nextRoot, workspaceId }
    },
  }
}

describe('WorkspaceCoordinator', () => {
  it('deduplicates refreshes and publishes discovery/counts once', async () => {
    const { coordinator, registry, discovery } = fixture()

    const first = coordinator.refresh('project-1')
    const second = coordinator.refresh('project-1')

    expect(second).toBe(first)
    await expect(first).resolves.toMatchObject({ activeProjectId: 'project-1' })
    expect(discovery.discover).toHaveBeenCalledOnce()
    expect(registry.reconcileWorktrees).toHaveBeenCalledOnce()
    expect(registry.updateWorkspaceActivity).toHaveBeenCalledOnce()
  })

  it('ignores a discovery result invalidated while it is in flight', async () => {
    const { coordinator, registry, discovery } = fixture()
    let finish: ((value: WorktreeDiscovery) => void) | undefined
    discovery.discover.mockImplementationOnce(
      () =>
        new Promise<WorktreeDiscovery>((resolve) => {
          finish = resolve
        }),
    )

    const refresh = coordinator.refresh('project-1')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    coordinator.invalidateProject('project-1')
    finish?.(discovered)
    await refresh

    expect(registry.reconcileWorktrees).not.toHaveBeenCalled()
    expect(registry.updateWorkspaceActivity).not.toHaveBeenCalled()
  })

  it('retries after refresh failure instead of caching rejection', async () => {
    const { coordinator, discovery, removal } = fixture()
    discovery.discover.mockRejectedValueOnce(new Error('temporary failure'))

    await expect(coordinator.refresh('project-1')).rejects.toThrow('temporary failure')
    expect(removal.removeMissingWorkspace).not.toHaveBeenCalled()
    await coordinator.refresh('project-1')

    expect(discovery.discover).toHaveBeenCalledTimes(2)
  })

  it.each([
    {
      name: 'Git reports it prunable',
      discovery: {
        repository: true,
        worktrees: [
          { root, detached: false, bare: false },
          {
            root: staleRoot,
            detached: true,
            bare: false,
            prunable: true,
            prunableReason: 'gitdir points to a missing location',
          },
        ],
      } satisfies WorktreeDiscovery,
    },
    {
      name: 'successful discovery omits it',
      discovery: discovered,
    },
  ])('removes a missing workspace when $name', async ({ discovery: result }) => {
    const { coordinator, registry, discovery, removal } = fixture()
    const presentProject = projectWithStaleWorkspace(false)
    const missingProject = projectWithStaleWorkspace(true)
    vi.mocked(registry.projectById)
      .mockReturnValueOnce(presentProject)
      .mockReturnValueOnce(missingProject)
      .mockReturnValue(projectState().projects[0])
    discovery.discover.mockResolvedValueOnce(result)

    await coordinator.refresh('project-1')

    expect(removal.removeMissingWorkspace).toHaveBeenCalledWith(
      'project-1',
      'workspace-stale',
    )
  })

  it('does not remove workspaces when discovery classifies the root as a plain directory', async () => {
    const { coordinator, discovery, removal } = fixture()
    discovery.discover.mockResolvedValueOnce({
      repository: false,
      worktrees: [{ root, detached: false, bare: false }],
    })

    await coordinator.refresh('project-1')

    expect(removal.removeMissingWorkspace).not.toHaveBeenCalled()
  })

  it('reports one removal failure and continues cleaning other missing workspaces', async () => {
    const { coordinator, registry, removal, errors } = fixture()
    const presentProject = projectWithStaleWorkspace(false)
    const missingBase = projectWithStaleWorkspace(true)
    const missingProject = {
      ...missingBase,
      workspaces: [
        ...missingBase.workspaces,
        {
          id: 'workspace-other-stale',
          root: otherStaleRoot,
          name: 'project-other-stale',
          main: false,
          closed: false,
          missing: true,
          repository: true,
          changedFiles: 0,
        },
      ],
    }
    vi.mocked(registry.projectById)
      .mockReturnValueOnce(presentProject)
      .mockReturnValueOnce(missingProject)
      .mockReturnValue(projectState().projects[0])
    vi.mocked(removal.removeMissingWorkspace).mockRejectedValueOnce(
      new Error('session cleanup failed'),
    )

    await coordinator.refresh('project-1')

    expect(vi.mocked(removal.removeMissingWorkspace).mock.calls).toEqual([
      ['project-1', 'workspace-stale'],
      ['project-1', 'workspace-other-stale'],
    ])
    expect(errors).toEqual(['[workspace] missing workspace removal failed for project-1'])
  })

  it('replaces the active watch after discovery removes the active workspace', async () => {
    const { coordinator, registry, removal, createWatch, setActive } = fixture()
    setActive(staleRoot, 'workspace-stale')
    vi.mocked(registry.projectById)
      .mockReturnValueOnce(projectWithStaleWorkspace(false, 'workspace-stale'))
      .mockReturnValueOnce(projectWithStaleWorkspace(true, 'workspace-stale'))
      .mockReturnValue(projectState().projects[0])

    await coordinator.refresh('project-1')

    expect(removal.removeMissingWorkspace).toHaveBeenCalledWith(
      'project-1',
      'workspace-stale',
    )
    expect(createWatch).toHaveBeenCalledWith(
      expect.objectContaining({ root, projectId: 'project-1' }),
      expect.any(Object),
    )
  })

  it('settles a started removal before an invalidating transition can continue', async () => {
    const { coordinator, registry, removal } = fixture()
    vi.mocked(registry.projectById)
      .mockReturnValueOnce(projectWithStaleWorkspace(false))
      .mockReturnValueOnce(projectWithStaleWorkspace(true))
      .mockReturnValue(projectState().projects[0])
    let finishRemoval: ((state: ProjectState) => void) | undefined
    vi.mocked(removal.removeMissingWorkspace).mockImplementationOnce(
      () =>
        new Promise<ProjectState>((resolve) => {
          finishRemoval = resolve
        }),
    )

    const refresh = coordinator.refresh('project-1')
    await vi.waitFor(() => expect(finishRemoval).toBeTypeOf('function'))
    coordinator.invalidateProject('project-1')
    let settled = false
    const settling = coordinator.settleProject('project-1', 'skip').then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    finishRemoval?.(projectState())
    await settling
    await refresh
    expect(settled).toBe(true)
  })

  it('retries after activity failure without publishing a partial refresh', async () => {
    const { coordinator, registry, discovery } = fixture()
    discovery.workspaceActivity.mockRejectedValueOnce(new Error('status unavailable'))

    await expect(coordinator.refresh('project-1')).rejects.toThrow('status unavailable')
    expect(registry.updateWorkspaceActivity).not.toHaveBeenCalled()
    await coordinator.refresh('project-1')

    expect(discovery.workspaceActivity).toHaveBeenCalledTimes(2)
    expect(registry.updateWorkspaceActivity).toHaveBeenCalledOnce()
  })

  it('drops activity that completes after the project generation is invalidated', async () => {
    const { coordinator, registry, discovery } = fixture()
    let finish: ((value: WorkspaceActivityResult) => void) | undefined
    discovery.workspaceActivity.mockImplementationOnce(
      () =>
        new Promise<WorkspaceActivityResult>((resolve) => {
          finish = resolve
        }),
    )

    const refresh = coordinator.refresh('project-1')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    coordinator.invalidateProject('project-1')
    finish?.(workspaceActivity)
    await refresh

    expect(registry.reconcileWorktrees).toHaveBeenCalledOnce()
    expect(registry.updateWorkspaceActivity).not.toHaveBeenCalled()
  })

  it('samples closed present workspaces through the existing activity refresh', async () => {
    const { coordinator, registry, discovery } = fixture()
    const initial = projectState()
    const closedState: ProjectState = {
      ...initial,
      projects: initial.projects.map((project) => ({
        ...project,
        workspaces: project.workspaces.map((workspace) => ({
          ...workspace,
          closed: true,
        })),
      })),
    }
    vi.mocked(registry.projectById).mockReturnValue(closedState.projects[0])
    vi.mocked(registry.reconcileWorktrees).mockResolvedValue(closedState)

    await coordinator.refresh('project-1')

    expect(discovery.workspaceActivity).toHaveBeenCalledWith(root, [root])
    expect(registry.updateWorkspaceActivity).toHaveBeenCalledOnce()
  })

  it('replaces watches without letting a slow prior disposal win', async () => {
    const { coordinator, watches } = fixture()
    await coordinator.replaceWatch({ host, root, projectId: 'first' })
    let finishDispose: (() => void) | undefined
    vi.mocked(watches[0]!.dispose).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishDispose = resolve
        }),
    )
    const second = coordinator.replaceWatch({ host, root, projectId: 'second' })
    const third = coordinator.replaceWatch({ host, root, projectId: 'third' })
    await third
    finishDispose?.()
    await second

    expect(watches.map((watch) => watch.target.projectId)).toEqual(['first', 'third'])
  })

  it('recovers deterministically after watch construction fails', async () => {
    const { coordinator, createWatch, watches } = fixture()
    createWatch.mockImplementationOnce(() => {
      throw new Error('watch construction failed')
    })

    await expect(
      coordinator.replaceWatch({ host, root, projectId: 'first' }),
    ).rejects.toThrow('watch construction failed')
    await coordinator.replaceWatch({ host, root, projectId: 'second' })

    expect(watches.map((watch) => watch.target.projectId)).toEqual(['second'])
  })

  it('deduplicates periodic discovery without sampling open workspace activity', async () => {
    vi.useFakeTimers()
    try {
      const { coordinator, discovery } = fixture()
      let finish: ((value: WorktreeDiscovery) => void) | undefined
      discovery.discover.mockImplementationOnce(
        () =>
          new Promise<WorktreeDiscovery>((resolve) => {
            finish = resolve
          }),
      )
      coordinator.startPolling(10)

      await vi.advanceTimersByTimeAsync(30)
      expect(discovery.discover).toHaveBeenCalledOnce()
      finish?.(discovered)
      coordinator.stopPolling()
      await vi.advanceTimersByTimeAsync(0)

      expect(discovery.workspaceActivity).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('suspends repeated passive status for a closed dirty workspace', async () => {
    vi.useFakeTimers()
    try {
      const { coordinator, registry, discovery } = fixture()
      const initial = projectState()
      const closedState: ProjectState = {
        ...initial,
        projects: initial.projects.map((project) => ({
          ...project,
          workspaces: project.workspaces.map((workspace) => ({
            ...workspace,
            closed: true,
          })),
        })),
      }
      vi.mocked(registry.projectById).mockReturnValue(closedState.projects[0])
      vi.mocked(registry.reconcileWorktrees).mockResolvedValue(closedState)
      coordinator.startPolling(10)

      await vi.advanceTimersByTimeAsync(40)
      coordinator.stopPolling()
      await vi.advanceTimersByTimeAsync(0)

      expect(discovery.discover.mock.calls.length).toBeGreaterThan(1)
      expect(discovery.workspaceActivity).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('continues sampling a clean closed workspace for later activity', async () => {
    vi.useFakeTimers()
    try {
      const { coordinator, registry, discovery } = fixture()
      const initial = projectState()
      const closedState: ProjectState = {
        ...initial,
        projects: initial.projects.map((project) => ({
          ...project,
          workspaces: project.workspaces.map((workspace) => ({
            ...workspace,
            closed: true,
          })),
        })),
      }
      vi.mocked(registry.projectById).mockReturnValue(closedState.projects[0])
      vi.mocked(registry.reconcileWorktrees).mockResolvedValue(closedState)
      discovery.workspaceActivity.mockResolvedValue({
        ...workspaceActivity,
        changedFiles: 0,
        status: {
          ...workspaceActivity.status!,
          statusEntryCount: 0,
          statusDigest: '0'.repeat(64),
        },
      })
      coordinator.startPolling(10)

      await vi.advanceTimersByTimeAsync(40)
      coordinator.stopPolling()
      await vi.advanceTimersByTimeAsync(0)

      expect(discovery.workspaceActivity.mock.calls.length).toBeGreaterThan(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not settle an activity refresh after its generation is invalidated', async () => {
    const { coordinator, discovery } = fixture()
    let finish: ((value: WorkspaceActivityResult) => void) | undefined
    discovery.workspaceActivity.mockImplementationOnce(
      () =>
        new Promise<WorkspaceActivityResult>((resolve) => {
          finish = resolve
        }),
    )
    const stale = coordinator.refresh('project-1')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))

    coordinator.invalidateProject('project-1')
    await coordinator.settleProject('project-1', 'skip')
    await expect(coordinator.refresh('project-1')).resolves.toMatchObject({
      activeProjectId: 'project-1',
    })

    expect(discovery.workspaceActivity).toHaveBeenCalledTimes(2)
    finish?.(workspaceActivity)
    await stale
  })

  it('still drains obsolete activity before a Git mutation', async () => {
    const { coordinator, discovery } = fixture()
    let finish: ((value: WorkspaceActivityResult) => void) | undefined
    discovery.workspaceActivity.mockImplementationOnce(
      () =>
        new Promise<WorkspaceActivityResult>((resolve) => {
          finish = resolve
        }),
    )
    const stale = coordinator.refresh('project-1')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    coordinator.invalidateProject('project-1')
    let settled = false
    const draining = coordinator.settleProject('project-1').then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(settled).toBe(false)
    finish?.(workspaceActivity)
    await Promise.all([stale, draining])
    expect(settled).toBe(true)
  })

  it('serializes transition operations at their behavioral boundary', async () => {
    const { coordinator } = fixture()
    const calls: string[] = []
    let finishFirst: (() => void) | undefined
    const first = coordinator.serialize(
      () =>
        new Promise<void>((resolve) => {
          calls.push('first')
          finishFirst = resolve
        }),
    )
    const second = coordinator.serialize(() => {
      calls.push('second')
      return Promise.resolve()
    })
    await vi.waitFor(() => expect(finishFirst).toBeTypeOf('function'))
    expect(calls).toEqual(['first'])
    finishFirst?.()
    await Promise.all([first, second])

    expect(calls).toEqual(['first', 'second'])
  })
})
