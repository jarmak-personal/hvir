/* eslint-disable @typescript-eslint/unbound-method -- assertions inspect typed Vitest port mocks */

import { describe, expect, it, vi } from 'vitest'

import type { ProjectHost } from '../src/main/project-host'
import {
  WorkspaceCoordinator,
  type WorkspaceRegistryPort,
  type WorkspaceWatchPort,
} from '../src/main/workspace-coordinator'
import { localPath, type ProjectState, type WorktreeDiscovery } from '../src/shared'

const root = localPath('/project')
const host = {
  hostId: root.hostId,
  connectionState: 'connected',
  watchTier: 'native',
} as unknown as ProjectHost

const discovered: WorktreeDiscovery = {
  repository: true,
  worktrees: [{ root, detached: false, bare: false }],
}

function projectState(): ProjectState {
  return {
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
            missing: false,
            repository: true,
            changedFiles: 0,
          },
        ],
      },
    ],
  }
}

function fixture() {
  let state = projectState()
  const registry: WorkspaceRegistryPort = {
    active: {
      host,
      root,
      projectId: 'project-1',
      workspaceId: 'workspace-1',
    },
    state: () => state,
    projectById: (id) => state.projects.find((project) => project.id === id),
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
            missing: false,
            repository: discovery.repository,
            changedFiles: 0,
          })),
        })),
      }
      return Promise.resolve(state)
    }),
    updateChangedCounts: vi.fn((_id, counts: ReadonlyMap<string, number>) => {
      state = {
        ...state,
        projects: state.projects.map((project) => ({
          ...project,
          workspaces: project.workspaces.map((workspace) => ({
            ...workspace,
            changedFiles: counts.get(workspace.id) ?? workspace.changedFiles,
          })),
        })),
      }
      return Promise.resolve(state)
    }),
  }
  const discovery = {
    discover: vi.fn<() => Promise<WorktreeDiscovery>>(() => Promise.resolve(discovered)),
    changedFileCount: vi.fn(() => Promise.resolve(3)),
  }
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
    emitWatch: vi.fn(),
    createWatch,
  })
  return { coordinator, registry, discovery, watches, createWatch }
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
    expect(registry.updateChangedCounts).toHaveBeenCalledOnce()
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
    expect(registry.updateChangedCounts).not.toHaveBeenCalled()
  })

  it('retries after refresh failure instead of caching rejection', async () => {
    const { coordinator, discovery } = fixture()
    discovery.discover.mockRejectedValueOnce(new Error('temporary failure'))

    await expect(coordinator.refresh('project-1')).rejects.toThrow('temporary failure')
    await coordinator.refresh('project-1')

    expect(discovery.discover).toHaveBeenCalledTimes(2)
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

  it('deduplicates overlapping periodic refreshes', async () => {
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

      expect(discovery.changedFileCount).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
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
