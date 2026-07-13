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

  it('stops the entire auth ladder when an identity prompt is cancelled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hvir-ssh-key-'))
    cleanups.push(root)
    const keyPath = join(root, 'id_ed25519')
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', 'secret', '-f', keyPath])
    const prompt = vi.fn(() => Promise.resolve(undefined))
    const host = new SshHost({
      config: aliasConfig(),
      identities: [{ path: keyPath, privateKey: await readFile(keyPath) }],
      prompter: { prompt },
    })
    const config = connectConfig(host)

    await expect(nextAuth(config, null)).resolves.toBe(false)
    await expect(nextAuth(config, ['keyboard-interactive', 'password'])).resolves.toBe(
      false,
    )
    expect(prompt).toHaveBeenCalledOnce()
  })

  it('does not fall through to password after keyboard-interactive is cancelled', async () => {
    const prompt = vi.fn(() => Promise.resolve(undefined))
    const host = new SshHost({
      config: aliasConfig(),
      prompter: { prompt },
    })
    const config = connectConfig(host)
    const keyboard = await nextAuth(config, null)
    expect(keyboard).toMatchObject({ type: 'keyboard-interactive' })
    if (keyboard === false || keyboard.type !== 'keyboard-interactive') {
      throw new Error('Expected keyboard-interactive authentication')
    }
    const answers = await new Promise<readonly string[]>((resolve) => {
      keyboard.prompt(
        'Second factor',
        'Enter the code',
        '',
        [{ prompt: 'Code', echo: false }],
        resolve,
      )
    })

    expect(answers).toEqual([])
    await expect(nextAuth(config, ['password'])).resolves.toBe(false)
    expect(prompt).toHaveBeenCalledOnce()
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

  it('invalidates every cached descendant when the watched root is slash', () => {
    const host = new SshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(undefined) },
    })
    const cache = new Map<string, unknown>([
      ['d:/', []],
      ['d:/home', []],
      ['f:/home/picard/file.txt', Buffer.from('old')],
    ])
    const internals = host as unknown as {
      cache: Map<string, unknown>
      invalidate(path: string): void
    }
    internals.cache = cache

    internals.invalidate('/')

    expect(cache.size).toBe(0)
  })

  it.each([
    ['agent socket', 'agent', 'connect ENOENT'],
    ['key signing', 'client-authentication', 'Error signing data with key: denied'],
  ])('continues after a recoverable %s error', async (_label, level, message) => {
    const client = fakeClient(() => {
      queueMicrotask(() => {
        client.emit('error', Object.assign(new Error(message), { level }))
        client.emit('ready')
      })
    })
    const host = new SshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(undefined) },
      clientFactory: () => client as unknown as Client,
    })
    vi.spyOn(host, 'exec').mockResolvedValue({
      code: 1,
      signal: null,
      stdout: '',
      stderr: '',
    })

    await expect(host.connect()).resolves.toBeUndefined()
    expect(host.connectionState).toBe('connected')
    await host.dispose()
  })

  it('still rejects a fatal error after a recoverable auth error', async () => {
    const client = fakeClient(() => {
      queueMicrotask(() => {
        client.emit(
          'error',
          Object.assign(new Error('agent unavailable'), { level: 'agent' }),
        )
        client.emit(
          'error',
          Object.assign(new Error('socket failed'), { level: 'client-socket' }),
        )
      })
    })
    const host = new SshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(undefined) },
      clientFactory: () => client as unknown as Client,
    })

    await expect(host.connect()).rejects.toThrow('socket failed')
    await host.dispose()
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
    expect(host.connectionState).toBe('connected')
    await host.dispose()
  })

  it('keeps an authenticated transport when capability detection fails', async () => {
    const client = fakeClient(() => queueMicrotask(() => client.emit('ready')))
    const host = new SshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(undefined) },
      clientFactory: () => client as unknown as Client,
    })
    vi.spyOn(host, 'exec').mockRejectedValue(new Error('probe unavailable'))

    await expect(host.connect()).resolves.toBeUndefined()
    expect(host.connectionState).toBe('connected')
    expect(host.watchTier).toBe('polling')
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

  it('force-destroys a transport that does not close during disposal', async () => {
    vi.useFakeTimers()
    try {
      const client = fakeClient(() => undefined)
      client.end.mockImplementation(() => undefined)
      client.destroy.mockImplementation(() => undefined)
      const host = new SshHost({
        config: aliasConfig(),
        prompter: { prompt: () => Promise.resolve(undefined) },
      })
      ;(host as unknown as { client: Client }).client = client as unknown as Client

      const disposing = host.dispose()
      await vi.advanceTimersByTimeAsync(1_000)
      await disposing

      expect(client.destroy).toHaveBeenCalledOnce()
      expect(host.connectionState).toBe('disconnected')
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

  it('resolves and browses an in-project remote directory symlink', async () => {
    const session = {
      realpath: vi.fn(
        (_path: string, callback: (error: Error | undefined, value: string) => void) =>
          callback(undefined, '/project/target'),
      ),
      lstat: vi.fn(
        (_path: string, callback: (error: Error | undefined, value: unknown) => void) =>
          callback(undefined, {
            mode: 0o040755,
            size: 0,
            mtime: 100,
          }),
      ),
      readdir: vi.fn(
        (_path: string, callback: (error: Error | undefined, value: unknown[]) => void) =>
          callback(undefined, [
            {
              filename: 'inside.txt',
              attrs: { mode: 0o100644, size: 7, mtime: 100 },
            },
          ]),
      ),
    }
    const host = new SshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(undefined) },
    })
    ;(host as unknown as { getSftp(): Promise<unknown> }).getSftp = () =>
      Promise.resolve(session)
    const link = hostPath(host.hostId, '/project/linked')

    expect((await host.realpath(link)).path).toBe('/project/target')
    expect((await host.stat(hostPath(host.hostId, '/project/target'))).type).toBe('dir')
    expect((await host.readdir(link)).map((entry) => entry.name)).toEqual(['inside.txt'])
  })

  it('saves through a same-directory temporary file and atomic rename', async () => {
    const operations: string[] = []
    const session = {
      lstat: vi.fn(
        (
          path: string,
          callback: (error: Error | undefined, attrs: { mode: number }) => void,
        ) => {
          operations.push(`stat:${path}`)
          callback(undefined, { mode: 0o100640 })
        },
      ),
      writeFile: vi.fn(
        (
          path: string,
          _data: Buffer,
          options: { mode?: number },
          callback: (error?: Error) => void,
        ) => {
          operations.push(`write:${path}:${String(options.mode)}`)
          callback()
        },
      ),
      ext_openssh_rename: vi.fn(
        (source: string, target: string, callback: (error?: Error) => void) => {
          operations.push(`rename:${source}:${target}`)
          callback()
        },
      ),
      rename: vi.fn(),
      unlink: vi.fn(),
    }
    const host = new SshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(undefined) },
    })
    ;(host as unknown as { getSftp(): Promise<unknown> }).getSftp = () =>
      Promise.resolve(session)

    await host.writeFile(hostPath(host.hostId, '/project/file.txt'), 'replacement')

    expect(operations).toHaveLength(3)
    expect(operations[0]).toBe('stat:/project/file.txt')
    expect(operations[1]).toMatch(
      /^write:\/project\/\.file\.txt\.hvir-[0-9a-f-]+\.tmp:416$/,
    )
    expect(operations[2]).toMatch(
      /^rename:\/project\/\.file\.txt\.hvir-[0-9a-f-]+\.tmp:\/project\/file\.txt$/,
    )
    expect(session.rename).not.toHaveBeenCalled()
    expect(session.unlink).not.toHaveBeenCalled()
  })

  it('does not rename over a same-second external edit after a slow upload', async () => {
    let live = Buffer.from('first')
    const attrs = { mode: 0o100640, mtime: 100, size: 5, atime: 100 }
    const session = {
      lstat: vi.fn(
        (_path: string, callback: (error: Error | undefined, value: unknown) => void) =>
          callback(undefined, attrs),
      ),
      readFile: vi.fn(
        (_path: string, callback: (error: Error | undefined, value: Buffer) => void) =>
          callback(undefined, live),
      ),
      writeFile: vi.fn(
        (
          _path: string,
          _data: Buffer,
          _options: unknown,
          callback: (error?: Error) => void,
        ) => {
          live = Buffer.from('other')
          callback()
        },
      ),
      ext_openssh_rename: vi.fn(),
      rename: vi.fn(),
      unlink: vi.fn((_path: string, callback: (error?: Error) => void) => callback()),
    }
    const host = new SshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(undefined) },
    })
    ;(host as unknown as { getSftp(): Promise<unknown> }).getSftp = () =>
      Promise.resolve(session)
    const path = hostPath(host.hostId, '/project/file.txt')
    await host.readFile(path, { pollingInterest: true })

    await expect(
      host.writeFile(path, 'mine!', { expectedMtimeMs: 100_000 }),
    ).rejects.toThrow('changed on the remote host')

    expect(session.ext_openssh_rename).not.toHaveBeenCalled()
    expect(session.rename).not.toHaveBeenCalled()
    expect(session.unlink).toHaveBeenCalledOnce()
  })

  it('cleans up a partial temporary when an atomic remote write fails', async () => {
    const session = {
      lstat: vi.fn(
        (_path: string, callback: (error: Error | undefined, value: unknown) => void) =>
          callback(undefined, { mode: 0o100640, mtime: 100, size: 5 }),
      ),
      writeFile: vi.fn(
        (
          _path: string,
          _data: Buffer,
          _options: unknown,
          callback: (error: Error) => void,
        ) => callback(new Error('network dropped')),
      ),
      ext_openssh_rename: vi.fn(),
      rename: vi.fn(),
      unlink: vi.fn((_path: string, callback: (error?: Error) => void) => callback()),
    }
    const host = new SshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(undefined) },
    })
    ;(host as unknown as { getSftp(): Promise<unknown> }).getSftp = () =>
      Promise.resolve(session)

    await expect(
      host.writeFile(hostPath(host.hostId, '/project/file.txt'), 'replacement'),
    ).rejects.toThrow('network dropped')

    expect(session.ext_openssh_rename).not.toHaveBeenCalled()
    expect(session.rename).not.toHaveBeenCalled()
    expect(session.unlink).toHaveBeenCalledOnce()
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

  it('keeps buffered execs within the SSH session budget', async () => {
    const channels = Array.from({ length: 3 }, () => {
      const channel = Object.assign(new EventEmitter(), {
        stderr: new EventEmitter(),
        close: vi.fn(() => channel.emit('close')),
        end: vi.fn(),
      })
      return channel
    })
    const [first, second, third] = channels
    if (!first || !second || !third) throw new Error('Expected three test channels')
    let nextChannel = 0
    const client = Object.assign(
      fakeClient(() => undefined),
      {
        exec: vi.fn(
          (
            _command: string,
            callback: (error: Error | undefined, value: unknown) => void,
          ) => callback(undefined, channels[nextChannel++]),
        ),
      },
    )
    const host = new SshHost({
      config: aliasConfig(),
      maxConcurrentExecs: 2,
      prompter: { prompt: () => Promise.resolve(undefined) },
    })
    const internals = host as unknown as { state: 'connected'; client: Client }
    internals.state = 'connected'
    internals.client = client as unknown as Client

    const results = [host.exec('one', []), host.exec('two', []), host.exec('three', [])]
    await vi.waitFor(() => expect(client.exec).toHaveBeenCalledTimes(2))
    expect(third.end).not.toHaveBeenCalled()

    first.emit('exit', 0)
    first.emit('close')
    await vi.waitFor(() => expect(client.exec).toHaveBeenCalledTimes(3))
    second.emit('exit', 0)
    second.emit('close')
    third.emit('exit', 0)
    third.emit('close')

    await expect(Promise.all(results)).resolves.toHaveLength(3)
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

  it('content-fingerprints only viewer-fetched files during polling', async () => {
    let contents = Buffer.from('first')
    const attrs = { mode: 0o100644, mtime: 100, size: 5, atime: 100 }
    const session = {
      lstat: vi.fn(
        (_path: string, callback: (error: Error | undefined, value: unknown) => void) =>
          callback(undefined, { ...attrs, mode: 0o040755, size: 0 }),
      ),
      readdir: vi.fn(
        (_path: string, callback: (error: Error | undefined, value: unknown[]) => void) =>
          callback(undefined, [
            { filename: 'open.txt', attrs },
            { filename: 'closed.txt', attrs },
          ]),
      ),
      readFile: vi.fn(
        (_path: string, callback: (error: Error | undefined, value: Buffer) => void) =>
          callback(undefined, contents),
      ),
    }
    const host = new SshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(undefined) },
    })
    const internals = host as unknown as {
      pollingFiles: Set<string>
      getSftp(): Promise<unknown>
      pollPrioritySnapshot(
        path: HostPath,
        opts: WatchOptions,
      ): Promise<Map<string, string>>
    }
    internals.pollingFiles.add('/project/open.txt')
    internals.getSftp = () => Promise.resolve(session)

    const before = await internals.pollPrioritySnapshot(
      hostPath(host.hostId, '/project'),
      { recursive: false },
    )
    contents = Buffer.from('later')
    const after = await internals.pollPrioritySnapshot(
      hostPath(host.hostId, '/project'),
      { recursive: false },
    )

    expect(before.get('/project/open.txt')).not.toBe(after.get('/project/open.txt'))
    expect(before.get('/project/closed.txt')).toBe(after.get('/project/closed.txt'))
    expect(session.readFile).toHaveBeenCalledTimes(2)
    expect(session.readFile).toHaveBeenCalledWith(
      '/project/open.txt',
      expect.any(Function),
    )
  })

  it('retains the digest of a stable old file without downloading it again', async () => {
    vi.useFakeTimers()
    try {
      const attrs = { mode: 0o100644, mtime: 100, size: 6, atime: 100 }
      const session = {
        lstat: vi.fn(
          (_path: string, callback: (error: Error | undefined, value: unknown) => void) =>
            callback(undefined, { ...attrs, mode: 0o040755, size: 0 }),
        ),
        readdir: vi.fn(
          (
            _path: string,
            callback: (error: Error | undefined, value: unknown[]) => void,
          ) => callback(undefined, [{ filename: 'open.txt', attrs }]),
        ),
        readFile: vi.fn(
          (_path: string, callback: (error: Error | undefined, value: Buffer) => void) =>
            callback(undefined, Buffer.from('stable')),
        ),
      }
      const host = new SshHost({
        config: aliasConfig(),
        fingerprintObservationWindowMs: 10,
        prompter: { prompt: () => Promise.resolve(undefined) },
      })
      const internals = host as unknown as {
        pollingFiles: Set<string>
        getSftp(): Promise<unknown>
        pollPrioritySnapshot(
          path: HostPath,
          opts: WatchOptions,
        ): Promise<Map<string, string>>
      }
      internals.pollingFiles.add('/project/open.txt')
      internals.getSftp = () => Promise.resolve(session)
      const root = hostPath(host.hostId, '/project')

      const first = await internals.pollPrioritySnapshot(root, { recursive: false })
      await vi.advanceTimersByTimeAsync(11)
      const second = await internals.pollPrioritySnapshot(root, { recursive: false })
      const third = await internals.pollPrioritySnapshot(root, { recursive: false })

      expect(second).toEqual(first)
      expect(third).toEqual(first)
      expect(session.readFile).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not put internal bulk reads on the polling fast path', async () => {
    const session = {
      readFile: vi.fn(
        (_path: string, callback: (error: Error | undefined, value: Buffer) => void) =>
          callback(undefined, Buffer.from('contents')),
      ),
    }
    const host = new SshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(undefined) },
    })
    const internals = host as unknown as {
      pollingFiles: Set<string>
      readDigests: Map<string, string>
      getSftp(): Promise<unknown>
    }
    internals.getSftp = () => Promise.resolve(session)
    const internal = hostPath(host.hostId, '/project/untracked.txt')
    const visible = hostPath(host.hostId, '/project/open.txt')

    await host.readTextFile(internal)
    await host.readFile(visible, { pollingInterest: true })

    expect(internals.pollingFiles).toEqual(new Set(['/project/open.txt']))
    expect(internals.readDigests.has('/project/untracked.txt')).toBe(false)
    expect(internals.readDigests.has('/project/open.txt')).toBe(true)
  })

  it('content-fingerprints Git metadata on a nonrecursive watch', async () => {
    const attrs = { mode: 0o100644, mtime: 100, size: 5, atime: 100 }
    const session = {
      lstat: vi.fn(
        (_path: string, callback: (error: Error | undefined, value: unknown) => void) =>
          callback(undefined, { ...attrs, mode: 0o040755 }),
      ),
      readdir: vi.fn(
        (_path: string, callback: (error: Error | undefined, value: unknown[]) => void) =>
          callback(undefined, [
            { filename: 'HEAD', attrs },
            { filename: 'index', attrs },
            { filename: 'config', attrs },
          ]),
      ),
      readFile: vi.fn(
        (path: string, callback: (error: Error | undefined, value: Buffer) => void) =>
          callback(undefined, Buffer.from(path)),
      ),
    }
    const host = new SshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(undefined) },
    })
    const internals = host as unknown as {
      getSftp(): Promise<unknown>
      pollPrioritySnapshot(
        path: HostPath,
        opts: WatchOptions,
      ): Promise<Map<string, string>>
    }
    internals.getSftp = () => Promise.resolve(session)

    await internals.pollPrioritySnapshot(hostPath(host.hostId, '/project/.git'), {
      recursive: false,
    })

    expect(session.readFile).toHaveBeenCalledTimes(2)
    expect(session.readFile).toHaveBeenCalledWith(
      '/project/.git/HEAD',
      expect.any(Function),
    )
    expect(session.readFile).toHaveBeenCalledWith(
      '/project/.git/index',
      expect.any(Function),
    )
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
        pollPrioritySnapshot(
          path: HostPath,
          opts: WatchOptions,
        ): Promise<Map<string, string>>
        pollDirectoryBatch(queue: string[]): Promise<void>
        watchPolling(
          path: HostPath,
          onEvent: (event: WatchEvent) => void,
          opts: WatchOptions,
        ): Disposer
      }
      internals.pollPrioritySnapshot = snapshot
      internals.pollDirectoryBatch = (queue) => {
        queue.length = 0
        return Promise.resolve()
      }
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

  it('bounds recursive safety work and adaptively backs off idle cycles', async () => {
    vi.useFakeTimers()
    try {
      const host = new SshHost({
        config: aliasConfig(),
        pollIntervalMs: 10,
        slowScanIntervalMs: 20,
        maxSlowScanIntervalMs: 80,
        pollDirectoryBatchSize: 2,
        prompter: { prompt: () => Promise.resolve(undefined) },
      })
      const priority = vi.fn(() => Promise.resolve(new Map<string, string>()))
      const batch = vi.fn(
        (
          queue: string[],
          _visited: Set<string>,
          _snapshot: Map<string, string>,
          _opts: WatchOptions,
          limit: number,
        ) => {
          expect(limit).toBe(2)
          queue.length = 0
          return Promise.resolve()
        },
      )
      const internals = host as unknown as {
        pollPrioritySnapshot(): Promise<Map<string, string>>
        pollDirectoryBatch(
          queue: string[],
          visited: Set<string>,
          snapshot: Map<string, string>,
          opts: WatchOptions,
          limit: number,
        ): Promise<void>
        watchPolling(
          path: HostPath,
          onEvent: (event: WatchEvent) => void,
          opts: WatchOptions,
        ): Disposer
      }
      internals.pollPrioritySnapshot = priority
      internals.pollDirectoryBatch = batch
      const stop = internals.watchPolling(
        hostPath(host.hostId, '/project'),
        () => undefined,
        { recursive: true },
      )

      await vi.advanceTimersByTimeAsync(0)
      expect(batch).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(39)
      expect(priority).toHaveBeenCalledTimes(4)
      expect(batch).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1)
      expect(batch).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(79)
      expect(batch).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(batch).toHaveBeenCalledTimes(3)

      await stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('enumerates only the configured number of directories per safety tick', async () => {
    const directoryAttrs = { mode: 0o040755, mtime: 100, size: 0, atime: 100 }
    const session = {
      readdir: vi.fn(
        (path: string, callback: (error: Error | undefined, value: unknown[]) => void) =>
          callback(
            undefined,
            path === '/project'
              ? ['a', 'b', 'c'].map((filename) => ({
                  filename,
                  attrs: directoryAttrs,
                }))
              : [],
          ),
      ),
    }
    const host = new SshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(undefined) },
    })
    const internals = host as unknown as {
      getSftp(): Promise<unknown>
      pollDirectoryBatch(
        queue: string[],
        visited: Set<string>,
        snapshot: Map<string, string>,
        opts: WatchOptions,
        limit: number,
      ): Promise<void>
    }
    internals.getSftp = () => Promise.resolve(session)
    const queue = ['/project']
    const visited = new Set(queue)
    const snapshot = new Map<string, string>()

    await internals.pollDirectoryBatch(queue, visited, snapshot, {}, 1)

    expect(session.readdir).toHaveBeenCalledOnce()
    expect(queue).toEqual(['/project/a', '/project/b', '/project/c'])
    expect(snapshot.size).toBe(3)
  })

  it('uses a polling watchdog when inotify stays silent', async () => {
    vi.useFakeTimers()
    try {
      const host = new SshHost({
        config: aliasConfig(),
        watchdogIntervalMs: 10,
        slowScanIntervalMs: 10,
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
        pollPrioritySnapshot(
          path: HostPath,
          opts: WatchOptions,
        ): Promise<Map<string, string>>
        pollDirectoryBatch(queue: string[]): Promise<void>
        watchInotify(
          path: HostPath,
          onEvent: (event: WatchEvent) => void,
          opts: WatchOptions,
        ): Disposer
      }
      internals.execStream = () => silentInotify
      internals.pollPrioritySnapshot = snapshot
      internals.pollDirectoryBatch = (queue) => {
        queue.length = 0
        return Promise.resolve()
      }
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

  it('classifies both sides of an inotify directory rename', async () => {
    let emitStdout: ((value: string) => void) | undefined
    const inotify: ExecStreamHandle = {
      onStdout: (callback) => {
        emitStdout = callback
        return () => undefined
      },
      onStderr: () => () => undefined,
      onError: () => () => undefined,
      onExit: () => () => undefined,
      kill: () => undefined,
      dispose: vi.fn(),
    }
    const host = new SshHost({
      config: aliasConfig(),
      watchdogIntervalMs: 60_000,
      prompter: { prompt: () => Promise.resolve(undefined) },
    })
    const internals = host as unknown as {
      execStream(): ExecStreamHandle
      pollPrioritySnapshot(
        path: HostPath,
        opts: WatchOptions,
      ): Promise<Map<string, string>>
      pollDirectoryBatch(queue: string[]): Promise<void>
      watchInotify(
        path: HostPath,
        onEvent: (event: WatchEvent) => void,
        opts: WatchOptions,
      ): Disposer
    }
    internals.execStream = () => inotify
    internals.pollPrioritySnapshot = () => Promise.resolve(new Map<string, string>())
    internals.pollDirectoryBatch = (queue) => {
      queue.length = 0
      return Promise.resolve()
    }
    const events: WatchEvent[] = []
    const root = hostPath(host.hostId, '/project')
    const stop = internals.watchInotify(root, (event) => events.push(event), {})

    emitStdout?.('MOVED_FROM,ISDIR|/project/old\nMOVED_TO,ISDIR|/project/new\n')

    expect(events).toEqual([
      { type: 'unlinkDir', path: hostPath(host.hostId, '/project/old') },
      { type: 'addDir', path: hostPath(host.hostId, '/project/new') },
    ])
    await stop()
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
      expect(events).toEqual([{ type: 'change', path: root, synthetic: 'refresh' }])

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
      pollPrioritySnapshot(
        path: HostPath,
        opts: WatchOptions,
      ): Promise<Map<string, string>>
      watchPolling(
        path: HostPath,
        onEvent: (event: WatchEvent) => void,
        opts: WatchOptions,
      ): Disposer
    }
    internals.pollPrioritySnapshot = snapshot
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
  destroy: ReturnType<typeof vi.fn>
} {
  const client = Object.assign(new EventEmitter(), {
    connect: vi.fn(connect),
    end: vi.fn(() => client.emit('close')),
    destroy: vi.fn(() => client.emit('close')),
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
