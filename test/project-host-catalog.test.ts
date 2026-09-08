import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AnyAuthMethod, ConnectConfig } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ProjectHostCatalog,
  SshHost,
  identityFileCandidates,
} from '../src/main/project-host'
import { localPath } from '../src/shared'

const cleanups: string[] = []
const catalogs: ProjectHostCatalog[] = []

afterEach(async () => {
  await Promise.all(catalogs.splice(0).map((catalog) => catalog.dispose()))
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true })))
})

describe('ProjectHostCatalog', () => {
  it('discovers aliases and materializes one logical SSH host with on-demand identities', async () => {
    const home = await mkdtemp(join(tmpdir(), 'hvir-host-catalog-'))
    cleanups.push(home)
    const ssh = join(home, '.ssh')
    const identity = join(ssh, 'work-key')
    await mkdir(ssh)
    await writeFile(
      join(ssh, 'config'),
      `Host work\n  HostName work.example.test\n  User picard\n  IdentityFile ${identity}\n`,
    )
    await writeFile(identity, 'test-private-key')
    const catalog = await ProjectHostCatalog.create({
      prompter: { prompt: () => Promise.resolve(undefined) },
      trustFile: localPath(join(home, 'known-hosts.json')),
      home,
      agentSocket: '',
    })
    catalogs.push(catalog)
    const readIdentity = vi.spyOn(catalog.local, 'readFile')

    expect(catalog.listHosts()).toEqual([
      expect.objectContaining({ hostId: 'local', kind: 'local' }),
      expect.objectContaining({ hostId: 'work', kind: 'ssh' }),
    ])
    await expect(catalog.disconnectHost('local')).rejects.toThrow(
      'The local host cannot disconnect',
    )
    const first = await catalog.materializeHost('work')
    const second = await catalog.materializeHost('work')

    expect(first).toBeInstanceOf(SshHost)
    expect(second).toBe(first)
    expect(readIdentity).not.toHaveBeenCalled()

    const authentication = await nextAuth(connectConfig(first as SshHost), ['publickey'])

    expect(authentication).toMatchObject({ type: 'publickey' })
    expect(readIdentity).toHaveBeenCalledWith(localPath(identity))
  })

  it('binds alias trust to the configured local metadata record', async () => {
    const home = await sshHome('Host work\n  HostName work.example.test\n  User picard\n')
    const trustFile = join(home, 'known-hosts.json')
    const rememberedKey = Buffer.from('remembered-work-host-key')
    await writeFile(
      trustFile,
      JSON.stringify({ work: fingerprint(rememberedKey) }, null, 2),
    )
    const prompt = vi.fn(() => Promise.resolve(['yes']))
    const catalog = await ProjectHostCatalog.create({
      prompter: { prompt },
      trustFile: localPath(trustFile),
      home,
      agentSocket: '',
    })
    catalogs.push(catalog)
    const host = (await catalog.materializeHost('work')) as SshHost
    const verifier = hostVerifier(host)
    const remembered = vi.fn()

    verifier(rememberedKey, remembered)

    expect(remembered).toHaveBeenCalledWith(true)
    expect(prompt).not.toHaveBeenCalled()

    const replacementKey = Buffer.from('replacement-work-host-key')
    const replaced = vi.fn()
    verifier(replacementKey, replaced)
    await vi.waitFor(() => expect(replaced).toHaveBeenCalledWith(true))

    expect(JSON.parse(await readFile(trustFile, 'utf8'))).toEqual({
      work: fingerprint(replacementKey),
    })
    expect(prompt).toHaveBeenCalledOnce()
  })

  it('aborts a materialized host prompt when that host disconnects', async () => {
    const home = await sshHome('Host work\n  HostName work.example.test\n  User picard\n')
    const signals: AbortSignal[] = []
    const catalog = await ProjectHostCatalog.create({
      prompter: {
        prompt: (_request, signal) => {
          signals.push(signal)
          return new Promise((resolve) =>
            signal.addEventListener('abort', () => resolve(undefined), { once: true }),
          )
        },
      },
      trustFile: localPath(join(home, 'known-hosts.json')),
      home,
    })
    catalogs.push(catalog)
    const host = (await catalog.materializeHost('work')) as SshHost
    const verify = vi.fn()
    hostVerifier(host)(Buffer.from('unknown-work-host-key'), verify)
    await vi.waitFor(() => expect(signals).toHaveLength(1))

    const disconnected = await catalog.disconnectHost('work')

    expect(disconnected).toMatchObject({
      hostId: 'work',
      connectionState: 'disconnected',
    })
    expect(signals[0]?.aborted).toBe(true)
    await vi.waitFor(() => expect(verify).toHaveBeenCalledWith(false))
  })

  it('aborts prompts for every materialized SSH host during bulk disconnect', async () => {
    const home = await sshHome(
      [
        'Host alpha',
        '  HostName alpha.example.test',
        '  User picard',
        'Host beta',
        '  HostName beta.example.test',
        '  User riker',
      ].join('\n'),
    )
    const signals = new Map<string, AbortSignal>()
    const catalog = await ProjectHostCatalog.create({
      prompter: {
        prompt: (request, signal) => {
          signals.set(request.hostId, signal)
          return new Promise((resolve) =>
            signal.addEventListener('abort', () => resolve(undefined), { once: true }),
          )
        },
      },
      trustFile: localPath(join(home, 'known-hosts.json')),
      home,
    })
    catalogs.push(catalog)
    const alpha = (await catalog.materializeHost('alpha')) as SshHost
    const beta = (await catalog.materializeHost('beta')) as SshHost
    const alphaVerify = vi.fn()
    const betaVerify = vi.fn()
    hostVerifier(alpha)(Buffer.from('unknown-alpha-key'), alphaVerify)
    hostVerifier(beta)(Buffer.from('unknown-beta-key'), betaVerify)
    await vi.waitFor(() => expect(signals.size).toBe(2))

    await catalog.disconnectSshHosts()

    expect(signals.get('alpha')?.aborted).toBe(true)
    expect(signals.get('beta')?.aborted).toBe(true)
    await vi.waitFor(() => {
      expect(alphaVerify).toHaveBeenCalledWith(false)
      expect(betaVerify).toHaveBeenCalledWith(false)
    })
  })

  it('rejects late materialization after its application owner disposes', async () => {
    const home = await mkdtemp(join(tmpdir(), 'hvir-host-catalog-'))
    cleanups.push(home)
    const catalog = await ProjectHostCatalog.create({
      prompter: { prompt: () => Promise.resolve(undefined) },
      trustFile: localPath(join(home, 'known-hosts.json')),
      home,
    })

    const disposeLocal = vi.spyOn(catalog.local, 'dispose')
    const firstDispose = catalog.dispose()
    const secondDispose = catalog.dispose()
    await Promise.all([firstDispose, secondDispose])

    await expect(catalog.materializeHost('work')).rejects.toThrow(
      'Project host catalog is disposed',
    )
    expect(disposeLocal).toHaveBeenCalledOnce()
  })
})

describe('SSH identity candidates', () => {
  it('uses unique configured identities without adding defaults', () => {
    expect(
      identityFileCandidates(
        aliasConfig(['/home/test/custom', '/home/test/custom']),
        '/home/test',
      ),
    ).toEqual(['/home/test/custom'])
  })

  it('uses the conventional OpenSSH identity set when none are configured', () => {
    expect(identityFileCandidates(aliasConfig([]), '/home/test')).toEqual([
      '/home/test/.ssh/id_rsa',
      '/home/test/.ssh/id_ecdsa',
      '/home/test/.ssh/id_ecdsa_sk',
      '/home/test/.ssh/id_ed25519',
      '/home/test/.ssh/id_ed25519_sk',
      '/home/test/.ssh/id_xmss',
      '/home/test/.ssh/id_dsa',
    ])
  })
})

function aliasConfig(identityFiles: readonly string[]) {
  return {
    alias: 'example',
    hostname: 'example.test',
    user: 'picard',
    port: 22,
    identityFiles,
  }
}

type HostVerifier = (key: Buffer, verify: (valid: boolean) => void) => void

function hostVerifier(host: SshHost): HostVerifier {
  return connectConfig(host).hostVerifier as HostVerifier
}

function connectConfig(host: SshHost): ConnectConfig {
  const internals = host as unknown as {
    createCredentialAttempt(): unknown
    connectConfig(attempt: unknown): ConnectConfig
  }
  return internals.connectConfig(internals.createCredentialAttempt())
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

function fingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}

async function sshHome(config: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'hvir-host-catalog-'))
  cleanups.push(home)
  const ssh = join(home, '.ssh')
  await mkdir(ssh)
  await writeFile(join(ssh, 'config'), config)
  return home
}
