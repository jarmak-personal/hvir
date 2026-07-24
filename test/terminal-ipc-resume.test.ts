import { describe, expect, it, vi } from 'vitest'

import { providerTemplateProfiles } from '../src/main/harness/harness-profile-store'
import { registerTerminalIpc } from '../src/main/ipc/features/terminal'
import type { IpcInvokeContext, IpcRegistrar } from '../src/main/ipc/authority-router'
import type { ProjectHost } from '../src/main/project-host'
import type { RecordTerminalReplacement } from '../src/main/terminal/session-registry'
import {
  LOCAL_HOST_ID,
  asHostId,
  hostPath,
  type HostPath,
  type StartPtyRequest,
  type StartPtyResponse,
} from '../src/shared'

const HARNESS_SESSION_ID = '05ea41ff-026f-4ab6-b930-64eb3b497806'

describe('terminal exact-resume IPC', () => {
  it.each([
    ['local', LOCAL_HOST_ID],
    ['SSH', asHostId('ssh-resume-test')],
  ])(
    'returns typed unavailability without allocating resources on a %s ProjectHost',
    async (_kind, hostId) => {
      const fixture = resumeFixture(hostId, 'missing')

      const result = await fixture.start(fixture.request, fixture.context)

      expect(result).toEqual({
        outcome: 'resume-unavailable',
        reason: 'artifact-missing',
      })
      expect(fixture.authorizeResume).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'terminal-1',
          harnessSessionId: HARNESS_SESSION_ID,
          workspaceRoot: fixture.root,
          cwd: fixture.root,
        }),
      )
      expect(fixture.exec).toHaveBeenNthCalledWith(
        1,
        'sh',
        expect.any(Array),
        expect.objectContaining({
          cwd: fixture.root,
          env: { CLAUDE_CONFIG_DIR: '/config/claude' },
        }),
      )
      expect(fixture.exec).toHaveBeenNthCalledWith(
        2,
        'sh',
        expect.arrayContaining([
          '/config/claude/projects',
          '/config/claude/projects/-repo',
          `/config/claude/projects/-repo/${HARNESS_SESSION_ID}.jsonl`,
        ]),
        expect.objectContaining({
          signal: fixture.exec.mock.calls[0]?.[2]?.signal,
        }),
      )
      expect(fixture.register).not.toHaveBeenCalled()
      expect(fixture.spawn).not.toHaveBeenCalled()
      expect(fixture.recordSpawn).not.toHaveBeenCalled()
    },
  )

  it('spawns the exact Claude resume after a non-empty artifact is verified', async () => {
    const fixture = resumeFixture(LOCAL_HOST_ID, 'available')

    const result = await fixture.start(fixture.request, fixture.context)

    expect(result).toEqual({
      outcome: 'started',
      id: 'terminal-1',
      pid: 4321,
      resumed: true,
      harnessSessionId: HARNESS_SESSION_ID,
      identityStatus: 'identified',
      capabilities: {
        sessionIdentity: 'preassigned',
        exactResume: true,
        contextPresentation: 'count',
      },
    })
    expect(fixture.spawn).toHaveBeenCalledOnce()
    expect(fixture.recordSuccessfulLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        host: fixture.host,
        projectRoot: fixture.root,
        workspaceRoot: fixture.root,
        profiles: [fixture.profile],
      }),
      fixture.profile,
      expect.objectContaining({ exactResume: true }),
    )
    expect(fixture.spawn.mock.calls[0]?.[0]).toMatchObject({
      launchSpec: {
        file: 'claude',
        args: ['--resume', HARNESS_SESSION_ID],
      },
      resume: true,
      harnessSessionId: HARNESS_SESSION_ID,
      cwd: fixture.root,
      workspaceRoot: fixture.root,
    })
    expect(fixture.register).toHaveBeenCalledOnce()
    expect(fixture.recordSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'terminal-1',
        harnessSessionId: HARNESS_SESSION_ID,
        cwd: fixture.root,
        workspaceRoot: fixture.root,
      }),
    )
  })

  it('keeps one renderer forwarding lease until the supervised PTY exits', async () => {
    const fixture = resumeFixture(asHostId('ssh-control-reconnect'), 'available')

    await fixture.start(fixture.request, fixture.context)
    const handlers = fixture.attach.mock.calls[0]?.[2]
    if (!handlers) throw new Error('Expected the renderer PTY forwarding attachment')

    handlers.onData?.('output during control reconnect')
    expect(fixture.send).toHaveBeenCalledWith('pty:data', {
      id: 'terminal-1',
      data: 'output during control reconnect',
    })
    expect(fixture.spawn).toHaveBeenCalledOnce()
    expect(fixture.register).toHaveBeenCalledOnce()
    expect(fixture.lease.release).not.toHaveBeenCalled()

    handlers.onExit?.({ exitCode: 255, signal: undefined })
    expect(fixture.lease.release).toHaveBeenCalledOnce()
    expect(fixture.send).toHaveBeenCalledWith('pty:exit', {
      id: 'terminal-1',
      exitCode: 255,
      signal: undefined,
    })
  })

  it.each([
    ['local', LOCAL_HOST_ID],
    ['SSH', asHostId('ssh-replacement-test')],
  ])(
    'commits an intentional fresh replacement with new identities on a %s ProjectHost',
    async (_kind, hostId) => {
      const fixture = resumeFixture(hostId, 'missing')
      const request: StartPtyRequest = {
        ...fixture.request,
        sessionId: 'terminal-2',
        replacesSessionId: 'terminal-1',
        resume: false,
        harnessSessionId: undefined,
      }

      const result = await fixture.start(request, fixture.context)

      expect(result).toMatchObject({
        outcome: 'started',
        id: 'terminal-2',
        resumed: false,
        harnessSessionId: 'terminal-2',
      })
      expect(fixture.authorizeReplacement).toHaveBeenCalledWith({
        replacedId: 'terminal-1',
        replacementId: 'terminal-2',
        providerId: 'claude-code',
        profileId: request.profileId,
        launchRevision: request.launchRevision,
        workspaceRoot: fixture.root,
        cwd: fixture.root,
      })
      expect(fixture.spawn.mock.calls[0]?.[0]).toMatchObject({
        sessionId: 'terminal-2',
        launchSpec: {
          file: 'claude',
          args: ['--session-id', 'terminal-2'],
        },
        resume: false,
        harnessSessionId: undefined,
      })
      expect(fixture.recordReplacement).toHaveBeenCalledOnce()
      expect(fixture.recordReplacement.mock.calls[0]?.[0]).toMatchObject({
        replacedId: 'terminal-1',
        spawn: {
          id: 'terminal-2',
          harnessSessionId: 'terminal-2',
        },
      })
      expect(fixture.recordSpawn).not.toHaveBeenCalled()
    },
  )

  it('keeps the source record and disposes the fresh PTY when replacement persistence fails', async () => {
    const fixture = resumeFixture(LOCAL_HOST_ID, 'missing')
    fixture.recordReplacement.mockRejectedValueOnce(new Error('disk unavailable'))

    await expect(
      fixture.start(
        {
          ...fixture.request,
          sessionId: 'terminal-2',
          replacesSessionId: 'terminal-1',
          resume: false,
          harnessSessionId: undefined,
        },
        fixture.context,
      ),
    ).rejects.toThrow('disk unavailable')

    expect(fixture.recordSpawn).not.toHaveBeenCalled()
    expect(fixture.lease.dispose).toHaveBeenCalledOnce()
  })

  it('contains a classified fresh-launch failure without retaining resources', async () => {
    const fixture = resumeFixture(LOCAL_HOST_ID, 'missing')
    fixture.spawn.mockRejectedValueOnce(new Error('spawn ENOENT'))

    await expect(
      fixture.start(
        {
          ...fixture.request,
          resume: false,
          harnessSessionId: undefined,
        },
        fixture.context,
      ),
    ).rejects.toThrow('spawn ENOENT')

    expect(fixture.lease.dispose).toHaveBeenCalledOnce()
    expect(fixture.recordSpawn).not.toHaveBeenCalled()
    expect(fixture.recordSuccessfulLaunch).not.toHaveBeenCalled()
    expect(fixture.invalidateProbe).toHaveBeenCalledWith(fixture.host, fixture.profile)
    expect(fixture.probeProfiles).toHaveBeenCalledWith(
      expect.objectContaining({
        host: fixture.host,
        profiles: [fixture.profile],
        force: true,
      }),
    )
  })

  it('refuses a disconnected fresh launch before allocating a renderer lease', async () => {
    const fixture = resumeFixture(asHostId('ssh-disconnected-launch'), 'missing')
    Object.assign(fixture.host, { connectionState: 'disconnected' })
    fixture.defaultShell.mockRejectedValueOnce(new Error('SSH host is disconnected'))

    await expect(
      fixture.start(
        {
          ...fixture.request,
          resume: false,
          harnessSessionId: undefined,
        },
        fixture.context,
      ),
    ).rejects.toThrow('SSH host is disconnected')

    expect(fixture.register).not.toHaveBeenCalled()
    expect(fixture.spawn).not.toHaveBeenCalled()
    expect(fixture.recordSpawn).not.toHaveBeenCalled()
  })
})

function resumeFixture(
  hostId: HostPath['hostId'],
  availability: 'available' | 'missing',
) {
  const root = hostPath(hostId, '/repo')
  const profile = {
    ...providerTemplateProfiles().find(
      (candidate) => candidate.providerId === 'claude-code',
    )!,
    environment: [
      {
        kind: 'literal' as const,
        name: 'CLAUDE_CONFIG_DIR',
        value: '/config/claude',
      },
    ],
    risk: 'unclassified' as const,
  }
  const exec = vi
    .fn<ProjectHost['exec']>()
    .mockResolvedValueOnce({
      code: 0,
      signal: null,
      stdout: `${root.path}\n\0/config/claude`,
      stderr: '',
    })
    .mockResolvedValueOnce({
      code: 0,
      signal: null,
      stdout: availability,
      stderr: '',
    })
  const defaultShell = vi.fn(() => Promise.resolve('/bin/sh'))
  const host = {
    hostId,
    connectionState: 'connected',
    watchTier: hostId === LOCAL_HOST_ID ? 'native' : 'polling',
    defaultShell,
    realpath: vi.fn((path) => Promise.resolve(path)),
    exec,
  } as unknown as ProjectHost
  const authorizeResume = vi.fn(() => true)
  const authorizeReplacement = vi.fn(() => true)
  const recordSpawn = vi.fn(() => Promise.resolve())
  const recordReplacement = vi.fn((_replacement: RecordTerminalReplacement) =>
    Promise.resolve(),
  )
  const lease = { dispose: vi.fn(() => Promise.resolve()), release: vi.fn() }
  const register = vi.fn(() => lease)
  const managed = {
    id: 'terminal-1',
    pid: 4321,
    resumed: true,
    harnessSessionId: HARNESS_SESSION_ID,
    identityStatus: 'identified' as const,
    capabilities: {
      sessionIdentity: 'preassigned' as const,
      exactResume: true,
      contextPresentation: 'count' as const,
    },
  }
  const spawn = vi.fn((request: { sessionId: string; resume: boolean }) =>
    Promise.resolve(
      request.resume
        ? managed
        : {
            ...managed,
            id: request.sessionId,
            resumed: false,
            harnessSessionId: request.sessionId,
          },
    ),
  )
  const handlers = new Map<
    string,
    (request: unknown, context: IpcInvokeContext) => unknown
  >()
  const ipc = {
    authority: {
      workspaceRoot: vi.fn((path: HostPath): HostPath => path),
      projectRoot: vi.fn(() => root),
    },
    handle: (
      channel: string,
      handler: (request: unknown, context: IpcInvokeContext) => unknown,
    ) => handlers.set(channel, handler),
    handleSend: vi.fn(),
  } as unknown as IpcRegistrar
  const attach = vi.fn(
    (
      _id: string,
      _ownerId: number,
      _handlers: {
        onData?: (data: string) => void
        onExit?: (exit: { exitCode: number; signal?: number }) => void
      },
      _ownerGeneration?: number,
    ) =>
      () =>
        undefined,
  )
  const invalidateProbe = vi.fn()
  const probeProfiles = vi.fn()
  const recordSuccessfulLaunch = vi.fn()
  const deps = {
    getProject: () => ({ root, host }),
    terminalSessions: {
      authorizeResume,
      authorizeReplacement,
      recordSpawn,
      recordReplacement,
    },
    harnessProfiles: {
      get: () => profile,
      hasPathGrant: () => false,
    },
    harnessProbes: {
      invalidate: invalidateProbe,
      probeProfiles,
      recordSuccessfulLaunch,
    },
    rendererResources: {
      register,
      assertCurrent: vi.fn(),
      isCurrent: vi.fn(() => true),
    },
    ptySupervisor: {
      spawn,
      attach,
      disposeSession: vi.fn(),
    },
    terminalMoves: {
      plan: vi.fn(),
      move: vi.fn(),
    },
  } as unknown as Parameters<typeof registerTerminalIpc>[1]
  registerTerminalIpc(ipc, deps)
  const start = handlers.get('pty:start') as (
    request: StartPtyRequest,
    context: IpcInvokeContext,
  ) => Promise<StartPtyResponse>
  const request: StartPtyRequest = {
    sessionId: 'terminal-1',
    profileId: profile.id,
    launchRevision: profile.launchRevision,
    cwd: root,
    cols: 80,
    rows: 24,
    title: 'Retained conversation',
    position: 0,
    active: true,
    composerSubmitMode: 'enter',
    resume: true,
    harnessSessionId: HARNESS_SESSION_ID,
    acknowledgeRisk: true,
  }
  const send = vi.fn()
  const context = {
    owner: () => ({ id: 7, generation: 1 }),
    authority: ipc.authority,
    sender: { isDestroyed: () => false, send },
  } as unknown as IpcInvokeContext
  return {
    root,
    host,
    profile,
    exec,
    defaultShell,
    authorizeResume,
    authorizeReplacement,
    recordSpawn,
    recordReplacement,
    lease,
    register,
    spawn,
    attach,
    invalidateProbe,
    probeProfiles,
    recordSuccessfulLaunch,
    send,
    start,
    request,
    context,
  }
}
