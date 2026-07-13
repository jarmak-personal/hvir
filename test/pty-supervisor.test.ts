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
import { PtySupervisor } from '../src/main/pty/pty-supervisor'
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
})
