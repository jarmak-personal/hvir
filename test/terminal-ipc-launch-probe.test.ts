import { describe, expect, it, vi } from 'vitest'

import { HarnessProbeManager } from '../src/main/harness/harness-probe'
import {
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

const HARNESS_SESSION_ID = '05ea41ff-026f-4ab6-b930-64eb3b497806'

describe('terminal IPC launch probe binding', () => {
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
})

function launchProbeFixture(initialVersion: string) {
  const root = hostPath(LOCAL_HOST_ID, '/repo')
  const profile = {
    ...providerTemplateProfiles().find(({ providerId }) => providerId === 'codex')!,
    builtIn: false,
    launchRevision: 4,
    args: [{ parts: [{ kind: 'literal' as const, value: '--yolo' }] }],
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
  const host = {
    hostId: LOCAL_HOST_ID,
    connectionState: 'connected',
    watchTier: 'native',
    defaultShell: () => Promise.resolve('/bin/zsh'),
    realpath: (path: typeof root) => Promise.resolve(path),
    exec,
    onConnectionState: (listener: (state: HostConnectionState) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  } as unknown as ProjectHost
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
  const spawn = vi.fn((request: PtySpawnRequest): Promise<ManagedPty> =>
    Promise.resolve({
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
    }),
  )
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
  registerTerminalIpc(ipc, {
    getHost: () => host,
    terminalSessions: {
      authorizeReattach: vi.fn(() => false),
      authorizeResume: vi.fn(() => true),
      authorizeFork: vi.fn(() => false),
      authorizeReplacement: vi.fn(() => false),
      recordRecoveryDecision: vi.fn(() => Promise.resolve()),
      recordSpawn: vi.fn(() => Promise.resolve()),
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
    setVersion: (next: string) => {
      version = next
    },
  }
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
