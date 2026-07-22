import { describe, expect, it, vi } from 'vitest'

import { providerTemplateProfiles } from '../src/main/harness/harness-profile-store'
import { registerTerminalIpc } from '../src/main/ipc/features/terminal'
import type { IpcInvokeContext, IpcRegistrar } from '../src/main/ipc/authority-router'
import type { ProjectHost } from '../src/main/project-host'
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
  const host = {
    hostId,
    connectionState: 'connected',
    watchTier: hostId === LOCAL_HOST_ID ? 'native' : 'polling',
    defaultShell: vi.fn(() => Promise.resolve('/bin/sh')),
    realpath: vi.fn((path) => Promise.resolve(path)),
    exec,
  } as unknown as ProjectHost
  const authorizeResume = vi.fn(() => true)
  const recordSpawn = vi.fn(() => Promise.resolve())
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
  const spawn = vi.fn((_request: unknown) => Promise.resolve(managed))
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
  const deps = {
    getProject: () => ({ root, host }),
    terminalSessions: { authorizeResume, recordSpawn },
    harnessProfiles: {
      get: () => profile,
      hasPathGrant: () => false,
    },
    harnessProbes: {
      invalidate: vi.fn(),
      probeProfiles: vi.fn(),
    },
    rendererResources: {
      register,
      assertCurrent: vi.fn(),
      isCurrent: vi.fn(() => true),
    },
    ptySupervisor: {
      spawn,
      attach: vi.fn(() => () => undefined),
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
  const context = {
    owner: () => ({ id: 7, generation: 1 }),
    authority: ipc.authority,
    sender: { isDestroyed: () => false, send: vi.fn() },
  } as unknown as IpcInvokeContext
  return {
    root,
    exec,
    authorizeResume,
    recordSpawn,
    register,
    spawn,
    start,
    request,
    context,
  }
}
