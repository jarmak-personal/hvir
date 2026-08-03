import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    const first = await catalog.materializeHost('work')
    const second = await catalog.materializeHost('work')

    expect(first).toBeInstanceOf(SshHost)
    expect(second).toBe(first)
    expect(readIdentity).toHaveBeenCalledWith(localPath(identity))
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
