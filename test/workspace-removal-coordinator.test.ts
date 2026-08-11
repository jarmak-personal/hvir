import { describe, expect, it } from 'vitest'

import { WorkspaceRemovalCoordinator } from '../src/main/workspace-removal-coordinator'
import {
  asHostId,
  hostPath,
  localPath,
  type HostPath,
  type ProjectState,
} from '../src/shared'

const roots: readonly [string, HostPath][] = [
  ['local', localPath('/repo/removed')],
  ['SSH', hostPath(asHostId('dev'), '/repo/removed')],
]

describe('WorkspaceRemovalCoordinator', () => {
  it.each(roots)(
    'removes a missing %s workspace after releasing its resources in lifecycle order',
    async (_kind, root) => {
      const calls: string[] = []
      let state = projectState(root)
      const coordinator = new WorkspaceRemovalCoordinator(
        {
          state: () => state,
          projectById: (projectId) =>
            state.projects.find((project) => project.id === projectId),
          dismissWorkspace: (_projectId, workspaceId) => {
            calls.push('dismiss-catalog')
            state = {
              ...state,
              projects: state.projects.map((project) => ({
                ...project,
                workspaces: project.workspaces.filter(
                  (workspace) => workspace.id !== workspaceId,
                ),
              })),
            }
            return Promise.resolve(state)
          },
        },
        {
          forgetWorkspaceSessions: (candidate) => {
            expect(candidate).toEqual(root)
            calls.push('forget-sessions')
            return Promise.resolve()
          },
          revokeWorkspace: (candidate) => {
            expect(candidate).toEqual(root)
            calls.push('revoke-workspace')
            return Promise.resolve()
          },
          closeWorkspaceWebPanes: (candidate) => {
            expect(candidate).toEqual(root)
            calls.push('close-web-panes')
            return Promise.resolve()
          },
          releaseHtmlPreviews: (candidate) => {
            expect(candidate).toEqual(root)
            calls.push('release-html-previews')
          },
        },
      )

      const result = await coordinator.removeMissingWorkspace(
        'project-1',
        'workspace-removed',
      )

      expect(result).toBe(state)
      expect(calls).toEqual([
        'forget-sessions',
        'dismiss-catalog',
        'revoke-workspace',
        'close-web-panes',
        'release-html-previews',
      ])
      expect(state.projects[0]?.workspaces).toEqual([])
    },
  )

  it('does not release a present workspace', async () => {
    const root = localPath('/repo/present')
    const state = projectState(root, false)
    const coordinator = new WorkspaceRemovalCoordinator(
      {
        state: () => state,
        projectById: () => state.projects[0],
        dismissWorkspace: () => Promise.resolve(state),
      },
      {
        forgetWorkspaceSessions: () => Promise.resolve(),
        revokeWorkspace: () => Promise.resolve(),
        closeWorkspaceWebPanes: () => Promise.resolve(),
        releaseHtmlPreviews: () => undefined,
      },
    )

    await expect(
      coordinator.removeMissingWorkspace('project-1', 'workspace-removed'),
    ).rejects.toThrow('Only removed worktrees can be dismissed')
  })

  it('treats a workspace removed by a concurrent caller as complete', async () => {
    const root = localPath('/repo/removed')
    const initial = projectState(root)
    const state = {
      ...initial,
      projects: initial.projects.map((project) => ({
        ...project,
        workspaces: [],
      })),
    }
    const coordinator = new WorkspaceRemovalCoordinator(
      {
        state: () => state,
        projectById: () => state.projects[0],
        dismissWorkspace: () => Promise.reject(new Error('must not dismiss twice')),
      },
      {
        forgetWorkspaceSessions: () => Promise.reject(new Error('must not forget twice')),
        revokeWorkspace: () => Promise.reject(new Error('must not revoke twice')),
        closeWorkspaceWebPanes: () => Promise.reject(new Error('must not close twice')),
        releaseHtmlPreviews: () => {
          throw new Error('must not release twice')
        },
      },
    )

    await expect(
      coordinator.removeMissingWorkspace('project-1', 'workspace-removed'),
    ).resolves.toBe(state)
  })
})

function projectState(root: HostPath, missing = true): ProjectState {
  return {
    revision: 0,
    root,
    connectionState: 'connected',
    watchTier: root.hostId === 'local' ? 'native' : 'polling',
    activeProjectId: 'project-1',
    activeWorkspaceId: 'workspace-removed',
    projects: [
      {
        id: 'project-1',
        registeredRoot: root,
        displayName: 'repo',
        connectionState: 'connected',
        watchTier: root.hostId === 'local' ? 'native' : 'polling',
        activeWorkspaceId: 'workspace-removed',
        workspaces: [
          {
            id: 'workspace-removed',
            root,
            name: 'removed',
            main: false,
            closed: false,
            missing,
            repository: true,
            changedFiles: 0,
          },
        ],
      },
    ],
  }
}
