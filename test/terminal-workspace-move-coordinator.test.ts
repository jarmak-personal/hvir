import { describe, expect, it, vi } from 'vitest'

import {
  TerminalWorkspaceMoveCoordinator,
  type TerminalWorkspaceMoveCoordinatorOptions,
} from '../src/main/terminal/terminal-workspace-move-coordinator'
import {
  asHarnessProfileId,
  asHarnessProviderId,
  hostPathEquals,
  localPath,
  type HostPath,
  type ProjectState,
  type TerminalRecoverySession,
  type WorkspaceState,
} from '../src/shared'

const OWNER = { id: 7, generation: 3 }
const SOURCE_ROOT = localPath('/repo')
const TARGET_ROOT = localPath('/repo-feature')
const SOURCE_ID = 'workspace:local:/repo'
const TARGET_ID = 'workspace:local:/repo-feature'

interface FixtureOptions {
  readonly activationFails?: boolean
  readonly persistenceFails?: boolean
  readonly resourceMoveFails?: boolean
  readonly targetMissing?: boolean
  readonly webPaneCleanupFails?: boolean
}

function createFixture(settings: FixtureOptions = {}) {
  const source: WorkspaceState = {
    id: SOURCE_ID,
    root: SOURCE_ROOT,
    name: 'main',
    branch: 'main',
    main: true,
    missing: false,
    repository: true,
    changedFiles: 0,
  }
  const target: WorkspaceState = {
    id: TARGET_ID,
    root: TARGET_ROOT,
    name: 'feature',
    branch: 'feature',
    main: false,
    missing: settings.targetMissing === true,
    repository: true,
    changedFiles: 0,
    newlyDiscovered: true,
  }
  let state: ProjectState = {
    root: SOURCE_ROOT,
    connectionState: 'connected',
    watchTier: 'native',
    activeProjectId: 'project-1',
    activeWorkspaceId: SOURCE_ID,
    projects: [
      {
        id: 'project-1',
        registeredRoot: SOURCE_ROOT,
        displayName: 'repo',
        connectionState: 'connected',
        watchTier: 'native',
        activeWorkspaceId: SOURCE_ID,
        workspaces: [source, target],
      },
    ],
  }
  const recovery: TerminalRecoverySession = {
    id: 'terminal-1',
    providerId: asHarnessProviderId('codex'),
    profileId: asHarnessProfileId('codex-default'),
    launchRevision: 1,
    harnessSessionId: '019ab123-4567-7890-abcd-ef0123456789',
    hostId: 'local',
    cwd: SOURCE_ROOT,
    title: 'Investigate #140',
    position: 0,
    active: true,
    updatedAt: 1,
  }
  let sessionRoot: HostPath = SOURCE_ROOT
  let ptyRoot: HostPath = SOURCE_ROOT
  let resourceRoot: HostPath = SOURCE_ROOT
  let paneIds: readonly string[] = ['web-a', 'web-b']
  const events: string[] = []

  const sessions = {
    get: vi.fn((id: string) =>
      id === recovery.id ? { ...recovery, workspaceRoot: sessionRoot } : undefined,
    ),
    move: vi.fn((request: { id: string; sourceRoot: HostPath; targetRoot: HostPath }) => {
      events.push(`session:${request.sourceRoot.path}->${request.targetRoot.path}`)
      if (settings.persistenceFails && hostPathEquals(request.sourceRoot, SOURCE_ROOT)) {
        throw new Error('disk unavailable')
      }
      if (!hostPathEquals(sessionRoot, request.sourceRoot)) {
        throw new Error('stale session source')
      }
      sessionRoot = request.targetRoot
      return Promise.resolve(recovery)
    }),
  }
  const ptys = {
    get: vi.fn((id: string) =>
      id === recovery.id
        ? {
            ownerId: OWNER.id,
            ownerGeneration: OWNER.generation,
            workspaceRoot: ptyRoot,
          }
        : undefined,
    ),
    reassignWorkspace: vi.fn(
      (_id: string, _ownerId: number, sourceRoot: HostPath, targetRoot: HostPath) => {
        events.push(`pty:${sourceRoot.path}->${targetRoot.path}`)
        if (!hostPathEquals(ptyRoot, sourceRoot)) throw new Error('stale PTY source')
        ptyRoot = targetRoot
      },
    ),
  }
  const resources = {
    reassignWorkspaceResource: vi.fn(
      (
        _owner: typeof OWNER,
        _type: 'pty-session',
        _id: string,
        sourceRoot: HostPath,
        targetRoot: HostPath,
      ) => {
        events.push(`resource:${sourceRoot.path}->${targetRoot.path}`)
        if (settings.resourceMoveFails && hostPathEquals(sourceRoot, SOURCE_ROOT)) {
          throw new Error('resource unavailable')
        }
        if (!hostPathEquals(resourceRoot, sourceRoot)) {
          throw new Error('stale resource source')
        }
        resourceRoot = targetRoot
      },
    ),
    disposeResource: vi.fn((_owner, _type, id: string) => {
      events.push(`dispose:${id}`)
      if (settings.webPaneCleanupFails) {
        return Promise.reject(new Error('web cleanup unavailable'))
      }
      return Promise.resolve(true)
    }),
  }
  const releaseTerminalBlock = vi.fn()
  const webPanes = {
    blockTerminalMove: vi.fn(
      (
        _terminalId: string,
        _ownerId: number,
        _ownerGeneration: number,
        _workspaceRoot: HostPath,
        expectedPaneIds: readonly string[],
      ) => {
        if (
          paneIds.length !== expectedPaneIds.length ||
          paneIds.some((paneId) => !expectedPaneIds.includes(paneId))
        ) {
          throw new Error('Web pane authority changed; review the move again')
        }
        return releaseTerminalBlock
      },
    ),
    paneIdsForTerminal: vi.fn(() => paneIds),
    hasPendingForTerminal: vi.fn(() => false),
    closeTerminal: vi.fn(() => {
      events.push('web:close')
      return Promise.resolve()
    }),
  }
  const projects = {
    active: { projectId: 'project-1', workspaceId: SOURCE_ID },
    state: vi.fn(() => state),
    projectById: vi.fn((id: string) =>
      state.projects.find((project) => project.id === id),
    ),
    activate: vi.fn((_projectId: string, workspaceId: string) => {
      events.push(`activate:${workspaceId}`)
      if (settings.activationFails) {
        return Promise.reject(new Error('activation unavailable'))
      }
      state = {
        ...state,
        root: TARGET_ROOT,
        activeWorkspaceId: workspaceId,
        projects: state.projects.map((project) => ({
          ...project,
          activeWorkspaceId: workspaceId,
          workspaces: project.workspaces.map((workspace) =>
            workspace.id === workspaceId
              ? { ...workspace, newlyDiscovered: false }
              : workspace,
          ),
        })),
      }
      return Promise.resolve(state)
    }),
  }
  const replaceWatch = vi.fn(() => Promise.resolve())
  const workspaces: TerminalWorkspaceMoveCoordinatorOptions['workspaces'] = {
    serialize: <T>(operation: () => Promise<T>) => operation(),
    replaceWatch,
  }
  const options: TerminalWorkspaceMoveCoordinatorOptions = {
    projects,
    workspaces,
    sessions,
    ptys,
    resources,
    webPanes,
  }

  return {
    coordinator: new TerminalWorkspaceMoveCoordinator(options),
    events,
    projects,
    ptys,
    resources,
    sessions,
    webPanes,
    workspaces,
    replaceWatch,
    releaseTerminalBlock,
    roots: () => ({ sessionRoot, ptyRoot, resourceRoot }),
    setPaneIds: (next: readonly string[]) => {
      paneIds = next
    },
  }
}

const request = {
  terminalId: 'terminal-1',
  sourceWorkspaceId: SOURCE_ID,
  targetWorkspaceId: TARGET_ID,
}

describe('TerminalWorkspaceMoveCoordinator', () => {
  it('plans and commits one transaction before closing dependent web panes', async () => {
    const fixture = createFixture()
    expect(fixture.coordinator.plan(request, OWNER)).toMatchObject({
      terminalTitle: 'Investigate #140',
      sourceWorkspaceName: 'main',
      targetWorkspaceName: 'feature',
      webPaneIds: ['web-a', 'web-b'],
    })

    const result = await fixture.coordinator.move(
      { ...request, expectedWebPaneIds: ['web-b', 'web-a'] },
      OWNER,
    )

    expect(result).toMatchObject({
      workspaceRoot: TARGET_ROOT,
      state: { activeWorkspaceId: TARGET_ID },
    })
    expect(fixture.roots()).toEqual({
      sessionRoot: TARGET_ROOT,
      ptyRoot: TARGET_ROOT,
      resourceRoot: TARGET_ROOT,
    })
    expect(fixture.events).toEqual([
      'session:/repo->/repo-feature',
      'dispose:web-a',
      'dispose:web-b',
      'web:close',
      'pty:/repo->/repo-feature',
      'resource:/repo->/repo-feature',
      `activate:${TARGET_ID}`,
    ])
    expect(fixture.projects.activate).toHaveBeenCalledWith('project-1', TARGET_ID, {
      emit: false,
    })
    expect(fixture.replaceWatch).toHaveBeenCalledOnce()
    expect(fixture.releaseTerminalBlock).toHaveBeenCalledOnce()
  })

  it('fails closed if pane authority changes after confirmation', async () => {
    const fixture = createFixture()
    expect(fixture.coordinator.plan(request, OWNER).webPaneIds).toEqual([
      'web-a',
      'web-b',
    ])
    fixture.setPaneIds(['web-c'])

    await expect(
      fixture.coordinator.move(
        { ...request, expectedWebPaneIds: ['web-a', 'web-b'] },
        OWNER,
      ),
    ).rejects.toThrow('Web pane authority changed')
    expect(fixture.sessions.move).not.toHaveBeenCalled()
    expect(fixture.roots()).toEqual({
      sessionRoot: SOURCE_ROOT,
      ptyRoot: SOURCE_ROOT,
      resourceRoot: SOURCE_ROOT,
    })
  })

  it('rolls all ownership back when workspace activation fails', async () => {
    const fixture = createFixture({ activationFails: true })

    await expect(
      fixture.coordinator.move(
        { ...request, expectedWebPaneIds: ['web-a', 'web-b'] },
        OWNER,
      ),
    ).rejects.toThrow('activation unavailable')
    expect(fixture.roots()).toEqual({
      sessionRoot: SOURCE_ROOT,
      ptyRoot: SOURCE_ROOT,
      resourceRoot: SOURCE_ROOT,
    })
    expect(fixture.resources.disposeResource).toHaveBeenCalledTimes(2)
    expect(fixture.webPanes.closeTerminal).toHaveBeenCalledOnce()
  })

  it('rolls the PTY and persisted session back after a partial live move', async () => {
    const fixture = createFixture({ resourceMoveFails: true })

    await expect(
      fixture.coordinator.move(
        { ...request, expectedWebPaneIds: ['web-a', 'web-b'] },
        OWNER,
      ),
    ).rejects.toThrow('resource unavailable')
    expect(fixture.roots()).toEqual({
      sessionRoot: SOURCE_ROOT,
      ptyRoot: SOURCE_ROOT,
      resourceRoot: SOURCE_ROOT,
    })
    expect(fixture.projects.activate).not.toHaveBeenCalled()
  })

  it('rolls persistence back before touching the PTY when web cleanup fails', async () => {
    const fixture = createFixture({ webPaneCleanupFails: true })

    await expect(
      fixture.coordinator.move(
        { ...request, expectedWebPaneIds: ['web-a', 'web-b'] },
        OWNER,
      ),
    ).rejects.toThrow('web cleanup unavailable')
    expect(fixture.roots()).toEqual({
      sessionRoot: SOURCE_ROOT,
      ptyRoot: SOURCE_ROOT,
      resourceRoot: SOURCE_ROOT,
    })
    expect(fixture.ptys.reassignWorkspace).not.toHaveBeenCalled()
    expect(fixture.projects.activate).not.toHaveBeenCalled()
  })

  it('does not mutate live ownership when persistence fails', async () => {
    const fixture = createFixture({ persistenceFails: true })

    await expect(
      fixture.coordinator.move(
        { ...request, expectedWebPaneIds: ['web-a', 'web-b'] },
        OWNER,
      ),
    ).rejects.toThrow('disk unavailable')
    expect(fixture.ptys.reassignWorkspace).not.toHaveBeenCalled()
    expect(fixture.resources.reassignWorkspaceResource).not.toHaveBeenCalled()
  })

  it('rejects stale targets and stale renderer generations during planning', () => {
    const missing = createFixture({ targetMissing: true })
    expect(() => missing.coordinator.plan(request, OWNER)).toThrow(
      'Target worktree is no longer present',
    )

    const staleOwner = createFixture()
    expect(() =>
      staleOwner.coordinator.plan(request, { ...OWNER, generation: 4 }),
    ).toThrow('Terminal is no longer live')
  })
})
