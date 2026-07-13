import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AnyAuthMethod, ConnectConfig } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  SshHost,
  type Disposer,
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
      isHostKeyTrusted: () => true,
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
      isHostKeyTrusted: () => false,
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
})

describe('SshHost remote behavior', () => {
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
})

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
