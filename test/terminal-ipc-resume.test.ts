import { describe, expect, it, vi } from 'vitest'

import {
  harnessLaunchCapabilities,
  harnessProvider,
} from '../src/main/harness/harness-provider'
import { providerTemplateProfiles } from '../src/main/harness/harness-profile-store'
import { registerTerminalIpc } from '../src/main/ipc/features/terminal'
import type { IpcInvokeContext, IpcRegistrar } from '../src/main/ipc/authority-router'
import type { ProjectHost } from '../src/main/project-host'
import {
  PtyStartUnavailableError,
  type ManagedPty,
} from '../src/main/pty/pty-supervisor'
import type { RecordTerminalReplacement } from '../src/main/terminal/session-registry'
import {
  LOCAL_HOST_ID,
  asHarnessProfileId,
  asHostId,
  hostPath,
  type HostPath,
  type RebindTerminalProfileRequest,
  type StartPtyRequest,
  type StartPtyResponse,
  type TerminalRecoverySession,
} from '../src/shared'

const HARNESS_SESSION_ID = '05ea41ff-026f-4ab6-b930-64eb3b497806'

describe('terminal exact-resume IPC', () => {
  it('returns provider-neutral retryable launch unavailability without a PTY', async () => {
    const fixture = resumeFixture(LOCAL_HOST_ID, 'available')
    fixture.spawn.mockRejectedValueOnce(
      new PtyStartUnavailableError('identity-baseline-unavailable'),
    )

    const result = await fixture.start(
      {
        ...fixture.request,
        resume: false,
        harnessSessionId: undefined,
      },
      fixture.context,
    )

    expect(result).toEqual({
      outcome: 'launch-unavailable',
      reason: 'identity-baseline-unavailable',
      retryable: true,
    })
    expect(fixture.lease.dispose).toHaveBeenCalledOnce()
    expect(fixture.recordSpawn).not.toHaveBeenCalled()
    expect(fixture.recordSuccessfulLaunch).not.toHaveBeenCalled()
  })

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
      reattached: false,
      harnessSessionId: HARNESS_SESSION_ID,
      identityStatus: 'identified',
      capabilities: {
        sessionIdentity: 'preassigned',
        exactResume: true,
        contextPresentation: 'pressure',
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

  it.each([
    ['local', LOCAL_HOST_ID],
    ['SSH', asHostId('ssh-fork-test')],
  ])(
    'validates and launches an exact Claude fork through a %s ProjectHost',
    async (_kind, hostId) => {
      const fixture = resumeFixture(hostId, 'available')
      fixture.effectiveLaunchCapabilities.mockReturnValue({
        ...fixture.managed.capabilities,
        exactFork: true,
      })
      fixture.get.mockReturnValue(fixture.managed)
      const request: StartPtyRequest = {
        ...fixture.request,
        sessionId: 'terminal-2',
        launchMode: 'fork',
        resume: false,
        harnessSessionId: undefined,
        forkSourceSessionId: 'terminal-1',
        parentHarnessSessionId: HARNESS_SESSION_ID,
      }

      const result = await fixture.start(request, fixture.context)

      expect(result).toMatchObject({
        outcome: 'started',
        id: 'terminal-2',
        resumed: false,
        harnessSessionId: 'terminal-2',
      })
      expect(fixture.authorizeFork).toHaveBeenCalledWith({
        sourceId: 'terminal-1',
        childId: 'terminal-2',
        providerId: 'claude-code',
        profileId: request.profileId,
        launchRevision: request.launchRevision,
        parentHarnessSessionId: HARNESS_SESSION_ID,
        workspaceRoot: fixture.root,
        cwd: fixture.root,
      })
      expect(fixture.spawn.mock.calls[0]?.[0]).toMatchObject({
        launchMode: 'fork',
        parentHarnessSessionId: HARNESS_SESSION_ID,
        launchSpec: {
          file: 'claude',
          args: [
            '--session-id',
            'terminal-2',
            '--resume',
            HARNESS_SESSION_ID,
            '--fork-session',
          ],
        },
      })
      expect(fixture.recordSpawn).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'terminal-2', harnessSessionId: 'terminal-2' }),
      )
      expect(fixture.recordReplacement).not.toHaveBeenCalled()
    },
  )

  it('rejects an unregistered fork parent without allocating a PTY', async () => {
    const fixture = resumeFixture(LOCAL_HOST_ID, 'available')
    fixture.effectiveLaunchCapabilities.mockReturnValue({
      ...fixture.managed.capabilities,
      exactFork: true,
    })
    fixture.get.mockReturnValue(fixture.managed)
    fixture.authorizeFork.mockReturnValue(false)

    await expect(
      fixture.start(
        {
          ...fixture.request,
          sessionId: 'terminal-2',
          launchMode: 'fork',
          resume: false,
          harnessSessionId: undefined,
          forkSourceSessionId: 'terminal-1',
          parentHarnessSessionId: HARNESS_SESSION_ID,
        },
        fixture.context,
      ),
    ).rejects.toThrow(/fork is not authorized/)
    expect(fixture.spawn).not.toHaveBeenCalled()
    expect(fixture.register).not.toHaveBeenCalled()
  })

  it.each([
    ['local', LOCAL_HOST_ID],
    ['SSH', asHostId('ssh-diverged-fork-test')],
  ])(
    'rejects a %s fork after the main-owned source identity diverges',
    async (_kind, hostId) => {
      const fixture = resumeFixture(hostId, 'available')
      fixture.effectiveLaunchCapabilities.mockReturnValue({
        ...fixture.managed.capabilities,
        exactFork: true,
      })
      fixture.get.mockReturnValue({ ...fixture.managed, identityDiverged: true })

      await expect(
        fixture.start(
          {
            ...fixture.request,
            sessionId: 'terminal-2',
            launchMode: 'fork',
            resume: false,
            harnessSessionId: undefined,
            forkSourceSessionId: 'terminal-1',
            parentHarnessSessionId: HARNESS_SESSION_ID,
          },
          fixture.context,
        ),
      ).rejects.toThrow(/fork is not authorized/)
      expect(fixture.authorizeFork).not.toHaveBeenCalled()
      expect(fixture.spawn).not.toHaveBeenCalled()
      expect(fixture.register).not.toHaveBeenCalled()
    },
  )

  it.each([
    [
      'fresh launch carrying fork identifiers',
      {
        launchMode: 'fresh' as const,
        resume: false,
        harnessSessionId: undefined,
        forkSourceSessionId: 'terminal-1',
        parentHarnessSessionId: HARNESS_SESSION_ID,
      },
    ],
    [
      'resume carrying fork identifiers',
      {
        launchMode: 'resume' as const,
        resume: true,
        forkSourceSessionId: 'terminal-1',
        parentHarnessSessionId: HARNESS_SESSION_ID,
      },
    ],
    [
      'fork also marked as resume',
      {
        launchMode: 'fork' as const,
        resume: true,
        harnessSessionId: undefined,
        forkSourceSessionId: 'terminal-1',
        parentHarnessSessionId: HARNESS_SESSION_ID,
      },
    ],
  ])('rejects an invalid %s without spawning', async (_name, overrides) => {
    const fixture = resumeFixture(LOCAL_HOST_ID, 'available')

    await expect(
      fixture.start(
        {
          ...fixture.request,
          sessionId: 'terminal-2',
          ...overrides,
        },
        fixture.context,
      ),
    ).rejects.toThrow(/Invalid (?:harness launch mode|terminal fork request)/)
    expect(fixture.exec).not.toHaveBeenCalled()
    expect(fixture.defaultShell).not.toHaveBeenCalled()
    expect(fixture.spawn).not.toHaveBeenCalled()
    expect(fixture.register).not.toHaveBeenCalled()
    expect(fixture.recordSpawn).not.toHaveBeenCalled()
  })

  it('fails a disconnected SSH parent check without spawning or changing the source', async () => {
    const fixture = resumeFixture(asHostId('ssh-fork-disconnect'), 'available')
    fixture.effectiveLaunchCapabilities.mockReturnValue({
      ...fixture.managed.capabilities,
      exactFork: true,
    })
    fixture.get.mockReturnValue(fixture.managed)
    fixture.exec.mockReset().mockRejectedValue(new Error('SSH disconnected'))

    await expect(
      fixture.start(
        {
          ...fixture.request,
          sessionId: 'terminal-2',
          launchMode: 'fork',
          resume: false,
          harnessSessionId: undefined,
          forkSourceSessionId: 'terminal-1',
          parentHarnessSessionId: HARNESS_SESSION_ID,
        },
        fixture.context,
      ),
    ).rejects.toThrow(/could not be verified/)
    expect(fixture.spawn).not.toHaveBeenCalled()
    expect(fixture.recordSpawn).not.toHaveBeenCalled()
    expect(fixture.recordReplacement).not.toHaveBeenCalled()
  })

  it('rejects a cross-host fork cwd before provider resolution', async () => {
    const fixture = resumeFixture(LOCAL_HOST_ID, 'available')
    await expect(
      fixture.start(
        {
          ...fixture.request,
          sessionId: 'terminal-2',
          launchMode: 'fork',
          resume: false,
          harnessSessionId: undefined,
          forkSourceSessionId: 'terminal-1',
          parentHarnessSessionId: HARNESS_SESSION_ID,
          cwd: hostPath(asHostId('ssh-other'), '/repo'),
        },
        fixture.context,
      ),
    ).rejects.toThrow(/another project/)
    expect(fixture.spawn).not.toHaveBeenCalled()
  })

  it('binds supported Codex probe, profile, and submit-mode capabilities to spawn', async () => {
    const fixture = resumeFixture(LOCAL_HOST_ID, 'available', 'codex')

    const result = await fixture.start(
      {
        ...fixture.request,
        resume: false,
        harnessSessionId: undefined,
        composerSubmitMode: 'ctrl-enter',
      },
      fixture.context,
    )

    expect(result).toMatchObject({
      outcome: 'started',
      capabilities: {
        reviewInsertContractRevision: 1,
        reviewSendNowContractRevision: 1,
      },
    })
    expect(fixture.spawn.mock.calls[0]?.[0]).toMatchObject({
      profileId: fixture.profile.id,
      launchRevision: fixture.profile.launchRevision,
      providerContractVersion: fixture.profile.providerContractVersion,
      composerSubmitMode: 'ctrl-enter',
      effectiveCapabilities: {
        reviewInsertContractRevision: 1,
        reviewSendNowContractRevision: 1,
      },
    })
  })

  it.each([
    ['local', LOCAL_HOST_ID],
    ['SSH', asHostId('ssh-profile-rebind')],
  ])(
    'authorizes a typed current-revision profile rebind on a %s ProjectHost',
    async (_kind, hostId) => {
      const fixture = resumeFixture(hostId, 'available')
      const request: RebindTerminalProfileRequest = {
        root: fixture.root,
        id: 'terminal-1',
        profileId: fixture.profile.id,
        launchRevision: fixture.profile.launchRevision,
      }

      const result = await fixture.rebind(request, fixture.context)

      expect(result).toEqual(fixture.rebound)
      expect(fixture.rebindProfile).toHaveBeenCalledWith({
        id: 'terminal-1',
        providerId: fixture.profile.providerId,
        profileId: fixture.profile.id,
        launchRevision: fixture.profile.launchRevision,
        workspaceRoot: fixture.root,
      })
    },
  )

  it.each([
    ['local', LOCAL_HOST_ID],
    ['SSH', asHostId('ssh-renderer-rollover')],
  ])(
    'reattaches the same live PTY without probing or spawning on a %s ProjectHost',
    async (_kind, hostId) => {
      const fixture = resumeFixture(hostId, 'missing')
      fixture.hasTransferredResource.mockReturnValue(true)
      fixture.get.mockReturnValue(fixture.managed)

      const result = await fixture.start(fixture.request, fixture.context)

      expect(result).toEqual({
        outcome: 'started',
        id: 'terminal-1',
        pid: 4321,
        resumed: true,
        reattached: true,
        harnessSessionId: HARNESS_SESSION_ID,
        identityStatus: 'identified',
        capabilities: {
          sessionIdentity: 'preassigned',
          exactResume: true,
          contextPresentation: 'pressure',
        },
      })
      expect(fixture.authorizeReattach).toHaveBeenCalledWith({
        id: 'terminal-1',
        providerId: 'claude-code',
        profileId: fixture.request.profileId,
        launchRevision: fixture.request.launchRevision,
        harnessSessionId: HARNESS_SESSION_ID,
        workspaceRoot: fixture.root,
        cwd: fixture.root,
      })
      expect(fixture.defaultShell).not.toHaveBeenCalled()
      expect(fixture.exec).not.toHaveBeenCalled()
      expect(fixture.spawn).not.toHaveBeenCalled()
      expect(fixture.recordSpawn).not.toHaveBeenCalled()
      expect(fixture.attach).toHaveBeenCalledWith('terminal-1', 7, expect.any(Object), 1)
      expect(fixture.claimTransferredResource).toHaveBeenCalledWith(
        { id: 7, generation: 1 },
        expect.objectContaining({ type: 'pty-session', id: 'terminal-1' }),
      )
      expect(fixture.register).not.toHaveBeenCalled()
    },
  )

  it('reattaches a retained PTY when the current composer mode changed', async () => {
    const fixture = resumeFixture(LOCAL_HOST_ID, 'missing')
    fixture.hasTransferredResource.mockReturnValue(true)
    fixture.get.mockReturnValue(fixture.managed)

    const result = await fixture.start(
      { ...fixture.request, composerSubmitMode: 'ctrl-enter' },
      fixture.context,
    )

    expect(result).toMatchObject({ outcome: 'started', reattached: true })
    expect(fixture.managed.composerSubmitMode).toBe('enter')
    expect(fixture.spawn).not.toHaveBeenCalled()
  })

  it('rejects retained PTYs with profile, launch revision, or provider contract drift', async () => {
    for (const drift of ['profile', 'launch-revision', 'provider-contract'] as const) {
      const fixture = resumeFixture(LOCAL_HOST_ID, 'missing')
      fixture.hasTransferredResource.mockReturnValue(true)
      const changed =
        drift === 'profile'
          ? {
              ...fixture.managed,
              profileId: asHarnessProfileId('different-profile'),
            }
          : drift === 'launch-revision'
            ? {
                ...fixture.managed,
                launchRevision: fixture.managed.launchRevision + 1,
              }
            : {
                ...fixture.managed,
                providerContractVersion: fixture.managed.providerContractVersion + 1,
              }
      fixture.get.mockReturnValue(changed)

      await expect(fixture.start(fixture.request, fixture.context)).rejects.toThrow(
        /Retained terminal identity changed/,
      )
      expect(fixture.attach).not.toHaveBeenCalled()
      expect(fixture.spawn).not.toHaveBeenCalled()
    }
  })

  it('falls back to exact resume when the transferred PTY exits before reattachment', async () => {
    const fixture = resumeFixture(LOCAL_HOST_ID, 'available')
    fixture.hasTransferredResource.mockReturnValue(true)

    const result = await fixture.start(fixture.request, fixture.context)

    expect(result).toMatchObject({
      outcome: 'started',
      id: 'terminal-1',
      resumed: true,
      reattached: false,
    })
    expect(fixture.authorizeReattach).toHaveBeenCalledOnce()
    expect(fixture.lease.release).toHaveBeenCalledOnce()
    expect(fixture.defaultShell).toHaveBeenCalledOnce()
    expect(fixture.spawn).toHaveBeenCalledOnce()
    expect(fixture.register).toHaveBeenCalledOnce()
  })

  it('rejects a same-generation duplicate start instead of double-attaching', async () => {
    const fixture = resumeFixture(LOCAL_HOST_ID, 'available')
    fixture.register.mockImplementationOnce(() => {
      throw new Error('Renderer pty-session resource is already registered')
    })

    await expect(fixture.start(fixture.request, fixture.context)).rejects.toThrow(
      'already registered',
    )

    expect(fixture.hasTransferredResource).toHaveBeenCalledOnce()
    expect(fixture.claimTransferredResource).not.toHaveBeenCalled()
    expect(fixture.get).not.toHaveBeenCalled()
    expect(fixture.spawn).not.toHaveBeenCalled()
    expect(fixture.attach).not.toHaveBeenCalled()
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

  it('terminates a transferred PTY when recovery is intentionally skipped', async () => {
    const fixture = resumeFixture(LOCAL_HOST_ID, 'missing')
    fixture.hasTransferredResource.mockReturnValue(true)

    await fixture.recordRecoveryDecision(
      {
        root: fixture.root,
        restoredIds: [],
        skippedIds: ['terminal-1'],
      },
      fixture.context,
    )

    expect(fixture.persistRecoveryDecision).toHaveBeenCalledWith(fixture.root, {
      restoredIds: [],
      skippedIds: ['terminal-1'],
    })
    expect(fixture.disposeResource).toHaveBeenCalledWith(
      { id: 7, generation: 1 },
      'pty-session',
      'terminal-1',
    )
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
    expect(fixture.refreshProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        host: fixture.host,
        profiles: [fixture.profile],
      }),
      fixture.profile,
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
  providerId: 'claude-code' | 'codex' = 'claude-code',
) {
  const root = hostPath(hostId, '/repo')
  const template = providerTemplateProfiles().find(
    (candidate) => candidate.providerId === providerId,
  )!
  const profile =
    providerId === 'claude-code'
      ? {
          ...template,
          environment: [
            {
              kind: 'literal' as const,
              name: 'CLAUDE_CONFIG_DIR',
              value: '/config/claude',
            },
          ],
        }
      : template
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
  const authorizeReattach = vi.fn(() => true)
  const authorizeResume = vi.fn(() => true)
  const authorizeFork = vi.fn(() => true)
  const authorizeReplacement = vi.fn(() => true)
  const persistRecoveryDecision = vi.fn(() => Promise.resolve())
  const recordSpawn = vi.fn(() => Promise.resolve())
  const recordReplacement = vi.fn((_replacement: RecordTerminalReplacement) =>
    Promise.resolve(),
  )
  const rebound: TerminalRecoverySession = {
    id: 'terminal-1',
    providerId: profile.providerId,
    profileId: profile.id,
    launchRevision: profile.launchRevision,
    recoverySkipCount: 0,
    harnessSessionId: HARNESS_SESSION_ID,
    hostId,
    cwd: root,
    title: 'Retained conversation',
    position: 0,
    active: true,
    updatedAt: 2,
  }
  const rebindProfile = vi.fn(() => Promise.resolve(rebound))
  const lease = { dispose: vi.fn(() => Promise.resolve()), release: vi.fn() }
  const register = vi.fn(
    (_owner: unknown, _qualifier: unknown, _dispose: () => unknown, _options?: unknown) =>
      lease,
  )
  const probeCapabilities = harnessProvider(
    profile.providerId,
  ).probe.effectiveCapabilities(providerId === 'codex' ? 'codex-cli 0.146.0' : '1.0.0')
  const managedCapabilities = harnessLaunchCapabilities(
    harnessProvider(profile.providerId),
    { profile, composerSubmitMode: 'enter', probedCapabilities: probeCapabilities },
  )
  const managed = {
    id: 'terminal-1',
    ownerId: 7,
    ownerGeneration: 1,
    hostId,
    cwd: root,
    workspaceRoot: root,
    providerId: profile.providerId,
    profileId: profile.id,
    launchRevision: profile.launchRevision,
    providerContractVersion: profile.providerContractVersion,
    composerSubmitMode: 'enter' as const,
    pid: 4321,
    startedAt: 1,
    resumed: true,
    harnessSessionId: HARNESS_SESSION_ID,
    identityStatus: 'identified' as const,
    capabilities: managedCapabilities,
  }
  const effectiveLaunchCapabilities = vi.fn(() => managedCapabilities)
  const spawn = vi.fn(
    (request: {
      sessionId: string
      resume: boolean
      composerSubmitMode: 'enter' | 'ctrl-enter'
      effectiveCapabilities: typeof managedCapabilities
    }) =>
      Promise.resolve(
        request.resume
          ? { ...managed, composerSubmitMode: request.composerSubmitMode }
          : {
              ...managed,
              id: request.sessionId,
              resumed: false,
              harnessSessionId: request.sessionId,
              composerSubmitMode: request.composerSubmitMode,
              capabilities: request.effectiveCapabilities,
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
  const hasTransferredResource = vi.fn(() => false)
  const disposeResource = vi.fn(() => Promise.resolve(true))
  const claimTransferredResource = vi.fn(() => lease)
  const get = vi.fn<
    () => (typeof managed & Pick<ManagedPty, 'identityDiverged'>) | undefined
  >(() => undefined)
  const invalidateProbe = vi.fn()
  const probeProfiles = vi.fn()
  const refreshProfile = vi.fn()
  const recordSuccessfulLaunch = vi.fn()
  const deps = {
    getProject: () => ({ root, host }),
    terminalSessions: {
      authorizeReattach,
      authorizeResume,
      authorizeFork,
      authorizeReplacement,
      recordRecoveryDecision: persistRecoveryDecision,
      recordSpawn,
      recordReplacement,
      rebindProfile,
    },
    harnessProfiles: {
      get: () => profile,
      hasPathGrant: () => false,
    },
    harnessProbes: {
      effectiveLaunchCapabilities,
      invalidate: invalidateProbe,
      probeProfiles,
      refreshProfile,
      recordSuccessfulLaunch,
    },
    rendererResources: {
      register,
      hasTransferredResource,
      claimTransferredResource,
      disposeResource,
      assertCurrent: vi.fn(),
      isCurrent: vi.fn(() => true),
    },
    ptySupervisor: {
      spawn,
      attach,
      get,
      isAwaitingRendererAttachment: vi.fn(() => true),
      transferRendererSession: vi.fn(() => true),
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
  const recordRecoveryDecision = handlers.get('terminal:record-recovery-decision') as (
    request: {
      root: HostPath
      restoredIds: readonly string[]
      skippedIds: readonly string[]
    },
    context: IpcInvokeContext,
  ) => Promise<void>
  const rebind = handlers.get('terminal:rebind-profile') as (
    request: RebindTerminalProfileRequest,
    context: IpcInvokeContext,
  ) => Promise<TerminalRecoverySession>
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
  }
  const send = vi.fn()
  const context = {
    owner: () => ({ id: 7, generation: 1 }),
    authority: ipc.authority,
    sender: {
      isDestroyed: () => false,
      mainFrame: {
        isDestroyed: () => false,
        postMessage: send,
      },
    },
  } as unknown as IpcInvokeContext
  return {
    root,
    host,
    profile,
    exec,
    defaultShell,
    authorizeReattach,
    authorizeResume,
    authorizeFork,
    authorizeReplacement,
    recordSpawn,
    recordReplacement,
    rebound,
    rebindProfile,
    persistRecoveryDecision,
    lease,
    register,
    hasTransferredResource,
    claimTransferredResource,
    disposeResource,
    spawn,
    attach,
    get,
    managed,
    invalidateProbe,
    probeProfiles,
    refreshProfile,
    recordSuccessfulLaunch,
    effectiveLaunchCapabilities,
    send,
    start,
    recordRecoveryDecision,
    rebind,
    request,
    context,
  }
}
