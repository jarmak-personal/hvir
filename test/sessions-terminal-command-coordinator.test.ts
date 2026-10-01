import { describe, expect, it, vi } from 'vitest'
import {
  builtInProfiles,
  providerTemplateProfiles,
} from '../src/main/harness/harness-profile-store'
import { harnessProviderCatalog } from '../src/main/harness/harness-provider'
import { SessionsTerminalCommandCoordinator } from '../src/renderer/src/terminal/sessions-terminal-command-coordinator'
import {
  asHostId,
  asSessionsProjectHandle,
  asSessionsWorkspaceHandle,
  asSessionsTerminalHandle,
  asSessionsPtyHandle,
  asHarnessProviderId,
  hostPath,
  sessionsWorkspaceQualifier,
  SESSIONS_PROJECTION_VERSION,
  type HvirApi,
  type ProjectState,
  type SessionsProjectionRow,
  type SessionsProjectionSnapshot,
  type TerminalMovePlan,
} from '../src/shared'

function fixture(hostId = 'local', profile = builtInProfiles()[0]!) {
  const root = hostPath(asHostId(hostId), '/repo')
  const worktree = hostPath(asHostId(hostId), '/repo-feature')
  let state: ProjectState = {
    revision: 1,
    root: worktree,
    connectionState: 'connected',
    watchTier: 'native',
    activeProjectId: 'project',
    activeWorkspaceId: 'feature',
    projects: [
      {
        id: 'project',
        registeredRoot: root,
        displayName: 'Repo',
        connectionState: 'connected',
        watchTier: 'native',
        activeWorkspaceId: 'feature',
        workspaces: [
          {
            id: 'root',
            root,
            name: 'root',
            main: false,
            closed: false,
            missing: false,
            repository: true,
            changedFiles: 0,
          },
          {
            id: 'feature',
            root: worktree,
            name: 'feature',
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
  const unsupported = { status: 'unsupported' as const }
  const row: SessionsProjectionRow = {
    handle: asSessionsTerminalHandle('exact-terminal'),
    project: { id: asSessionsProjectHandle('project-opaque'), name: 'Repo' },
    workspace: {
      id: asSessionsWorkspaceHandle('workspace-feature'),
      name: 'feature',
      main: true,
      qualifier: sessionsWorkspaceQualifier(1, 0, 1),
    },
    host: {
      id: hostId,
      label: hostId,
      kind: hostId === 'local' ? 'local' : 'ssh',
      connectionState: 'connected',
    },
    provider: { id: asHarnessProviderId('plain-shell'), name: 'Shell', kind: 'shell' },
    profile: unsupported,
    title: 'Shell',
    lifecycle: 'live',
    connectionState: 'connected',
    attention: unsupported,
    working: unsupported,
    model: unsupported,
    context: unsupported,
    turn: unsupported,
    telemetryFreshness: unsupported,
    usage: unsupported,
    livePty: {
      handle: asSessionsPtyHandle('exact-instance'),
      rendererOwnerId: 4,
      rendererGeneration: 2,
    },
  }
  let snapshot: SessionsProjectionSnapshot = {
    version: SESSIONS_PROJECTION_VERSION,
    demandGeneration: 1,
    revision: 1,
    sourceRevision: 1,
    status: 'available',
    rows: [row],
    workspaces: state.projects[0]!.workspaces.map((workspace, index) => ({
      projectId: row.project.id,
      projectName: 'Repo',
      workspaceId: asSessionsWorkspaceHandle(`workspace-${workspace.id}`),
      qualifier: sessionsWorkspaceQualifier(1, 0, index),
      workspaceName: workspace.name,
      main: workspace.main,
      closed: false,
      missing: false,
      host: row.host,
    })),
  }
  const plan: TerminalMovePlan = {
    terminalId: row.handle,
    terminalTitle: row.title,
    sourceProjectId: 'project',
    sourceWorkspaceId: 'feature',
    sourceWorkspaceName: 'feature',
    sourceRoot: worktree,
    targetWorkspaceId: 'root',
    targetWorkspaceName: 'root',
    targetRoot: root,
    webPaneIds: ['web-pane'],
  }
  const invoke = vi.fn((channel: string, request: unknown): Promise<unknown> => {
    if (channel === 'harness:profiles') return Promise.resolve([profile])
    if (channel === 'harness:catalog') return Promise.resolve(harnessProviderCatalog())
    if (channel === 'harness:probe-profiles') return Promise.resolve([])
    if (channel === 'project:switch') {
      const target = request as { workspaceId: string }
      return Promise.resolve({
        ok: true,
        value: { ...state, activeWorkspaceId: target.workspaceId, root },
      })
    }
    if (channel === 'sessions:open')
      return Promise.resolve({
        outcome: 'opened',
        state,
        handle: row.handle,
        workspaceQualifier: row.workspace.qualifier,
        livePty: row.livePty,
      })
    if (channel === 'terminal:plan-move')
      return Promise.resolve({ ok: true, value: plan })
    if (channel === 'terminal:move')
      return Promise.resolve({
        ok: true,
        value: { state: { ...state, activeWorkspaceId: 'root' }, workspaceRoot: root },
      })
    throw new Error(`Unexpected channel ${channel}`)
  })
  const launchSession = vi.fn(() => 'new-terminal')
  const prepare = vi.fn(() => Promise.resolve())
  const release = vi.fn()
  const complete = vi.fn()
  const commands = new SessionsTerminalCommandCoordinator({
    api: { invoke } as unknown as Pick<HvirApi, 'invoke'>,
    state: () => state,
    snapshot: () => snapshot,
    accept: (next) => {
      state = next
    },
    prepare,
    release,
    complete,
    controller: () => ({
      launchSession,
      hasSession: () => true,
      selectSession: () => true,
      transferOut: () => undefined,
      transferIn: () => undefined,
    }),
  })
  return {
    commands,
    root,
    profile,
    row,
    plan,
    invoke,
    prepare,
    release,
    launchSession,
    complete,
    snapshot: () => snapshot,
    state: () => state,
    setState: (next: ProjectState) => {
      state = next
    },
    setSnapshot: (next: SessionsProjectionSnapshot) => {
      snapshot = next
    },
  }
}

describe('Sessions explicit terminal commands', () => {
  it.each(['local', 'ssh-fixture'])(
    'reads %s root choices without selecting, materializing, or spawning, then launches exactly once in the registered root',
    async (hostId) => {
      const f = fixture(hostId)
      const signal = new AbortController().signal
      const choices = await f.commands.launchChoices(
        f.row.project.id,
        f.snapshot(),
        signal,
      )
      expect(f.prepare).not.toHaveBeenCalled()
      expect(f.launchSession).not.toHaveBeenCalled()
      expect(f.invoke).not.toHaveBeenCalledWith('project:switch', expect.anything())
      expect(f.invoke).toHaveBeenCalledWith('harness:profiles', { root: f.root })
      await expect(choices.start(f.profile, signal)).resolves.toBe('new-terminal')
      expect(f.invoke).toHaveBeenCalledWith('project:switch', {
        projectId: 'project',
        workspaceId: 'root',
      })
      expect(f.prepare).toHaveBeenCalledExactlyOnceWith('root', true, signal)
      expect(f.launchSession).toHaveBeenCalledExactlyOnceWith(
        f.profile.id,
        f.profile.launchRevision,
      )
      expect(f.release).toHaveBeenCalledExactlyOnceWith('root')
    },
  )

  it.each(['closed', 'missing'] as const)('withholds a %s move target', (condition) => {
    const f = fixture()
    f.setState({
      ...f.state(),
      projects: f.state().projects.map((project) => ({
        ...project,
        workspaces: project.workspaces.map((workspace) =>
          workspace.id === 'root' ? { ...workspace, [condition]: true } : workspace,
        ),
      })),
    })
    expect(f.commands.moveChoices(f.row, f.snapshot())).toEqual([])
    expect(f.prepare).not.toHaveBeenCalled()
  })

  it('cancellation after choices starts no process or workspace selection', async () => {
    const f = fixture()
    const controller = new AbortController()
    const choices = await f.commands.launchChoices(
      f.row.project.id,
      f.snapshot(),
      controller.signal,
    )
    controller.abort()
    await expect(choices.start(f.profile, controller.signal)).rejects.toThrow()
    expect(f.prepare).not.toHaveBeenCalled()
    expect(f.launchSession).not.toHaveBeenCalled()
    expect(f.invoke).not.toHaveBeenCalledWith('project:switch', expect.anything())
  })

  it.each(['missing', 'closed', 'disconnected', 'stale'])(
    'rejects a %s root selection visibly',
    async (kind) => {
      const f = fixture()
      const snapshot = f.snapshot()
      if (kind === 'stale') f.setState({ ...f.state(), revision: 2 })
      else
        f.setState({
          ...f.state(),
          projects: f.state().projects.map((project) => ({
            ...project,
            connectionState: kind === 'disconnected' ? 'disconnected' : 'connected',
            workspaces: project.workspaces.map((workspace) =>
              workspace.id === 'root'
                ? { ...workspace, closed: kind === 'closed', missing: kind === 'missing' }
                : workspace,
            ),
          })),
        })
      await expect(
        f.commands.launchChoices(
          f.row.project.id,
          snapshot,
          new AbortController().signal,
        ),
      ).rejects.toThrow()
      expect(f.launchSession).not.toHaveBeenCalled()
    },
  )

  it('rejects a changed launch revision and a removed profile', async () => {
    const f = fixture()
    const choices = await f.commands.launchChoices(
      f.row.project.id,
      f.snapshot(),
      new AbortController().signal,
    )
    await expect(
      choices.start({ ...f.profile, launchRevision: 99 }, new AbortController().signal),
    ).rejects.toThrow('changed or is unavailable')
    f.invoke.mockImplementation(() => Promise.resolve([]))
    await expect(choices.start(f.profile, new AbortController().signal)).rejects.toThrow(
      'changed or is unavailable',
    )
    expect(f.launchSession).not.toHaveBeenCalled()
  })

  it.each(['unchecked', 'stale', 'failed'])(
    'delegates a configured profile with an advisory %s probe to the existing launch owner',
    async (availability) => {
      const profile = { ...providerTemplateProfiles()[0]!, builtIn: false }
      const f = fixture('local', profile)
      const normal = f.invoke.getMockImplementation()!
      f.invoke.mockImplementation((channel, request) =>
        channel === 'harness:probe-profiles'
          ? Promise.resolve(
              availability === 'unchecked'
                ? []
                : [
                    {
                      providerId: profile.providerId,
                      profileId: profile.id,
                      launchRevision: profile.launchRevision,
                      hostId: f.root.hostId,
                      status: availability === 'stale' ? 'available' : 'timeout',
                      checkedAt: 1,
                      expiresAt: availability === 'stale' ? 2 : Date.now() + 60_000,
                      capabilities: harnessProviderCatalog().find(
                        (provider) => provider.id === profile.providerId,
                      )!.capabilities,
                    },
                  ],
            )
          : normal(channel, request),
      )
      const signal = new AbortController().signal
      const choices = await f.commands.launchChoices(
        f.row.project.id,
        f.snapshot(),
        signal,
      )
      await expect(choices.start(profile, signal)).resolves.toBe('new-terminal')
      expect(f.launchSession).toHaveBeenCalledExactlyOnceWith(
        profile.id,
        profile.launchRevision,
      )
    },
  )

  it.each(['local', 'ssh-fixture'])(
    'targets the exact %s session and reuses main move authorization and web-pane confirmation',
    async (hostId) => {
      const f = fixture(hostId)
      const signal = new AbortController().signal
      const plan = await f.commands.planMove(f.row, f.snapshot(), 'root', signal)
      expect(plan.webPaneIds).toEqual(['web-pane'])
      expect(f.complete).not.toHaveBeenCalled()
      await f.commands.move(f.row, plan, signal)
      expect(f.invoke).toHaveBeenCalledWith(
        'sessions:open',
        expect.objectContaining({ handle: f.row.handle, livePty: f.row.livePty }),
      )
      expect(f.invoke).toHaveBeenCalledWith('terminal:move', {
        terminalId: f.row.handle,
        expectedInstanceId: 'exact-instance',
        sourceWorkspaceId: 'feature',
        targetWorkspaceId: 'root',
        expectedWebPaneIds: ['web-pane'],
      })
      expect(f.complete).toHaveBeenCalledExactlyOnceWith(
        f.row.handle,
        'feature',
        'root',
        expect.objectContaining({ workspaceRoot: f.root }),
      )
      expect(f.release).toHaveBeenCalledExactlyOnceWith('root')
    },
  )

  it('rejects a replaced live process before committing a confirmed move', async () => {
    const f = fixture()
    f.setSnapshot({
      ...f.snapshot(),
      rows: [
        {
          ...f.row,
          livePty: { ...f.row.livePty!, handle: asSessionsPtyHandle('replacement') },
        },
      ],
    })
    await expect(
      f.commands.move(f.row, f.plan, new AbortController().signal),
    ).rejects.toThrow('exact live session changed')
    expect(f.complete).not.toHaveBeenCalled()
    expect(f.invoke).not.toHaveBeenCalled()
  })

  it('rejects late planning completion after cancellation', async () => {
    const f = fixture()
    let finish!: (plan: { ok: boolean; value: TerminalMovePlan }) => void
    const normal = f.invoke.getMockImplementation()!
    f.invoke.mockImplementation((channel, request) =>
      channel === 'terminal:plan-move'
        ? new Promise((resolve) => {
            finish = resolve
          })
        : normal(channel, request),
    )
    const controller = new AbortController()
    const planning = f.commands.planMove(f.row, f.snapshot(), 'root', controller.signal)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    controller.abort()
    finish({ ok: true, value: f.plan })
    await expect(planning).rejects.toThrow()
    expect(f.complete).not.toHaveBeenCalled()
  })

  it('reconciles an already committed move after the requesting UI departs', async () => {
    const f = fixture()
    const controller = new AbortController()
    const normal = f.invoke.getMockImplementation()!
    f.invoke.mockImplementation(async (channel, request) => {
      const result = await normal(channel, request)
      if (channel === 'terminal:move') controller.abort()
      return result
    })
    await f.commands.move(f.row, f.plan, controller.signal)
    expect(f.complete).toHaveBeenCalledOnce()
    expect(f.release).toHaveBeenCalledOnce()
  })
})
