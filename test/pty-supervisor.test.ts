import { EventEmitter } from 'node:events'

import type { Client } from 'ssh2'
import { describe, expect, it, vi } from 'vitest'

import {
  plainShellAdapter,
  type HarnessAdapter,
} from '../src/main/harness/harness-adapter'
import type {
  ProjectHost,
  PtyExit,
  PtyProcess,
  SpawnPtyOptions,
} from '../src/main/project-host'
import { PtySupervisor, type ManagedPty } from '../src/main/pty/pty-supervisor'
import { SshHost } from '../src/main/project-host'
import { LOCAL_HOST_ID, hostPath, localPath } from '../src/shared'

const OWNER_ID = 17

class FakePty implements PtyProcess {
  readonly pid = 4242
  readonly dataListeners = new Set<(data: string) => void>()
  readonly exitListeners = new Set<(exit: PtyExit) => void>()
  readonly write = vi.fn<(data: string) => void>()
  readonly resize = vi.fn<(cols: number, rows: number) => void>()
  readonly kill = vi.fn<(signal?: string) => void>()

  onData(cb: (data: string) => void): () => void {
    this.dataListeners.add(cb)
    return () => this.dataListeners.delete(cb)
  }

  onExit(cb: (exit: PtyExit) => void): () => void {
    this.exitListeners.add(cb)
    return () => this.exitListeners.delete(cb)
  }

  emitData(data: string): void {
    for (const cb of this.dataListeners) cb(data)
  }

  emitExit(exit: PtyExit): void {
    for (const cb of [...this.exitListeners]) cb(exit)
  }
}

function fixture(): {
  supervisor: PtySupervisor
  pty: FakePty
  host: ProjectHost
  adapter: HarnessAdapter
  spawnPty: ReturnType<typeof vi.fn<(opts: SpawnPtyOptions) => Promise<PtyProcess>>>
  defaultShell: ReturnType<typeof vi.fn<() => Promise<string>>>
} {
  const pty = new FakePty()
  const spawnPty = vi.fn((_opts: SpawnPtyOptions): Promise<PtyProcess> =>
    Promise.resolve(pty),
  )
  const defaultShell = vi.fn(() => Promise.resolve('/remote/bin/bash'))
  const host = {
    hostId: LOCAL_HOST_ID,
    defaultShell,
    spawnPty,
  } as unknown as ProjectHost
  const adapter: HarnessAdapter = {
    id: 'test',
    displayName: 'Test',
    supportsResume: true,
    sessionIdentity: 'preassigned',
    launch: () => ({ file: 'test-harness', args: ['launch'] }),
    resume: () => ({ file: 'test-harness', args: ['resume'] }),
  }
  return { supervisor: new PtySupervisor(), pty, host, adapter, spawnPty, defaultShell }
}

describe('PtySupervisor', () => {
  it('launches a plain shell resolved by the owning host', async () => {
    const { supervisor, host, spawnPty, defaultShell } = fixture()
    await supervisor.spawn({
      host,
      adapter: plainShellAdapter,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'host-shell',
    })

    expect(defaultShell).toHaveBeenCalledOnce()
    expect(spawnPty).toHaveBeenCalledWith(
      expect.objectContaining({
        file: '/remote/bin/bash',
        args: [],
        env: {
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          TERM_PROGRAM: 'hvir',
        },
      }),
    )
  })

  it('is the lifecycle and stream boundary for a spawned PTY', async () => {
    const { supervisor, pty, host, adapter, spawnPty } = fixture()
    const info = await supervisor.spawn({
      host,
      adapter,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'session-1',
    })

    expect(info).toMatchObject({
      id: 'session-1',
      ownerId: OWNER_ID,
      hostId: LOCAL_HOST_ID,
      adapterId: 'test',
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

  it('replays bounded initial output in order on the first renderer attach', async () => {
    const { supervisor, pty, host, adapter } = fixture()
    const info = await supervisor.spawn({
      host,
      adapter,
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
    const { supervisor, pty, host, adapter } = fixture()
    const info = await supervisor.spawn({
      host,
      adapter,
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
    const { supervisor, host, adapter, spawnPty } = fixture()
    spawnPty.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    await supervisor.spawn({
      host,
      adapter,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'owned-first',
    })
    await supervisor.spawn({
      host,
      adapter,
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

  it('rejects an already-active session id without leaking another PTY', async () => {
    const { supervisor, host, adapter, spawnPty } = fixture()
    const request = {
      host,
      adapter,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'same-session',
    }
    await supervisor.spawn(request)
    await expect(supervisor.spawn(request)).rejects.toThrow(/already active/)
    expect(spawnPty).toHaveBeenCalledTimes(1)
  })

  it('reserves a session id while its asynchronous host spawn is pending', async () => {
    const { supervisor, pty, host, adapter, spawnPty } = fixture()
    let finishSpawn: (() => void) | undefined
    spawnPty.mockImplementationOnce(
      () =>
        new Promise<PtyProcess>((resolve) => {
          finishSpawn = () => resolve(pty)
        }),
    )
    const request = {
      host,
      adapter,
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
    const { supervisor, pty, host, adapter, spawnPty } = fixture()
    let finishSpawn: (() => void) | undefined
    spawnPty.mockImplementationOnce(
      () =>
        new Promise<PtyProcess>((resolve) => {
          finishSpawn = () => resolve(pty)
        }),
    )
    const spawning = supervisor.spawn({
      host,
      adapter,
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
  })

  it('cancels a pending spawn when its renderer owner is disposed', async () => {
    const { supervisor, pty, host, adapter, spawnPty } = fixture()
    let finishSpawn: (() => void) | undefined
    spawnPty.mockImplementationOnce(
      () =>
        new Promise<PtyProcess>((resolve) => {
          finishSpawn = () => resolve(pty)
        }),
    )
    const spawning = supervisor.spawn({
      host,
      adapter,
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

  it('reports one exit when an SSH PTY closes without exit-status', async () => {
    const channel = Object.assign(new EventEmitter(), {
      close: vi.fn(() => channel.emit('close')),
      setWindow: vi.fn(),
      write: vi.fn(),
    })
    const client = Object.assign(new EventEmitter(), {
      exec: vi.fn(
        (
          _command: string,
          _options: unknown,
          callback: (error: Error | undefined, value: unknown) => void,
        ) => callback(undefined, channel),
      ),
      end: vi.fn(() => client.emit('close')),
      destroy: vi.fn(() => client.emit('close')),
    })
    const host = new SshHost({
      config: {
        alias: 'remote',
        hostname: 'remote.test',
        user: 'picard',
        port: 22,
        identityFiles: [],
      },
      prompter: { prompt: () => Promise.resolve(undefined) },
    })
    vi.spyOn(host, 'defaultShell').mockResolvedValue('/bin/sh')
    const internals = host as unknown as { state: 'connected'; client: Client }
    internals.state = 'connected'
    internals.client = client as unknown as Client
    const supervisor = new PtySupervisor()
    const onExit = vi.fn()
    supervisor.onExit(onExit)

    await supervisor.spawn({
      host,
      adapter: plainShellAdapter,
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
    const { supervisor, pty, host, adapter, spawnPty } = fixture()
    const exitListener = vi.fn<(info: { id: string }, exit: PtyExit) => void>()
    supervisor.onExit(exitListener)
    const request = {
      host,
      adapter,
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
    const { supervisor, host, adapter, spawnPty } = fixture()
    let finishIdentification: ((sessionId: string) => void) | undefined
    Object.assign(adapter, {
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
      adapter,
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
    const { supervisor, pty, host, adapter } = fixture()
    const snapshot = vi.fn(() => Promise.resolve(['pre-launch']))
    const identify = vi
      .fn()
      .mockResolvedValueOnce({ status: 'unavailable' })
      .mockResolvedValueOnce({
        status: 'identified',
        sessionId: 'codex-after-input',
      })
    Object.assign(adapter, {
      sessionIdentity: 'discovered',
      sessionDiscovery: { snapshot, identify },
    })
    const onIdentity = vi.fn<(info: ManagedPty) => void>()
    supervisor.onSessionIdentity(onIdentity)

    const info = await supervisor.spawn({
      host,
      adapter,
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

  it('caches adapter telemetry for attachment and disposes it with the PTY', async () => {
    const { supervisor, host, adapter } = fixture()
    const telemetry = {
      contextUsedTokens: 80_000,
      contextWindowTokens: 200_000,
      contextUsedPercent: 40,
    }
    const disposeTelemetry = vi.fn()
    const observe = vi.fn(
      (_host: ProjectHost, context: { emit: (value: typeof telemetry) => void }) => {
        context.emit(telemetry)
        return disposeTelemetry
      },
    )
    Object.assign(adapter, { telemetry: { observe } })

    const info = await supervisor.spawn({
      host,
      adapter,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'telemetry-session',
    })
    const onTelemetry = vi.fn()
    supervisor.attach(info.id, OWNER_ID, { onTelemetry })

    expect(onTelemetry).toHaveBeenCalledOnce()
    expect(onTelemetry).toHaveBeenCalledWith(telemetry)
    supervisor.disposeOwner(OWNER_ID)
    await vi.waitFor(() => expect(disposeTelemetry).toHaveBeenCalledOnce())
  })

  it('retains identity subscriptions when only live sessions are disposed', async () => {
    const firstPty = new FakePty()
    const secondPty = new FakePty()
    const { supervisor, host, adapter, spawnPty } = fixture()
    spawnPty.mockResolvedValueOnce(firstPty).mockResolvedValueOnce(secondPty)
    Object.assign(adapter, {
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
      adapter,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'first-after-project-open',
    })
    await vi.waitFor(() => expect(onIdentity).toHaveBeenCalledTimes(1))

    supervisor.disposeSessions()
    await supervisor.spawn({
      host,
      adapter,
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

  it('serializes discovery windows for the same host and adapter', async () => {
    const firstPty = new FakePty()
    const secondPty = new FakePty()
    const { supervisor, host, adapter, spawnPty } = fixture()
    const order: string[] = []
    let releaseFirst: (() => void) | undefined
    let identifyCount = 0
    Object.assign(adapter, {
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
      return Promise.resolve(firstPty)
    })
    spawnPty.mockImplementationOnce(() => {
      order.push('spawn')
      return Promise.resolve(secondPty)
    })

    await supervisor.spawn({
      host,
      adapter,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'first-terminal',
    })
    const secondSpawn = supervisor.spawn({
      host,
      adapter,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'second-terminal',
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual(['snapshot', 'spawn', 'identify'])

    releaseFirst?.()
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
  })

  it('fails closed when discovered session identity is ambiguous', async () => {
    const { supervisor, host, adapter } = fixture()
    Object.assign(adapter, {
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
      adapter,
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

  it('still launches when the discovery snapshot is unavailable', async () => {
    const { supervisor, host, adapter, spawnPty } = fixture()
    const identify = vi.fn()
    Object.assign(adapter, {
      sessionIdentity: 'discovered',
      sessionDiscovery: {
        snapshot: () => Promise.reject(new Error('scan failed')),
        identify,
      },
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const info = await supervisor.spawn({
      host,
      adapter,
      cwd: localPath('/tmp/project'),
      ownerId: OWNER_ID,
      sessionId: 'snapshot-failed',
    })

    expect(spawnPty).toHaveBeenCalledOnce()
    expect(info.identityStatus).toBe('unavailable')
    expect(identify).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('requires an exact id to resume a discovered session', async () => {
    const { supervisor, host, adapter, spawnPty } = fixture()
    Object.assign(adapter, {
      sessionIdentity: 'discovered',
      resume: (ctx: { sessionId: string }) => ({
        file: 'test-harness',
        args: ['resume', ctx.sessionId],
      }),
    })

    await expect(
      supervisor.spawn({
        host,
        adapter,
        cwd: localPath('/tmp/project'),
        ownerId: OWNER_ID,
        sessionId: 'new-terminal-id',
        resume: true,
      }),
    ).rejects.toThrow(/requires an exact session id/)

    const resumed = await supervisor.spawn({
      host,
      adapter,
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
