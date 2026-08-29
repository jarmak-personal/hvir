import { EventEmitter } from 'node:events'

import type { Client } from 'ssh2'
import { describe, expect, it, vi } from 'vitest'

import {
  claudeCodeProvider,
  plainShellProvider,
  type HarnessTelemetryContext,
} from '../src/main/harness/harness-provider'
import {
  PtyWriteIndeterminateError,
  type ProjectHost,
  type PtyExit,
  type PtyProcess,
} from '../src/main/project-host'
import {
  PtySupervisor,
  type ManagedPty,
  type PtySupervisorDiagnostic,
} from '../src/main/pty/pty-supervisor'
import {
  LOCAL_HOST_ID,
  asHostId,
  asHarnessProviderId,
  contextStatusHarnessSnapshot,
  hostPath,
  localPath,
} from '../src/shared'
import {
  createPtySupervisorFixture,
  PTY_FIXTURE_OWNER_ID,
  TestPtyProcess,
} from './fixtures/pty-supervisor-fixture'
import { createTestSshHost } from './ssh-host-test-fixture'

const OWNER_ID = PTY_FIXTURE_OWNER_ID
const FakePty = TestPtyProcess
const fixture = createPtySupervisorFixture

describe('PtySupervisor', () => {
  it('publishes bounded lifecycle observations without subscribing to PTY output', async () => {
    const { supervisor, pty, spawn } = fixture({ provider: plainShellProvider })
    const listener = vi.fn()
    const release = supervisor.observe(listener)

    const info = await spawn({ sessionId: 'observed-shell' })
    expect(listener).toHaveBeenCalledOnce()
    expect(supervisor.observationSnapshot()).toEqual([{ info, telemetry: undefined }])
    expect(pty.dataListeners.size).toBe(1)

    pty.emitData('terminal content must not reach observation')
    expect(listener).toHaveBeenCalledOnce()
    pty.emitExit({ exitCode: 0, signal: undefined })
    expect(listener).toHaveBeenCalledTimes(2)
    expect(supervisor.observationSnapshot()).toEqual([])

    await release()
    expect(supervisor.observationSnapshot()).toEqual([])
  })

  it('publishes one observation when a live PTY lease is explicitly disposed', async () => {
    const { supervisor, spawn } = fixture({ provider: plainShellProvider })
    const listener = vi.fn()
    const release = supervisor.observe(listener)

    const info = await spawn({ sessionId: 'disposed-shell' })
    supervisor.disposeSession(info.id, info.ownerId, info.ownerGeneration)

    expect(listener).toHaveBeenCalledTimes(2)
    expect(supervisor.observationSnapshot()).toEqual([])
    await release()
  })

  it('launches a plain shell resolved by the owning host', async () => {
    const { supervisor, host, spawnPty, defaultShell } = fixture()
    await supervisor.spawn({
      host,
      provider: plainShellProvider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'host-shell',
    })

    expect(defaultShell).toHaveBeenCalledOnce()
    expect(spawnPty).toHaveBeenCalledWith(
      expect.objectContaining({
        file: '/remote/bin/bash',
        args: ['-l'],
        env: {
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          TERM_PROGRAM: 'hvir',
        },
      }),
    )
  })

  it('does not infer review insertion when effective launch capabilities are omitted', async () => {
    const { supervisor, host } = fixture({ provider: claudeCodeProvider })
    const info = await supervisor.spawn({
      host,
      provider: claudeCodeProvider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'no-effective-capabilities',
    })

    expect(info.capabilities).toMatchObject({
      sessionIdentity: 'preassigned',
      exactResume: true,
      contextPresentation: 'pressure',
    })
    expect(info.capabilities).not.toHaveProperty('reviewInsertContractRevision')
  })

  it('launches harness commands through the login-interactive shell environment', async () => {
    const { supervisor, host, provider, spawnPty } = fixture()
    Object.assign(provider, {
      launch: () => ({
        file: 'test-harness',
        args: ['launch', "profile's command"],
        env: { HARNESS_TEST: 'yes' },
        shellEnvironment: true,
      }),
    })

    await supervisor.spawn({
      host,
      provider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'shell-environment',
    })

    expect(spawnPty).toHaveBeenCalledWith(
      expect.objectContaining({
        file: '/remote/bin/bash',
        args: ['-lic', `exec 'test-harness' 'launch' 'profile'"'"'s command'`],
        env: {
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          TERM_PROGRAM: 'hvir',
          HARNESS_TEST: 'yes',
        },
      }),
    )
  })

  it('keeps the terminal contract protected and reports command-not-found exits', async () => {
    const { supervisor, pty, host, provider, spawnPty } = fixture()
    const onClassifiedLaunchFailure = vi.fn()
    await supervisor.spawn({
      host,
      provider,
      launchSpec: {
        file: 'test-harness',
        args: [],
        env: { TERM: 'dumb', COLORTERM: 'no', TERM_PROGRAM: 'other' },
      },
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'protected-environment',
      onClassifiedLaunchFailure,
    })

    expect(spawnPty).toHaveBeenCalledWith(
      expect.objectContaining({
        env: {
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          TERM_PROGRAM: 'hvir',
        },
      }),
    )
    pty.emitExit({ exitCode: 127, signal: undefined })
    expect(onClassifiedLaunchFailure).toHaveBeenCalledOnce()
  })

  it('classifies an unsupported-option PTY exit without retrying the session', async () => {
    const { supervisor, pty, host, provider } = fixture()
    const onClassifiedLaunchFailure = vi.fn()
    await supervisor.spawn({
      host,
      provider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'unsupported-option',
      onClassifiedLaunchFailure,
    })

    pty.emitData('error: unknown option --new-surface\r\n')
    pty.emitExit({ exitCode: 2, signal: undefined })

    expect(onClassifiedLaunchFailure).toHaveBeenCalledOnce()
    expect(supervisor.get('unsupported-option')).toBeUndefined()
  })

  it('does not classify old terminal output as a launch failure', async () => {
    const ptyFixture = fixture()
    const { supervisor, pty, host, provider } = ptyFixture
    const onClassifiedLaunchFailure = vi.fn()
    ptyFixture.setNow(1_000)
    await supervisor.spawn({
      host,
      provider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'long-running-terminal',
      onClassifiedLaunchFailure,
    })
    pty.emitData('earlier command output: unknown option\r\n')
    ptyFixture.advanceClock(30_001)
    pty.emitExit({ exitCode: 2, signal: undefined })
    expect(onClassifiedLaunchFailure).not.toHaveBeenCalled()
  })

  it('is the lifecycle and stream boundary for a spawned PTY', async () => {
    const { supervisor, pty, host, provider, spawnPty } = fixture()
    const info = await supervisor.spawn({
      host,
      provider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'session-1',
    })

    expect(info).toMatchObject({
      id: 'session-1',
      ownerId: OWNER_ID,
      hostId: LOCAL_HOST_ID,
      providerId: 'test',
      pid: 4242,
      resumed: false,
      harnessSessionId: 'session-1',
      identityStatus: 'identified',
    })
    expect(spawnPty).toHaveBeenCalledWith(
      expect.objectContaining({
        file: 'test-harness',
        args: ['launch'],
        cwd: localPath('/tmp/project'),
      }),
    )

    const onData = vi.fn<(data: string) => void>()
    const detach = supervisor.attach(info.id, OWNER_ID, { onData })
    pty.emitData('hello')
    expect(onData).toHaveBeenCalledWith('hello')
    await detach()
    pty.emitData('ignored')
    expect(onData).toHaveBeenCalledTimes(1)

    supervisor.write(info.id, OWNER_ID, 'input')
    supervisor.resize(info.id, OWNER_ID, 120, 40)
    expect(pty.write).toHaveBeenCalledWith('input')
    expect(pty.resize).toHaveBeenCalledWith(120, 40)
  })

  it('confirms exactly one complete write at the owned PTY boundary', async () => {
    const { supervisor, pty, host, provider } = fixture()
    const info = await supervisor.spawn({
      host,
      provider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      ownerGeneration: 7,
      sessionId: 'confirmed-write',
    })

    await supervisor.writeConfirmed(info.id, OWNER_ID, 'exact transport', 7)

    expect(pty.writeConfirmed).toHaveBeenCalledExactlyOnceWith('exact transport')
    expect(pty.write).not.toHaveBeenCalled()
  })

  it('rejects failed and exit-raced confirmed writes', async () => {
    const failed = fixture()
    const failedInfo = await failed.supervisor.spawn({
      host: failed.host,
      provider: failed.provider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'failed-confirmed-write',
    })
    failed.pty.writeConfirmed.mockRejectedValueOnce(new Error('transport refused'))
    await expect(
      failed.supervisor.writeConfirmed(failedInfo.id, OWNER_ID, 'payload'),
    ).rejects.toThrow(/transport refused/)

    const late = fixture()
    let finish!: () => void
    late.pty.writeConfirmed.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finish = resolve)),
    )
    const lateInfo = await late.supervisor.spawn({
      host: late.host,
      provider: late.provider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'late-confirmed-write',
    })
    const writing = late.supervisor.writeConfirmed(lateInfo.id, OWNER_ID, 'payload')
    late.pty.emitExit({ exitCode: 255, signal: undefined })
    finish()
    await expect(writing).rejects.toBeInstanceOf(PtyWriteIndeterminateError)
  })

  it('replays bounded initial output in order on the first renderer attach', async () => {
    const { supervisor, pty, host, provider } = fixture()
    const info = await supervisor.spawn({
      host,
      provider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'replay-session',
    })
    pty.emitData('first')
    pty.emitData(' second')

    const onData = vi.fn<(data: string) => void>()
    supervisor.attach(info.id, OWNER_ID, { onData })
    pty.emitData(' third')

    expect(onData.mock.calls.map(([data]) => data)).toEqual([
      'first',
      ' second',
      ' third',
    ])
  })

  it('retains only the newest 256 KiB before the first attach', async () => {
    const { supervisor, pty, host, provider } = fixture()
    const info = await supervisor.spawn({
      host,
      provider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'bounded-replay',
    })
    pty.emitData(`discard${'x'.repeat(256 * 1024)}`)

    const onData = vi.fn<(data: string) => void>()
    supervisor.attach(info.id, OWNER_ID, { onData })

    expect(onData).toHaveBeenCalledOnce()
    expect(onData.mock.calls[0]?.[0]).toBe('x'.repeat(256 * 1024))
  })

  it('confines control and disposal to the owning renderer', async () => {
    const first = new FakePty()
    const second = new FakePty()
    const { supervisor, host, provider, spawnPty } = fixture()
    spawnPty.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    await supervisor.spawn({
      host,
      provider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'owned-first',
    })
    await supervisor.spawn({
      host,
      provider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID + 1,
      sessionId: 'owned-second',
    })

    expect(() => supervisor.write('owned-first', OWNER_ID + 1, 'nope')).toThrow(
      /another renderer/,
    )
    supervisor.disposeOwner(OWNER_ID)

    expect(first.kill).toHaveBeenCalledOnce()
    expect(second.kill).not.toHaveBeenCalled()
    expect(supervisor.get('owned-first')).toBeUndefined()
    expect(supervisor.get('owned-second')).toBeDefined()
  })

  it('does not let a newer document generation claim an older PTY', async () => {
    const { supervisor, pty, host, provider } = fixture()
    await supervisor.spawn({
      host,
      provider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      ownerGeneration: 4,
      sessionId: 'generation-owned',
    })

    expect(supervisor.isOwnedBy('generation-owned', OWNER_ID, 5)).toBe(false)
    expect(() => supervisor.write('generation-owned', OWNER_ID, 'nope', 5)).toThrow(
      /another renderer/,
    )
    supervisor.disposeOwner(OWNER_ID, 5)
    expect(pty.kill).not.toHaveBeenCalled()

    supervisor.disposeOwner(OWNER_ID, 4)
    expect(pty.kill).toHaveBeenCalledOnce()
  })

  it('reassigns workspace ownership without changing the PTY launch cwd', async () => {
    const { supervisor, host, provider } = fixture()
    const sourceRoot = localPath('/tmp/project')
    const targetRoot = localPath('/tmp/project-feature')
    await supervisor.spawn({
      host,
      provider,
      workspaceRoot: sourceRoot,
      cwd: sourceRoot,
      ownerId: OWNER_ID,
      ownerGeneration: 4,
      sessionId: 'moved-terminal',
    })

    const moved = supervisor.reassignWorkspace(
      'moved-terminal',
      OWNER_ID,
      sourceRoot,
      targetRoot,
      4,
    )
    expect(moved).toMatchObject({ cwd: sourceRoot, workspaceRoot: targetRoot })
    expect(() =>
      supervisor.reassignWorkspace('moved-terminal', OWNER_ID, sourceRoot, targetRoot, 4),
    ).toThrow('no longer belongs to the source workspace')
    expect(() =>
      supervisor.reassignWorkspace(
        'moved-terminal',
        OWNER_ID,
        targetRoot,
        hostPath(asHostId('remote'), '/tmp/project-feature'),
        4,
      ),
    ).toThrow('cannot move to another host')
  })

  it('rejects an already-active session id without leaking another PTY', async () => {
    const { supervisor, host, provider, spawnPty } = fixture()
    const request = {
      host,
      provider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'same-session',
    }
    await supervisor.spawn(request)
    await expect(supervisor.spawn(request)).rejects.toThrow(/already active/)
    expect(spawnPty).toHaveBeenCalledTimes(1)
  })

  it('emits content-free create and exit diagnostics from the PTY owner', async () => {
    const events: PtySupervisorDiagnostic[] = []
    const { supervisor, pty, host, provider } = fixture((event) => events.push(event))
    await supervisor.spawn({
      host,
      provider,
      cwd: localPath('/private/project-with-secret-name'),
      ownerId: OWNER_ID,
      sessionId: 'sensitive-session-id',
    })
    pty.emitData('terminal prompt with TOKEN=hvir-private')
    pty.emitExit({ exitCode: 7, signal: undefined })

    expect(events).toEqual([
      { kind: 'pty-spawned', hostKind: 'local', launchMode: 'fresh' },
      {
        kind: 'pty-exited',
        hostKind: 'local',
        launchMode: 'fresh',
        exitKind: 'error',
        lifetime: 'under-30s',
      },
    ])
    expect(JSON.stringify(events)).not.toMatch(/secret|TOKEN|prompt|sensitive-session/)
  })

  it('reports PTY creation failure without retaining the error or request', async () => {
    const events: PtySupervisorDiagnostic[] = []
    const { supervisor, host, provider, spawnPty } = fixture((event) =>
      events.push(event),
    )
    spawnPty.mockRejectedValueOnce(
      new Error('/private/project TOKEN=hvir-private could not spawn'),
    )

    await expect(
      supervisor.spawn({
        host,
        provider,
        cwd: localPath('/private/project'),
        ownerId: OWNER_ID,
        sessionId: 'failed-session',
      }),
    ).rejects.toThrow('could not spawn')
    expect(events).toEqual([
      { kind: 'pty-spawn-failed', hostKind: 'local', launchMode: 'fresh' },
    ])
    expect(JSON.stringify(events)).not.toMatch(/private|TOKEN|failed-session/)
  })

  it('does not let a failing diagnostics observer change PTY creation', async () => {
    const { supervisor, host, provider } = fixture(() => {
      throw new Error('diagnostics sink failed')
    })

    await expect(
      supervisor.spawn({
        host,
        provider,
        cwd: localPath('/tmp/project'),
        ownerId: OWNER_ID,
      }),
    ).resolves.toMatchObject({ providerId: provider.manifest.id })
  })

  it('reserves a session id while its asynchronous host spawn is pending', async () => {
    const { supervisor, pty, host, provider, spawnPty } = fixture()
    let finishSpawn: (() => void) | undefined
    spawnPty.mockImplementationOnce(
      () =>
        new Promise<PtyProcess>((resolve) => {
          finishSpawn = () => resolve(pty)
        }),
    )
    const request = {
      host,
      provider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'pending-session',
    }

    const first = supervisor.spawn(request)
    await Promise.resolve()
    await expect(supervisor.spawn(request)).rejects.toThrow(/already active/)
    finishSpawn?.()
    await first
    expect(spawnPty).toHaveBeenCalledTimes(1)
  })

  it('kills a pending host spawn that completes after all sessions are disposed', async () => {
    const events: PtySupervisorDiagnostic[] = []
    const { supervisor, pty, host, provider, spawnPty } = fixture((event) =>
      events.push(event),
    )
    let finishSpawn: (() => void) | undefined
    spawnPty.mockImplementationOnce(
      () =>
        new Promise<PtyProcess>((resolve) => {
          finishSpawn = () => resolve(pty)
        }),
    )
    const spawning = supervisor.spawn({
      host,
      provider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'stale-pending',
    })
    await Promise.resolve()

    supervisor.disposeAll()
    finishSpawn?.()

    await expect(spawning).rejects.toThrow('cancelled before it started')
    expect(pty.kill).toHaveBeenCalledOnce()
    expect(supervisor.list()).toEqual([])
    expect(events).toEqual([])
  })

  it('drains native PTY exits during final disposal', async () => {
    const { supervisor, pty, host, provider } = fixture()
    await supervisor.spawn({
      host,
      provider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'drained-session',
    })
    pty.kill.mockImplementationOnce(() => {
      queueMicrotask(() => pty.emitExit({ exitCode: 0, signal: undefined }))
    })

    await supervisor.disposeAllAndWait()

    expect(pty.kill).toHaveBeenCalledOnce()
    expect(pty.exitListeners.size).toBe(0)
    expect(supervisor.list()).toEqual([])
  })

  it('cancels a pending spawn when its renderer owner is disposed', async () => {
    const { supervisor, pty, host, provider, spawnPty } = fixture()
    let finishSpawn: (() => void) | undefined
    spawnPty.mockImplementationOnce(
      () =>
        new Promise<PtyProcess>((resolve) => {
          finishSpawn = () => resolve(pty)
        }),
    )
    const spawning = supervisor.spawn({
      host,
      provider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'owner-pending',
    })
    await Promise.resolve()

    supervisor.disposeOwner(OWNER_ID)
    finishSpawn?.()

    await expect(spawning).rejects.toThrow('cancelled before it started')
    expect(pty.kill).toHaveBeenCalledOnce()
    expect(supervisor.list()).toEqual([])
  })

  it('bounds bulk starts per host and cancels a queued session by its owner', async () => {
    const { host, provider, spawnPty } = fixture()
    const supervisor = new PtySupervisor({ bulkStartConcurrencyPerHost: 1 })
    const firstPty = new FakePty()
    const secondPty = new FakePty()
    let finishFirst: (() => void) | undefined
    spawnPty
      .mockImplementationOnce(
        () =>
          new Promise<PtyProcess>((resolve) => {
            finishFirst = () => resolve(firstPty)
          }),
      )
      .mockResolvedValueOnce(secondPty)
    const request = {
      host,
      provider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      admission: 'bulk' as const,
    }

    const first = supervisor.spawn({ ...request, sessionId: 'bulk-first' })
    await vi.waitFor(() => expect(spawnPty).toHaveBeenCalledOnce())
    const second = supervisor.spawn({ ...request, sessionId: 'bulk-second' })
    await Promise.resolve()
    expect(spawnPty).toHaveBeenCalledOnce()
    expect(supervisor.isOwnedBy('bulk-second', OWNER_ID)).toBe(true)
    const cancelled = expect(second).rejects.toThrow('admission was cancelled')
    supervisor.kill('bulk-second', OWNER_ID)
    finishFirst?.()

    await first
    await cancelled
    expect(spawnPty).toHaveBeenCalledOnce()
  })

  it('admits the next bulk start after an isolated launch failure', async () => {
    const { host, provider, spawnPty } = fixture()
    const supervisor = new PtySupervisor({ bulkStartConcurrencyPerHost: 1 })
    const secondPty = new FakePty()
    let failFirst: (() => void) | undefined
    spawnPty
      .mockImplementationOnce(
        () =>
          new Promise<PtyProcess>((_resolve, reject) => {
            failFirst = () => reject(new Error('first launch failed'))
          }),
      )
      .mockResolvedValueOnce(secondPty)
    const request = {
      host,
      provider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      admission: 'bulk' as const,
    }

    const first = supervisor.spawn({ ...request, sessionId: 'bulk-failure' })
    const failed = expect(first).rejects.toThrow('first launch failed')
    await vi.waitFor(() => expect(spawnPty).toHaveBeenCalledOnce())
    const second = supervisor.spawn({ ...request, sessionId: 'bulk-after-failure' })
    failFirst?.()

    await failed
    await expect(second).resolves.toMatchObject({ id: 'bulk-after-failure' })
    expect(spawnPty).toHaveBeenCalledTimes(2)
  })

  it('reports one exit when an SSH PTY closes without exit-status', async () => {
    const channel = Object.assign(new EventEmitter(), {
      close: vi.fn(() => channel.emit('close')),
      setWindow: vi.fn(),
      write: vi.fn(),
    })
    const terminalClient = Object.assign(new EventEmitter(), {
      connect: vi.fn(() => queueMicrotask(() => terminalClient.emit('ready'))),
      exec: vi.fn(
        (
          _command: string,
          _options: unknown,
          callback: (error: Error | undefined, value: unknown) => void,
        ) => callback(undefined, channel),
      ),
      end: vi.fn(() => terminalClient.emit('close')),
      destroy: vi.fn(() => terminalClient.emit('close')),
    })
    const primaryClient = Object.assign(new EventEmitter(), {
      end: vi.fn(() => primaryClient.emit('close')),
      destroy: vi.fn(() => primaryClient.emit('close')),
    })
    const host = createTestSshHost({
      config: {
        alias: 'remote',
        hostname: 'remote.test',
        user: 'picard',
        port: 22,
        identityFiles: [],
      },
      prompter: { prompt: () => Promise.resolve(undefined) },
      clientFactory: () => terminalClient as unknown as Client,
    })
    vi.spyOn(host, 'defaultShell').mockResolvedValue('/bin/sh')
    const internals = host as unknown as { state: 'connected'; client: Client }
    internals.state = 'connected'
    internals.client = primaryClient as unknown as Client
    const supervisor = new PtySupervisor()
    const onExit = vi.fn()
    supervisor.onExit(onExit)

    await supervisor.spawn({
      host,
      provider: plainShellProvider,
      cwd: hostPath(host.hostId, '/project'),
      ownerId: OWNER_ID,
      sessionId: 'remote-close',
    })
    channel.emit('close')
    channel.emit('exit', 7)

    expect(onExit).toHaveBeenCalledOnce()
    expect(onExit).toHaveBeenCalledWith(expect.objectContaining({ id: 'remote-close' }), {
      exitCode: 255,
      signal: undefined,
    })
    await host.dispose()
  })

  it('publishes the exit result, cleans up, and permits deterministic resume', async () => {
    const { supervisor, pty, host, provider, spawnPty } = fixture()
    const exitListener = vi.fn<(info: { id: string }, exit: PtyExit) => void>()
    supervisor.onExit(exitListener)
    const request = {
      host,
      provider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'resumable',
    }
    await supervisor.spawn(request)

    const exit = { exitCode: 7, signal: 15 }
    pty.emitExit(exit)
    pty.emitExit(exit)

    expect(exitListener).toHaveBeenCalledOnce()
    expect(exitListener).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'resumable' }),
      exit,
    )
    expect(supervisor.get('resumable')).toBeUndefined()
    expect(supervisor.list()).toEqual([])

    const resumed = await supervisor.spawn({ ...request, resume: true })
    expect(resumed.resumed).toBe(true)
    expect(spawnPty).toHaveBeenLastCalledWith(
      expect.objectContaining({ args: ['resume'] }),
    )
  })

  it('publishes a session id discovered after launch', async () => {
    const { supervisor, host, provider, spawnPty } = fixture()
    let finishIdentification: ((sessionId: string) => void) | undefined
    Object.assign(provider, {
      sessionIdentity: 'discovered',
      sessionDiscovery: {
        snapshot: vi.fn(() => Promise.resolve(['before'])),
        identify: vi.fn(
          () =>
            new Promise((resolve) => {
              finishIdentification = (sessionId) =>
                resolve({ status: 'identified', sessionId })
            }),
        ),
      },
    })
    const onIdentity = vi.fn<(info: ManagedPty) => void>()
    supervisor.onSessionIdentity(onIdentity)

    const initial = await supervisor.spawn({
      host,
      provider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'terminal-id',
    })
    expect(initial).toMatchObject({
      id: 'terminal-id',
      identityStatus: 'discovering',
      harnessSessionId: undefined,
    })
    expect(spawnPty).toHaveBeenCalledOnce()

    finishIdentification?.('codex-session-id')
    await vi.waitFor(() => expect(onIdentity).toHaveBeenCalledOnce())
    expect(supervisor.get('terminal-id')).toMatchObject({
      harnessSessionId: 'codex-session-id',
      identityStatus: 'identified',
    })
  })

  it('re-arms unavailable identity discovery on later terminal input', async () => {
    const { supervisor, pty, host, provider } = fixture()
    const snapshot = vi.fn(() => Promise.resolve(['pre-launch']))
    const identify = vi
      .fn()
      .mockResolvedValueOnce({ status: 'unavailable' })
      .mockResolvedValueOnce({
        status: 'identified',
        sessionId: 'codex-after-input',
      })
    Object.assign(provider, {
      sessionIdentity: 'discovered',
      sessionDiscovery: { snapshot, identify },
    })
    const onIdentity = vi.fn<(info: ManagedPty) => void>()
    supervisor.onSessionIdentity(onIdentity)

    const info = await supervisor.spawn({
      host,
      provider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'terminal-before-input',
    })
    await vi.waitFor(() =>
      expect(onIdentity).toHaveBeenLastCalledWith(
        expect.objectContaining({ identityStatus: 'unavailable' }),
      ),
    )

    supervisor.write(info.id, OWNER_ID, 'first prompt')

    await vi.waitFor(() =>
      expect(supervisor.get(info.id)).toMatchObject({
        harnessSessionId: 'codex-after-input',
        identityStatus: 'identified',
      }),
    )
    expect(pty.write).toHaveBeenCalledWith('first prompt')
    expect(snapshot).toHaveBeenCalledOnce()
    expect(identify).toHaveBeenCalledTimes(2)
    expect(onIdentity.mock.calls.map(([value]) => value.identityStatus)).toEqual([
      'unavailable',
      'discovering',
      'identified',
    ])
  })

  it('does not let an input-triggered identity retry block a later PTY', async () => {
    const firstPty = new FakePty()
    const secondPty = new FakePty()
    const { supervisor, host, provider, spawnPty } = fixture()
    spawnPty.mockResolvedValueOnce(firstPty).mockResolvedValueOnce(secondPty)
    let finishRetry: (() => void) | undefined
    const identify = vi
      .fn()
      .mockResolvedValueOnce({ status: 'unavailable' })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRetry = () => resolve({ status: 'unavailable' })
          }),
      )
      .mockResolvedValueOnce({ status: 'unavailable' })
    Object.assign(provider, {
      sessionIdentity: 'discovered',
      sessionDiscovery: {
        snapshot: () => Promise.resolve([]),
        identify,
      },
    })

    const first = await supervisor.spawn({
      host,
      provider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'retrying-terminal',
    })
    await vi.waitFor(() =>
      expect(supervisor.get(first.id)?.identityStatus).toBe('unavailable'),
    )
    supervisor.write(first.id, OWNER_ID, 'start')
    await vi.waitFor(() => expect(identify).toHaveBeenCalledTimes(2))

    await supervisor.spawn({
      host,
      provider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'later-terminal',
    })

    expect(spawnPty).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => expect(identify).toHaveBeenCalledTimes(3))
    finishRetry?.()
  })

  it('passes cwd and replays the latest provider telemetry across attachments', async () => {
    const { supervisor, host, provider } = fixture()
    const pending = contextStatusHarnessSnapshot({
      providerId: asHarnessProviderId('test'),
      provenance: 'test fixture',
      sessionId: 'harness-session',
      context: { status: 'pending', reason: 'Waiting for test telemetry' },
    })
    const unavailable = contextStatusHarnessSnapshot({
      providerId: asHarnessProviderId('test'),
      provenance: 'test fixture',
      sessionId: 'harness-session',
      context: { status: 'unavailable', reason: 'Test telemetry unavailable' },
    })
    const disposeTelemetry = vi.fn()
    let emitTelemetry: HarnessTelemetryContext['emit'] | undefined
    const observe = vi.fn((_host: ProjectHost, context: HarnessTelemetryContext) => {
      emitTelemetry = context.emit
      context.emit(pending)
      return disposeTelemetry
    })
    Object.assign(provider, { telemetry: { observe } })

    const info = await supervisor.spawn({
      host,
      provider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'telemetry-session',
    })
    const firstTelemetry = vi.fn()
    const detach = supervisor.attach(info.id, OWNER_ID, {
      onTelemetry: firstTelemetry,
    })

    await vi.waitFor(() => expect(firstTelemetry).toHaveBeenCalledWith(pending))
    expect(observe.mock.calls[0]?.[1].cwd).toEqual(localPath('/tmp/project'))

    void detach()
    emitTelemetry?.(unavailable)
    const reattachedTelemetry = vi.fn()
    supervisor.attach(info.id, OWNER_ID, { onTelemetry: reattachedTelemetry })

    expect(reattachedTelemetry).toHaveBeenCalledOnce()
    expect(reattachedTelemetry).toHaveBeenCalledWith(unavailable)
    supervisor.disposeOwner(OWNER_ID)
    await vi.waitFor(() => expect(disposeTelemetry).toHaveBeenCalledOnce())
  })

  it('publishes and replays a fixed unavailable snapshot when observation rejects', async () => {
    const { supervisor, host, provider } = fixture()
    Object.assign(provider, {
      telemetry: {
        observe: () => Promise.reject(new Error('/private/remote/transcript failed')),
      },
    })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const info = await supervisor.spawn({
      host,
      provider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'rejected-telemetry',
    })
    const firstTelemetry = vi.fn()
    const detach = supervisor.attach(info.id, OWNER_ID, {
      onTelemetry: firstTelemetry,
    })

    await vi.waitFor(() => expect(firstTelemetry).toHaveBeenCalledOnce())
    expect(firstTelemetry.mock.calls[0]?.[0]).toMatchObject({
      source: {
        providerId: 'test',
        provenance: 'Harness telemetry observer lifecycle',
      },
      facets: {
        session: {
          status: 'available',
          value: { id: 'rejected-telemetry', state: 'active' },
        },
        context: {
          status: 'unavailable',
          reason: 'Harness telemetry observer unavailable',
        },
      },
    })
    expect(JSON.stringify(firstTelemetry.mock.calls[0]?.[0])).not.toContain('/private')

    void detach()
    const reattachedTelemetry = vi.fn()
    supervisor.attach(info.id, OWNER_ID, { onTelemetry: reattachedTelemetry })
    expect(reattachedTelemetry).toHaveBeenCalledWith(firstTelemetry.mock.calls[0]?.[0])
    expect(warning).toHaveBeenCalledOnce()
    warning.mockRestore()
  })

  it('retains identity subscriptions when only live sessions are disposed', async () => {
    const firstPty = new FakePty()
    const secondPty = new FakePty()
    const { supervisor, host, provider, spawnPty } = fixture()
    spawnPty.mockResolvedValueOnce(firstPty).mockResolvedValueOnce(secondPty)
    Object.assign(provider, {
      sessionIdentity: 'discovered',
      sessionDiscovery: {
        snapshot: vi.fn(() => Promise.resolve([])),
        identify: vi
          .fn()
          .mockResolvedValueOnce({ status: 'identified', sessionId: 'harness-first' })
          .mockResolvedValueOnce({ status: 'identified', sessionId: 'harness-second' }),
      },
    })
    const onIdentity = vi.fn()
    supervisor.onSessionIdentity(onIdentity)

    await supervisor.spawn({
      host,
      provider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'first-after-project-open',
    })
    await vi.waitFor(() => expect(onIdentity).toHaveBeenCalledTimes(1))

    supervisor.disposeSessions()
    await supervisor.spawn({
      host,
      provider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'second-after-project-open',
    })

    await vi.waitFor(() => expect(onIdentity).toHaveBeenCalledTimes(2))
    expect(onIdentity.mock.calls[1]?.[0]).toMatchObject({
      id: 'second-after-project-open',
      harnessSessionId: 'harness-second',
    })
  })

  it('serializes discovery launches without blocking later PTYs on identity', async () => {
    const firstPty = new FakePty()
    const secondPty = new FakePty()
    const { supervisor, host, provider, spawnPty } = fixture()
    const order: string[] = []
    let finishFirstSpawn: (() => void) | undefined
    let releaseFirst: (() => void) | undefined
    let identifyCount = 0
    Object.assign(provider, {
      sessionIdentity: 'discovered',
      sessionDiscovery: {
        snapshot: vi.fn(() => {
          order.push('snapshot')
          return Promise.resolve([])
        }),
        identify: vi.fn(() => {
          identifyCount++
          order.push('identify')
          if (identifyCount === 1) {
            return new Promise((resolve) => {
              releaseFirst = () => resolve({ status: 'unavailable' })
            })
          }
          return Promise.resolve({ status: 'unavailable' })
        }),
      },
    })
    spawnPty.mockImplementationOnce(() => {
      order.push('spawn')
      return new Promise((resolve) => {
        finishFirstSpawn = () => resolve(firstPty)
      })
    })
    spawnPty.mockImplementationOnce(() => {
      order.push('spawn')
      return Promise.resolve(secondPty)
    })

    const firstSpawn = supervisor.spawn({
      host,
      provider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'first-terminal',
    })
    await vi.waitFor(() => expect(order).toEqual(['snapshot', 'spawn']))
    const secondSpawn = supervisor.spawn({
      host,
      provider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'second-terminal',
    })
    await Promise.resolve()
    expect(order).toEqual(['snapshot', 'spawn'])

    finishFirstSpawn?.()
    await firstSpawn
    await secondSpawn
    await vi.waitFor(() => expect(identifyCount).toBe(2))
    expect(order).toEqual([
      'snapshot',
      'spawn',
      'identify',
      'snapshot',
      'spawn',
      'identify',
    ])
    releaseFirst?.()
  })

  it('fails closed when discovered session identity is ambiguous', async () => {
    const { supervisor, host, provider } = fixture()
    Object.assign(provider, {
      sessionIdentity: 'discovered',
      sessionDiscovery: {
        snapshot: () => Promise.resolve([]),
        identify: () => Promise.resolve({ status: 'ambiguous' }),
      },
    })
    const onIdentity = vi.fn()
    supervisor.onSessionIdentity(onIdentity)

    await supervisor.spawn({
      host,
      provider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'ambiguous-terminal',
    })
    await vi.waitFor(() => expect(onIdentity).toHaveBeenCalledOnce())
    expect(supervisor.get('ambiguous-terminal')).toMatchObject({
      identityStatus: 'ambiguous',
      harnessSessionId: undefined,
    })
  })

  it('requires an exact id to resume a discovered session', async () => {
    const { supervisor, host, provider, spawnPty } = fixture()
    Object.assign(provider, {
      sessionIdentity: 'discovered',
      resume: (ctx: { sessionId: string }) => ({
        file: 'test-harness',
        args: ['resume', ctx.sessionId],
      }),
    })

    await expect(
      supervisor.spawn({
        host,
        provider,
        cwd: localPath('/tmp/project'),
        ownerId: OWNER_ID,
        sessionId: 'new-terminal-id',
        resume: true,
      }),
    ).rejects.toThrow(/requires an exact session id/)

    const resumed = await supervisor.spawn({
      host,
      provider,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'new-terminal-id',
      harnessSessionId: 'exact-harness-id',
      resume: true,
    })
    expect(resumed).toMatchObject({
      resumed: true,
      harnessSessionId: 'exact-harness-id',
      identityStatus: 'identified',
    })
    expect(spawnPty).toHaveBeenCalledWith(
      expect.objectContaining({ args: ['resume', 'exact-harness-id'] }),
    )
  })
})
