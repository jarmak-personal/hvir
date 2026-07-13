import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AnyAuthMethod, Client, ConnectConfig } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  SshHost,
  type Disposer,
  type ExecStreamHandle,
  type SshPrompt,
  type WatchOptions,
} from '../src/main/project-host'
import { asHostId, hostPath, type HostPath, type WatchEvent } from '../src/shared'

const cleanups: string[] = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true })))
})

describe('SshHost authentication', () => {
  it('prompts for an encrypted modern OpenSSH key after the agent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hvir-ssh-key-'))
    cleanups.push(root)
    const keyPath = join(root, 'id_ed25519')
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', 'key secret', '-f', keyPath])
    const privateKey = await readFile(keyPath)
    expect(privateKey.toString()).toContain('OPENSSH PRIVATE KEY')
    expect(privateKey.toString()).not.toContain('ENCRYPTED')
    const prompts: SshPrompt[] = []
    const host = new SshHost({
      config: aliasConfig(),
      agentSocket: '/tmp/agent.sock',
      identities: [{ path: keyPath, privateKey }],
      prompter: {
        prompt: (request) => {
          prompts.push(request)
          return Promise.resolve(['key secret'])
        },
      },
    })
    const config = connectConfig(host)

    const agent = await nextAuth(config, null)
    expect(agent).toMatchObject({ type: 'agent' })
    const key = await nextAuth(config, ['publickey'])

    expect(prompts).toEqual([expect.objectContaining({ kind: 'passphrase' })])
    expect(key).toMatchObject({ type: 'publickey', passphrase: 'key secret' })
  })

  it('accepts a remembered host fingerprint without prompting again', () => {
    const prompt = vi.fn<() => Promise<readonly string[] | undefined>>()
    const host = new SshHost({
      config: aliasConfig(),
      prompter: { prompt },
      trustedHostKey: () => fingerprint(Buffer.from('trusted-host-key')),
    })
    const verifier = connectConfig(host).hostVerifier as unknown as (
      key: Buffer,
      verify: (valid: boolean) => void,
    ) => void
    const verify = vi.fn()
    expect(verifier).toBeTypeOf('function')
    expect(verifier(Buffer.from('trusted-host-key'), verify)).toBeUndefined()
    expect(verify).toHaveBeenCalledWith(true)
    expect(prompt).not.toHaveBeenCalled()
  })

  it('waits for an unknown host to be trusted before verifying it', async () => {
    const remember = vi.fn<() => Promise<void>>(() => Promise.resolve())
    const host = new SshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(['yes']) },
      trustedHostKey: () => undefined,
      rememberHostKey: remember,
    })
    const verifier = connectConfig(host).hostVerifier as unknown as (
      key: Buffer,
      verify: (valid: boolean) => void,
    ) => void
    const verify = vi.fn()

    expect(verifier(Buffer.from('new-host-key'), verify)).toBeUndefined()
    await vi.waitFor(() => expect(verify).toHaveBeenCalledWith(true))
    expect(remember).toHaveBeenCalledWith(expect.stringMatching(/^SHA256:/))
  })

  it('presents a saved-key mismatch as a distinct high-risk prompt', async () => {
    const prompts: SshPrompt[] = []
    const remember = vi.fn<() => Promise<void>>(() => Promise.resolve())
    const host = new SshHost({
      config: aliasConfig(),
      prompter: {
        prompt: (request) => {
          prompts.push(request)
          return Promise.resolve(['yes'])
        },
      },
      trustedHostKey: () => 'SHA256:oldSavedFingerprint0123456789',
      rememberHostKey: remember,
    })
    const verifier = connectConfig(host).hostVerifier as unknown as (
      key: Buffer,
      verify: (valid: boolean) => void,
    ) => void
    const verify = vi.fn()

    verifier(Buffer.from('replacement-host-key'), verify)
    await vi.waitFor(() => expect(verify).toHaveBeenCalledWith(true))
    expect(prompts[0]).toMatchObject({
      hostId: 'example',
      kind: 'host-key-changed',
      previousFingerprint: 'SHA256:oldSavedFingerprint0123456789',
    })
    expect(remember).toHaveBeenCalledOnce()
  })
})

describe('SshHost remote behavior', () => {
  it('invalidates cached parent listings when watched children change', () => {
    const host = new SshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(undefined) },
    })
    const cache = new Map<string, unknown>([
      ['d:/project', []],
      ['d:/project/new-dir', []],
      ['f:/project/new-dir/file.txt', Buffer.from('old')],
      ['d:/unrelated', []],
    ])
    const internals = host as unknown as {
      cache: Map<string, unknown>
      invalidate(path: string): void
    }
    internals.cache = cache

    internals.invalidate('/project/new-dir/file.txt')

    expect([...cache.keys()]).toEqual(['d:/unrelated'])
  })

  it('cancels a connecting transport even when ssh2 emits no close event', async () => {
    vi.useFakeTimers()
    try {
      const silent = fakeClient(() => undefined)
      silent.end.mockImplementation(() => undefined)
      const host = new SshHost({
        config: aliasConfig(),
        prompter: { prompt: () => Promise.resolve(undefined) },
        clientFactory: () => silent as unknown as Client,
      })
      const connecting = host.connect()
      const rejected = expect(connecting).rejects.toThrow('SSH connection cancelled')
      const disposing = host.dispose()
      await vi.advanceTimersByTimeAsync(1_000)
      await disposing

      await rejected
      expect(host.connectionState).toBe('disconnected')
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a pre-ready close and allows a later explicit reconnect', async () => {
    const closing = fakeClient(() => queueMicrotask(() => closing.emit('close')))
    const ready = fakeClient(() => queueMicrotask(() => ready.emit('ready')))
    const clients = [closing, ready]
    const host = new SshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(undefined) },
      clientFactory: () => clients.shift() as unknown as Client,
    })
    vi.spyOn(host, 'exec').mockResolvedValue({
      code: 1,
      signal: null,
      stdout: '',
      stderr: '',
    })

    await expect(host.connect()).rejects.toThrow(
      'SSH connection closed before authentication completed',
    )
    await expect(host.connect()).resolves.toBeUndefined()
    expect(host.connectionState).toBe('connected')
    await host.dispose()
  })

  it('does not let a late close from an old client clobber a new client', async () => {
    const oldClient = fakeClient(() => queueMicrotask(() => oldClient.emit('ready')))
    const newClient = fakeClient(() => queueMicrotask(() => newClient.emit('ready')))
    const clients = [oldClient, newClient]
    const host = new SshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(undefined) },
      clientFactory: () => clients.shift() as unknown as Client,
    })
    vi.spyOn(host, 'exec').mockResolvedValue({
      code: 1,
      signal: null,
      stdout: '',
      stderr: '',
    })
    const internals = host as unknown as {
      open(): Promise<void>
      client?: Client
    }

    await internals.open()
    await internals.open()
    oldClient.emit('close')

    expect(internals.client).toBe(newClient)
    await host.dispose()
  })

  it('waits briefly for the SSH transport to close during disposal', async () => {
    vi.useFakeTimers()
    try {
      const host = new SshHost({
        config: aliasConfig(),
        prompter: { prompt: () => Promise.resolve(undefined) },
      })
      const client = Object.assign(new EventEmitter(), {
        end: vi.fn(() => setTimeout(() => client.emit('close'), 25)),
      })
      ;(host as unknown as { client: typeof client }).client = client
      let finished = false
      const disposing = host.dispose().then(() => {
        finished = true
      })

      await vi.advanceTimersByTimeAsync(24)
      expect(finished).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await disposing
      expect(finished).toBe(true)
      expect(client.end).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not implicitly reconnect after an explicit disconnect', async () => {
    const host = new SshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(undefined) },
    })
    await host.dispose()
    const connect = vi.spyOn(host, 'connect')

    await expect(host.exec('true', [])).rejects.toThrow(
      'SSH host is disconnected; reconnect explicitly before retrying',
    )
    expect(connect).not.toHaveBeenCalled()
  })

  it('cancels a scheduled reconnect on explicit disconnect', async () => {
    vi.useFakeTimers()
    try {
      const factory = vi.fn<() => Client>()
      const host = new SshHost({
        config: aliasConfig(),
        prompter: { prompt: () => Promise.resolve(undefined) },
        clientFactory: factory,
      })
      ;(host as unknown as { scheduleReconnect(): void }).scheduleReconnect()

      await host.dispose()
      await vi.advanceTimersByTimeAsync(60_000)

      expect(factory).not.toHaveBeenCalled()
      expect(host.connectionState).toBe('disconnected')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not loop modal authentication after one automatic reconnect failure', async () => {
    vi.useFakeTimers()
    try {
      const host = new SshHost({
        config: aliasConfig(),
        prompter: { prompt: () => Promise.resolve(['wrong']) },
      })
      const internals = host as unknown as {
        promptedDuringConnect: boolean
        beginConnect(): Promise<void>
        scheduleReconnect(): void
      }
      internals.promptedDuringConnect = true
      const reconnect = vi
        .spyOn(internals, 'beginConnect')
        .mockRejectedValue(new Error('authentication failed'))

      internals.scheduleReconnect()
      await vi.advanceTimersByTimeAsync(60_000)

      expect(reconnect).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(reconnect).toHaveBeenCalledOnce()
      await host.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reuses one multiplexed SFTP session for concurrent operations', async () => {
    const session = Object.assign(new EventEmitter(), { end: vi.fn() })
    const client = Object.assign(
      fakeClient(() => undefined),
      {
        sftp: vi.fn((callback: (error: Error | undefined, value: unknown) => void) =>
          callback(undefined, session),
        ),
      },
    )
    const host = new SshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(undefined) },
    })
    const internals = host as unknown as {
      state: 'connected'
      client: Client
      getSftp(): Promise<unknown>
    }
    internals.state = 'connected'
    internals.client = client as unknown as Client

    const [first, second] = await Promise.all([internals.getSftp(), internals.getSftp()])

    expect(first).toBe(session)
    expect(second).toBe(session)
    expect(client.sftp).toHaveBeenCalledOnce()
    await host.dispose()
    expect(session.end).toHaveBeenCalledOnce()
  })

  it('decodes remote exec output across UTF-8 chunk boundaries', async () => {
    const stderr = new EventEmitter()
    const channel = Object.assign(new EventEmitter(), {
      stderr,
      close: vi.fn(() => channel.emit('close')),
      end: vi.fn(() => {
        channel.emit('data', Buffer.from([0xe2]))
        queueMicrotask(() => {
          channel.emit('data', Buffer.from([0x82, 0xac]))
          channel.emit('exit', 0)
          channel.emit('close')
        })
      }),
    })
    const client = Object.assign(
      fakeClient(() => undefined),
      {
        exec: vi.fn(
          (
            _command: string,
            callback: (error: Error | undefined, value: unknown) => void,
          ) => callback(undefined, channel),
        ),
      },
    )
    const host = new SshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(undefined) },
    })
    const internals = host as unknown as { state: 'connected'; client: Client }
    internals.state = 'connected'
    internals.client = client as unknown as Client

    const result = await host.exec('printf', [])

    expect(result.stdout).toBe('€')
    expect(result.stdout).not.toContain('�')
    await host.dispose()
  })

  it('resolves and caches the remote host shell', async () => {
    const host = new SshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(undefined) },
    })
    const exec = vi
      .spyOn(host, 'exec')
      .mockResolvedValue({ code: 0, signal: null, stdout: '/bin/bash\n', stderr: '' })

    await expect(host.defaultShell()).resolves.toBe('/bin/bash')
    await expect(host.defaultShell()).resolves.toBe('/bin/bash')
    expect(exec).toHaveBeenCalledOnce()
  })

  it('never overlaps remote polling snapshots', async () => {
    vi.useFakeTimers()
    try {
      const host = new SshHost({
        config: aliasConfig(),
        pollIntervalMs: 10,
        prompter: { prompt: () => Promise.resolve(undefined) },
      })
      let finishFirst: ((snapshot: Map<string, string>) => void) | undefined
      const first = new Promise<Map<string, string>>((resolve) => {
        finishFirst = resolve
      })
      const snapshot = vi
        .fn<() => Promise<Map<string, string>>>()
        .mockReturnValueOnce(first)
        .mockResolvedValue(new Map())
      const internals = host as unknown as {
        pollSnapshot(path: HostPath, opts: WatchOptions): Promise<Map<string, string>>
        watchPolling(
          path: HostPath,
          onEvent: (event: WatchEvent) => void,
          opts: WatchOptions,
        ): Disposer
      }
      internals.pollSnapshot = snapshot
      const stop = internals.watchPolling(
        hostPath(asHostId('example'), '/project'),
        () => undefined,
        {},
      )

      await vi.advanceTimersByTimeAsync(100)
      expect(snapshot).toHaveBeenCalledOnce()
      finishFirst?.(new Map())
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(10)
      expect(snapshot).toHaveBeenCalledTimes(2)
      await stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses a polling watchdog when inotify stays silent', async () => {
    vi.useFakeTimers()
    try {
      const host = new SshHost({
        config: aliasConfig(),
        watchdogIntervalMs: 10,
        prompter: { prompt: () => Promise.resolve(undefined) },
      })
      const root = hostPath(asHostId('example'), '/project')
      const added = '/project/generated'
      const snapshot = vi
        .fn<() => Promise<Map<string, string>>>()
        .mockResolvedValueOnce(new Map())
        .mockResolvedValueOnce(new Map([[added, 'dir:1:0:16877']]))
        .mockResolvedValueOnce(new Map())
      const silentInotify: ExecStreamHandle = {
        onStdout: () => () => undefined,
        onStderr: () => () => undefined,
        onError: () => () => undefined,
        onExit: () => () => undefined,
        kill: () => undefined,
        dispose: vi.fn(),
      }
      const internals = host as unknown as {
        cache: Map<string, unknown>
        execStream(): ExecStreamHandle
        pollSnapshot(path: HostPath, opts: WatchOptions): Promise<Map<string, string>>
        watchInotify(
          path: HostPath,
          onEvent: (event: WatchEvent) => void,
          opts: WatchOptions,
        ): Disposer
      }
      internals.execStream = () => silentInotify
      internals.pollSnapshot = snapshot
      const events: WatchEvent[] = []
      const stop = internals.watchInotify(root, (event) => events.push(event), {})

      await Promise.resolve()
      await Promise.resolve()
      expect(snapshot).toHaveBeenCalledOnce()
      internals.cache.set('d:/project', {})
      await vi.advanceTimersByTimeAsync(10)
      expect(snapshot).toHaveBeenCalledTimes(2)
      expect(events).toContainEqual({
        type: 'addDir',
        path: hostPath(root.hostId, added),
      })
      expect(internals.cache.has('d:/project')).toBe(false)

      internals.cache.set('d:/project', {})
      await vi.advanceTimersByTimeAsync(10)
      expect(snapshot).toHaveBeenCalledTimes(3)
      expect(events).toContainEqual({
        type: 'unlinkDir',
        path: hostPath(root.hostId, added),
      })
      expect(internals.cache.has('d:/project')).toBe(false)

      await stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('emits a bounded tree refresh pulse even when the watch backend stalls', async () => {
    vi.useFakeTimers()
    try {
      const host = new SshHost({
        config: aliasConfig(),
        refreshPulseIntervalMs: 10,
        prompter: { prompt: () => Promise.resolve(undefined) },
      })
      const root = hostPath(asHostId('example'), '/project')
      const stopBackend = vi.fn()
      const internals = host as unknown as {
        state: 'connected'
        tier: 'inotify'
        watchInotify(
          path: HostPath,
          onEvent: (event: WatchEvent) => void,
          opts: WatchOptions,
        ): Disposer
      }
      internals.state = 'connected'
      internals.tier = 'inotify'
      internals.watchInotify = () => stopBackend
      const events: WatchEvent[] = []

      const stop = host.watch(root, (event) => events.push(event))
      await vi.advanceTimersByTimeAsync(9)
      expect(events).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      expect(events).toEqual([{ type: 'change', path: root }])

      await stop()
      await vi.advanceTimersByTimeAsync(20)
      expect(events).toHaveLength(1)
      expect(stopBackend).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('suppresses an in-flight polling error after the watcher stops', async () => {
    const host = new SshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(undefined) },
    })
    let failSnapshot: ((error: Error) => void) | undefined
    const snapshot = vi.fn(
      () =>
        new Promise<Map<string, string>>((_resolve, reject) => {
          failSnapshot = reject
        }),
    )
    const internals = host as unknown as {
      pollSnapshot(path: HostPath, opts: WatchOptions): Promise<Map<string, string>>
      watchPolling(
        path: HostPath,
        onEvent: (event: WatchEvent) => void,
        opts: WatchOptions,
      ): Disposer
    }
    internals.pollSnapshot = snapshot
    const onError = vi.fn()
    const stop = internals.watchPolling(
      hostPath(asHostId('example'), '/project'),
      () => undefined,
      { onError },
    )

    await stop()
    failSnapshot?.(new Error('No response from server'))
    await Promise.resolve()
    await Promise.resolve()
    expect(onError).not.toHaveBeenCalled()
  })
})

function fakeClient(connect: () => void): EventEmitter & {
  connect: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
} {
  const client = Object.assign(new EventEmitter(), {
    connect: vi.fn(connect),
    end: vi.fn(() => client.emit('close')),
  })
  return client
}

function fingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}

function aliasConfig() {
  return {
    alias: 'example',
    hostname: 'example.test',
    user: 'picard',
    port: 22,
    identityFiles: [],
  }
}

function connectConfig(host: SshHost): ConnectConfig {
  return (host as unknown as { connectConfig(): ConnectConfig }).connectConfig()
}

function nextAuth(
  config: ConnectConfig,
  methods: readonly string[] | null,
): Promise<AnyAuthMethod | false> {
  const handler = config.authHandler as unknown as (
    methods: readonly string[] | null,
    partial: boolean | null,
    next: (method: AnyAuthMethod | false) => void,
  ) => void
  return new Promise((resolve) =>
    handler(methods, methods === null ? null : false, resolve),
  )
}
