import { EventEmitter } from 'node:events'
import type { TerminalSessionStore } from '../src/main/terminal/session-registry'
import {
  TerminalCommandHandoffOwner,
  type TerminalCommandRequest,
} from '../src/main/terminal/command-handoff-owner'

import type { Client, SFTPWrapper } from 'ssh2'
import { describe, expect, it, vi } from 'vitest'

import { HarnessProbeManager } from '../src/main/harness/harness-probe'
import {
  builtInProfiles,
  providerTemplateProfiles,
  type HarnessProfileStoreContract,
} from '../src/main/harness/harness-profile-store'
import { registerTerminalIpc } from '../src/main/ipc/features/terminal'
import {
  IpcAuthority,
  type IpcInvokeContext,
  type IpcRegistrar,
} from '../src/main/ipc/authority-router'
import type { ProjectHost } from '../src/main/project-host'
import type { ManagedPty, PtySpawnRequest } from '../src/main/pty/pty-supervisor'
import {
  LOCAL_HOST_ID,
  hostPath,
  hostPathEquals,
  type HostConnectionState,
  type ProjectState,
  type StartPtyRequest,
  type StartPtyResponse,
} from '../src/shared'
import { createTestSshHost } from './ssh-host-test-fixture'

const HARNESS_SESSION_ID = '05ea41ff-026f-4ab6-b930-64eb3b497806'

describe('terminal IPC launch probe binding', () => {
  it('persists ordinary shell identity and recovery never repeats command-once bytes', async () => {
    let admission!: TerminalCommandRequest
    const handoffs = new TerminalCommandHandoffOwner((_owner, request) => {
      admission = request
    })
    const f = launchProbeFixture('', undefined, 'plain-shell', handoffs)
    const controller = new AbortController()
    try {
      const outcome = handoffs.request({
        owner: f.context.owner(),
        workspaceId: 'workspace-1',
        root: f.request.workspaceRoot,
        command: {
          executable: '/installed/tool',
          args: ['setup-private-once'],
          environment: { TOOL_CONFIG: 'private-config-once' },
        },
        current: () => undefined,
        signal: controller.signal,
      })
      const request = {
        ...f.request,
        sessionId: admission.terminalId,
        commandTicket: admission.ticket,
        commandWorkspaceId: admission.workspaceId,
      }
      expect(await f.start(request, f.context)).toMatchObject({ outcome: 'started' })
      expect(await outcome).toMatchObject({ outcome: 'handed-off' })
      expect(f.spawn.mock.calls[0]?.[0].launchSpec?.args).toContain('setup-private-once')
      expect(f.spawn.mock.calls[0]?.[0].launchSpec?.args).toContain(
        'TOOL_CONFIG=private-config-once',
      )
      expect(JSON.stringify(f.recordSpawn.mock.calls)).not.toMatch(
        /private-once|private-config-once|commandTicket/u,
      )
      expect(f.recordSpawn.mock.calls[0]?.[0]).toMatchObject({
        providerId: 'plain-shell',
        profileId: 'plain-shell-default',
      })
      await expect(f.start(request, f.context)).rejects.toThrow('stale')
      expect(f.spawn).toHaveBeenCalledOnce()
      await f.start({ ...f.request, sessionId: 'recovered-ordinary-shell' }, f.context)
      expect(f.spawn.mock.calls[1]?.[0].launchSpec).toMatchObject({
        file: '/bin/zsh',
        args: ['-l'],
      })
      expect(JSON.stringify(f.spawn.mock.calls[1])).not.toMatch(
        /private-once|private-config-once/u,
      )
      controller.abort()
    } finally {
      handoffs.dispose()
      f.probes.dispose()
    }
  })

  it('settles consumed admission after cancellation during IPC default-shell lookup', async () => {
    let admission!: TerminalCommandRequest
    const handoffs = new TerminalCommandHandoffOwner((_owner, request) => {
      admission = request
    })
    const f = launchProbeFixture('', undefined, 'plain-shell', handoffs)
    const controller = new AbortController()
    let release!: (shell: string) => void
    f.defaultShell.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    try {
      const outcome = handoffs.request({
        owner: f.context.owner(),
        workspaceId: 'workspace-1',
        root: f.request.workspaceRoot,
        command: { executable: '/tool', args: [], environment: {} },
        current: () => undefined,
        signal: controller.signal,
      })
      const request = {
        ...f.request,
        sessionId: admission.terminalId,
        commandTicket: admission.ticket,
        commandWorkspaceId: admission.workspaceId,
      }
      const starting = f.start(request, f.context),
        rejected = expect(starting).rejects.toThrow()
      await vi.waitFor(() => expect(f.defaultShell).toHaveBeenCalledOnce())
      controller.abort()
      expect(await outcome).toMatchObject({ outcome: 'not-started' })
      release('/bin/zsh')
      await rejected
      expect(f.spawn).not.toHaveBeenCalled()
      await expect(f.start(request, f.context)).rejects.toThrow('stale')
    } finally {
      handoffs.dispose()
      f.probes.dispose()
    }
  })

  it.each([
    ['fresh', false],
    ['restored resume', true],
  ])(
    'probes an unchecked configured Codex profile before binding a %s launch',
    async (_mode, resume) => {
      const fixture = launchProbeFixture('codex-cli 0.153.1')
      try {
        expect(fixture.probes.snapshotProfiles(fixture.probeRequest)).toEqual([])

        const result = await fixture.start(
          {
            ...fixture.request,
            launchMode: resume ? 'resume' : 'fresh',
            resume,
            harnessSessionId: resume ? HARNESS_SESSION_ID : undefined,
          },
          fixture.context,
        )

        expect(result).toMatchObject({
          outcome: 'started',
          resumed: resume,
          capabilities: { exactFork: true },
        })
        expect(fixture.exec).toHaveBeenCalledTimes(2)
        const launch = fixture.spawn.mock.calls[0]?.[0]
        expect(launch?.effectiveCapabilities).toMatchObject({ exactFork: true })
        expect(launch?.launchSpec).toMatchObject({ file: 'codex' })
        expect(launch?.launchSpec?.args).toContain('--yolo')

        if (!resume) {
          const bound = fixture.spawn.mock.calls[0]?.[0].effectiveCapabilities
          fixture.setVersion('codex-cli 0.150.0')
          const [downgraded] = await fixture.probes.probeProfiles({
            ...fixture.probeRequest,
            force: true,
          })
          expect(downgraded?.capabilities).not.toHaveProperty('exactFork')
          expect(bound).toMatchObject({ exactFork: true })
          expect(result).toMatchObject({ capabilities: { exactFork: true } })
        }
      } finally {
        fixture.probes.dispose()
      }
    },
  )

  it('keeps an unchecked unsupported Codex launch fail-closed', async () => {
    const fixture = launchProbeFixture('codex-cli 0.150.0')
    try {
      const result = await fixture.start(fixture.request, fixture.context)

      expect(result).toMatchObject({ outcome: 'started' })
      expect(result).not.toHaveProperty('capabilities.exactFork')
      expect(fixture.spawn.mock.calls[0]?.[0].effectiveCapabilities).not.toHaveProperty(
        'exactFork',
      )
    } finally {
      fixture.probes.dispose()
    }
  })

  it('starts a remote terminal when SFTP validation crosses a control reconnect', async () => {
    let finishOpening!: (value: {
      complete(error: undefined, session: SFTPWrapper): void
      session: SFTPWrapper
    }) => void
    const opening = new Promise<Parameters<typeof finishOpening>[0]>((resolve) => {
      finishOpening = resolve
    })
    const clients: ReturnType<typeof launchClient>[] = []
    const host = createTestSshHost({
      config: {
        alias: 'launch-reconnect',
        hostname: 'example.test',
        user: 'test',
        port: 22,
        identityFiles: [],
      },
      prompter: { prompt: () => Promise.resolve(undefined) },
      clientFactory: () => {
        const client = launchClient()
        if (clients.length === 0) {
          client.sftp.mockImplementationOnce((complete) => {
            finishOpening({ complete, session: client.session as unknown as SFTPWrapper })
          })
        }
        clients.push(client)
        return client as unknown as Client
      },
    })
    const fixture = launchProbeFixture('', host, 'plain-shell')
    try {
      await host.connect()
      const starting = fixture.start(fixture.request, fixture.context)
      const pending = await opening
      clients[0]!.emit('close')
      expect(host.connectionState).toBe('reconnecting')
      // The next SFTP acquisition must wait for the replacement transport itself.
      pending.complete(undefined, pending.session)

      await expect(starting).resolves.toMatchObject({
        outcome: 'started',
        resumed: false,
      })
      expect(host.connectionState).toBe('connected')
      expect(clients).toHaveLength(2)
      expect(clients[0]!.session.end).toHaveBeenCalledOnce()
      expect(clients[0]!.session.realpath).not.toHaveBeenCalled()
      expect(clients[1]!.sftp).toHaveBeenCalledOnce()
      expect(fixture.spawn).toHaveBeenCalledOnce()
      expect(fixture.spawn.mock.calls[0]?.[0]).toMatchObject({
        host,
        cwd: fixture.request.cwd,
        launchSpec: { file: '/bin/sh' },
      })
    } finally {
      fixture.probes.dispose()
      await host.dispose()
    }
  })
})

function launchProbeFixture(
  initialVersion: string,
  suppliedHost?: ProjectHost,
  providerId = 'codex',
  terminalHandoffs?: TerminalCommandHandoffOwner,
) {
  const root = hostPath(suppliedHost?.hostId ?? LOCAL_HOST_ID, '/repo')
  const profile = {
    ...[...builtInProfiles(), ...providerTemplateProfiles()].find(
      (profile) => profile.providerId === providerId,
    )!,
    builtIn: false,
    launchRevision: 4,
    args:
      providerId === 'codex'
        ? [{ parts: [{ kind: 'literal' as const, value: '--yolo' }] }]
        : [],
  }
  let version = initialVersion
  const exec = vi.fn<ProjectHost['exec']>((_command, args) => {
    const script = args.at(-1) ?? ''
    return Promise.resolve({
      code: 0,
      signal: null,
      stdout: script.startsWith('command -v')
        ? ''
        : `\x1ehvir-provider-output-v1\x1f${version}`,
      stderr: '',
    })
  })
  const listeners = new Set<(state: HostConnectionState) => void>()
  const defaultShell = vi.fn(() => Promise.resolve('/bin/zsh'))
  const host =
    suppliedHost ??
    ({
      hostId: LOCAL_HOST_ID,
      connectionState: 'connected',
      watchTier: 'native',
      defaultShell,
      realpath: (path: typeof root) => Promise.resolve(path),
      exec,
      onConnectionState: (listener: (state: HostConnectionState) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    } as unknown as ProjectHost)
  const store = {
    list: () => [profile],
    get: () => profile,
    prepare: () => profile,
    save: () => Promise.resolve(profile),
    materializeTemplates: () => Promise.resolve([]),
    duplicate: () => Promise.resolve(profile),
    delete: () => Promise.resolve(),
    authorizePath: () => Promise.reject(new Error('not used')),
    hasPathGrant: () => false,
    flush: () => Promise.resolve(),
  } satisfies HarnessProfileStoreContract
  const probes = new HarnessProbeManager()
  const probeRequest = {
    host,
    projectRoot: root,
    workspaceRoot: root,
    profiles: [profile],
    store,
  }
  const spawn = vi.fn(async (request: PtySpawnRequest): Promise<ManagedPty> => {
    await request.beforeDispatch?.()
    request.onDispatch?.()
    return {
      instanceId: 'instance-1',
      id: request.sessionId!,
      ownerId: request.ownerId,
      ownerGeneration: request.ownerGeneration!,
      hostId: host.hostId,
      cwd: request.cwd,
      workspaceRoot: request.workspaceRoot!,
      providerId: profile.providerId,
      capabilities: request.effectiveCapabilities!,
      profileId: profile.id,
      launchRevision: profile.launchRevision,
      providerContractVersion: profile.providerContractVersion,
      composerSubmitMode: request.composerSubmitMode,
      pid: 4321,
      startedAt: 1,
      resumed: request.resume === true,
      harnessSessionId: request.resume ? request.harnessSessionId : request.sessionId,
      identityStatus: 'identified',
    }
  })
  const handlers = new Map<
    string,
    (request: unknown, context: IpcInvokeContext) => unknown
  >()
  const authority = new IpcAuthority({
    getProject: () => ({ root, host }),
    getProjectState: () => projectState(root),
    getRegisteredWorkspaceRoot: (candidate) =>
      hostPathEquals(candidate, root) ? root : undefined,
  })
  const ipc = {
    authority,
    handle: (
      channel: string,
      handler: (request: unknown, context: IpcInvokeContext) => unknown,
    ) => handlers.set(channel, handler),
    handleSend: vi.fn(),
  } as unknown as IpcRegistrar
  const lease = { dispose: vi.fn(() => Promise.resolve()), release: vi.fn() }
  const recordSpawn = vi.fn<TerminalSessionStore['recordSpawn']>(() => Promise.resolve())
  registerTerminalIpc(ipc, {
    terminalHandoffs,
    getHost: () => host,
    terminalSessions: {
      authorizeReattach: vi.fn(() => false),
      authorizeResume: vi.fn(() => true),
      authorizeFork: vi.fn(() => false),
      authorizeReplacement: vi.fn(() => false),
      recordRecoveryDecision: vi.fn(() => Promise.resolve()),
      recordSpawn,
      recordReplacement: vi.fn(() => Promise.resolve()),
      rebindProfile: vi.fn(),
    },
    harnessProfiles: store,
    harnessProbes: probes,
    rendererResources: {
      register: vi.fn(() => lease),
      hasTransferredResource: vi.fn(() => false),
      claimTransferredResource: vi.fn(),
      disposeResource: vi.fn(),
      assertCurrent: vi.fn(),
      isCurrent: vi.fn(() => true),
    },
    ptySupervisor: {
      spawn,
      attach: vi.fn(() => () => undefined),
      get: vi.fn(),
      isAwaitingRendererAttachment: vi.fn(() => false),
      transferRendererSession: vi.fn(() => false),
      disposeSession: vi.fn(),
    },
    terminalMoves: { plan: vi.fn(), move: vi.fn() },
  } as unknown as Parameters<typeof registerTerminalIpc>[1])
  const start = handlers.get('pty:start') as (
    request: StartPtyRequest,
    context: IpcInvokeContext,
  ) => Promise<StartPtyResponse>
  const request: StartPtyRequest = {
    sessionId: 'terminal-1',
    profileId: profile.id,
    launchRevision: profile.launchRevision,
    workspaceRoot: root,
    cwd: root,
    cols: 80,
    rows: 24,
    title: 'Codex',
    position: 0,
    active: true,
    composerSubmitMode: 'enter',
    launchMode: 'fresh',
    resume: false,
  }
  const context = {
    owner: () => ({ id: 7, generation: 1 }),
    authority,
    sender: {
      isDestroyed: () => false,
      mainFrame: { isDestroyed: () => false, postMessage: vi.fn() },
    },
  } as unknown as IpcInvokeContext
  return {
    probes,
    probeRequest,
    exec,
    spawn,
    start,
    request,
    context,
    defaultShell,
    recordSpawn,
    setVersion: (next: string) => {
      version = next
    },
  }
}

/** Only the immediate ssh2 boundary is simulated; host reconnect and SFTP stay real. */
function launchClient() {
  const session = Object.assign(new EventEmitter(), {
    end: vi.fn(() => {
      session.emit('close')
    }),
    realpath: vi.fn((path: string, done: (error: undefined, path: string) => void) => {
      done(undefined, path)
    }),
  })
  const client = Object.assign(new EventEmitter(), {
    session,
    connect: vi.fn(() => queueMicrotask(() => client.emit('ready'))),
    end: vi.fn(() => {
      client.emit('close')
    }),
    destroy: vi.fn(() => {
      client.emit('close')
    }),
    sftp: vi.fn((done: (error: undefined, session: SFTPWrapper) => void) => {
      done(undefined, session as unknown as SFTPWrapper)
    }),
    exec: vi.fn(
      (_command: string, done: (error: undefined, channel: unknown) => void) => {
        const channel = Object.assign(new EventEmitter(), {
          stderr: new EventEmitter(),
          close: vi.fn(() => {
            channel.emit('close')
          }),
          end: vi.fn(() => {
            queueMicrotask(() => {
              channel.emit('data', Buffer.from('/bin/sh\n'))
              channel.emit('exit', 0)
              channel.emit('close')
            })
          }),
        })
        done(undefined, channel)
      },
    ),
  })
  return client
}

function projectState(root: ReturnType<typeof hostPath>): ProjectState {
  return {
    revision: 1,
    root,
    connectionState: 'connected',
    watchTier: 'native',
    activeProjectId: 'project-1',
    activeWorkspaceId: 'workspace-1',
    projects: [
      {
        id: 'project-1',
        registeredRoot: root,
        displayName: 'Project',
        connectionState: 'connected',
        watchTier: 'native',
        activeWorkspaceId: 'workspace-1',
        workspaces: [
          {
            id: 'workspace-1',
            root,
            name: 'Project',
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
