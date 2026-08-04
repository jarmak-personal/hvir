import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AnyAuthMethod, Client, ConnectConfig } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SshHost, type SshPrompt } from '../src/main/project-host'
import {
  createTestSshHost,
  inMemorySshHostTrust,
} from './ssh-host-test-fixture'

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
    const host = createTestSshHost({
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
    const host = createTestSshHost({
      config: aliasConfig(),
      prompter: { prompt },
      trust: inMemorySshHostTrust(fingerprint(Buffer.from('trusted-host-key'))),
    })
    const verifier = hostVerifier(host)
    const verify = vi.fn()

    expect(verifier(Buffer.from('trusted-host-key'), verify)).toBeUndefined()
    expect(verify).toHaveBeenCalledWith(true)
    expect(prompt).not.toHaveBeenCalled()
  })

  it('waits for an unknown host to be persisted before verifying it', async () => {
    const remember = vi.fn<() => Promise<void>>(() => Promise.resolve())
    const host = createTestSshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(['yes']) },
      trust: {
        trustedHostKey: () => undefined,
        rememberHostKey: remember,
      },
    })
    const verify = vi.fn()

    hostVerifier(host)(Buffer.from('new-host-key'), verify)

    await vi.waitFor(() => expect(verify).toHaveBeenCalledWith(true))
    expect(remember).toHaveBeenCalledWith(expect.stringMatching(/^SHA256:/))
    expect(remember.mock.invocationCallOrder[0]).toBeLessThan(
      verify.mock.invocationCallOrder[0]!,
    )
  })

  it('rejects a failed trust write and prompts again on the next explicit verification', async () => {
    const prompt = vi.fn(() => Promise.resolve(['yes']))
    const remember = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce(undefined)
    const host = createTestSshHost({
      config: aliasConfig(),
      prompter: { prompt },
      trust: {
        trustedHostKey: () => undefined,
        rememberHostKey: remember,
      },
    })
    const verifier = hostVerifier(host)
    const first = vi.fn()
    const second = vi.fn()

    verifier(Buffer.from('new-host-key'), first)
    await vi.waitFor(() => expect(first).toHaveBeenCalledWith(false))
    verifier(Buffer.from('new-host-key'), second)
    await vi.waitFor(() => expect(second).toHaveBeenCalledWith(true))

    expect(prompt).toHaveBeenCalledTimes(2)
    expect(remember).toHaveBeenCalledTimes(2)
  })

  it('presents a saved-key mismatch as a distinct high-risk prompt', async () => {
    const prompts: SshPrompt[] = []
    const remember = vi.fn<() => Promise<void>>(() => Promise.resolve())
    const host = createTestSshHost({
      config: aliasConfig(),
      prompter: {
        prompt: (request) => {
          prompts.push(request)
          return Promise.resolve(['yes'])
        },
      },
      trust: {
        trustedHostKey: () => 'SHA256:oldSavedFingerprint0123456789',
        rememberHostKey: remember,
      },
    })
    const verify = vi.fn()

    hostVerifier(host)(Buffer.from('replacement-host-key'), verify)

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
    const host = createTestSshHost({
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
    const host = createTestSshHost({
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

  it.each(['host-key', 'password', 'passphrase', 'keyboard-interactive'] as const)(
    'aborts a pending %s prompt when the logical host disposes',
    async (kind) => {
      const root = await mkdtemp(join(tmpdir(), 'hvir-ssh-cancel-'))
      cleanups.push(root)
      const keyPath = join(root, 'id_ed25519')
      if (kind === 'passphrase') {
        execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', 'secret', '-f', keyPath])
      }
      const signals: AbortSignal[] = []
      const host = createTestSshHost({
        config: aliasConfig(),
        ...(kind === 'passphrase'
          ? { identities: [{ path: keyPath, privateKey: await readFile(keyPath) }] }
          : {}),
        prompter: {
          prompt: (_request, signal) => {
            signals.push(signal)
            return new Promise((resolve) =>
              signal.addEventListener('abort', () => resolve(undefined), { once: true }),
            )
          },
        },
      })
      const config = connectConfig(host)
      const result = triggerPrompt(config, kind)
      await vi.waitFor(() => expect(signals).toHaveLength(1))

      await host.dispose()

      expect(signals[0]?.aborted).toBe(true)
      await expect(result).resolves.toEqual(kind === 'keyboard-interactive' ? [] : false)
    },
  )

  it('aborts a failed connection generation before an explicit replacement prompts', async () => {
    const clients = [fakeAuthClient(), fakeAuthClient()]
    const signals: AbortSignal[] = []
    const host = createTestSshHost({
      config: aliasConfig(),
      prompter: {
        prompt: (_request, signal) => {
          signals.push(signal)
          return new Promise((resolve) =>
            signal.addEventListener('abort', () => resolve(undefined), { once: true }),
          )
        },
      },
      trust: inMemorySshHostTrust(),
      clientFactory: () =>
        clients.find((client) => !client.connect.mock.calls.length)! as unknown as Client,
    })

    const firstConnect = host.connect()
    await vi.waitFor(() => expect(clients[0]?.config).toBeDefined())
    const firstVerify = vi.fn()
    ;(clients[0]!.config!.hostVerifier as HostVerifier)(
      Buffer.from('first-key'),
      firstVerify,
    )
    await vi.waitFor(() => expect(signals).toHaveLength(1))
    clients[0]!.emit('close')

    await expect(firstConnect).rejects.toThrow(
      'SSH connection closed before authentication completed',
    )
    await vi.waitFor(() => expect(firstVerify).toHaveBeenCalledWith(false))
    expect(signals[0]?.aborted).toBe(true)

    const secondConnect = host.connect()
    await vi.waitFor(() => expect(clients[1]?.config).toBeDefined())
    const secondVerify = vi.fn()
    ;(clients[1]!.config!.hostVerifier as HostVerifier)(
      Buffer.from('second-key'),
      secondVerify,
    )
    await vi.waitFor(() => expect(signals).toHaveLength(2))

    expect(signals[1]?.aborted).toBe(false)
    expect(secondVerify).not.toHaveBeenCalled()
    clients[1]!.emit('close')
    await expect(secondConnect).rejects.toThrow(
      'SSH connection closed before authentication completed',
    )
    await host.dispose()
  })
})

type HostVerifier = (key: Buffer, verify: (valid: boolean) => void) => void

function fakeAuthClient(): EventEmitter & {
  readonly connect: ReturnType<typeof vi.fn>
  readonly end: ReturnType<typeof vi.fn>
  readonly destroy: ReturnType<typeof vi.fn>
  config?: ConnectConfig
} {
  const client = Object.assign(new EventEmitter(), {
    connect: vi.fn((config: ConnectConfig) => {
      client.config = config
    }),
    end: vi.fn(() => client.emit('close')),
    destroy: vi.fn(() => client.emit('close')),
    config: undefined as ConnectConfig | undefined,
  })
  return client
}

async function triggerPrompt(
  config: ConnectConfig,
  kind: 'host-key' | 'password' | 'passphrase' | 'keyboard-interactive',
): Promise<unknown> {
  if (kind === 'host-key') {
    return new Promise<boolean>((resolve) =>
      (config.hostVerifier as (key: Buffer, verify: (valid: boolean) => void) => void)(
        Buffer.from('host-key'),
        resolve,
      ),
    )
  }
  if (kind === 'password') return nextAuth(config, ['password'])
  if (kind === 'passphrase') return nextAuth(config, ['publickey'])
  const keyboard = await nextAuth(config, ['keyboard-interactive'])
  if (keyboard === false || keyboard.type !== 'keyboard-interactive') {
    throw new Error('Expected keyboard-interactive authentication')
  }
  return new Promise<readonly string[]>((resolve) =>
    keyboard.prompt(
      'Second factor',
      'Enter the code',
      '',
      [{ prompt: 'Code', echo: false }],
      resolve,
    ),
  )
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

function hostVerifier(
  host: SshHost,
): (key: Buffer, verify: (valid: boolean) => void) => void {
  return connectConfig(host).hostVerifier as HostVerifier
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
