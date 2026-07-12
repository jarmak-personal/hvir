import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AnyAuthMethod, ConnectConfig } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SshHost, type SshPrompt } from '../src/main/project-host'

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

    const agent = await nextAuth(config, ['agent', 'publickey'])
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
      isHostKeyTrusted: (fingerprint) => fingerprint === 'trusted-fingerprint',
    })
    const verifier = connectConfig(host).hostVerifier as unknown as (
      fingerprint: string,
      verify: (valid: boolean) => void,
    ) => boolean
    expect(verifier).toBeTypeOf('function')
    expect(verifier('trusted-fingerprint', vi.fn())).toBe(true)
    expect(prompt).not.toHaveBeenCalled()
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
  methods: readonly string[],
): Promise<AnyAuthMethod | false> {
  const handler = config.authHandler as unknown as (
    methods: readonly string[],
    partial: boolean,
    next: (method: AnyAuthMethod | false) => void,
  ) => void
  return new Promise((resolve) => handler(methods, false, resolve))
}
