import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  ProjectRegistry,
  RendererSshPrompter,
  identityFileCandidates,
} from '../src/main/project-registry'
import { localPath } from '../src/shared'

const cleanups: string[] = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true })))
})

describe('ProjectRegistry session flow', () => {
  it('uses configured identities without adding OpenSSH defaults', () => {
    expect(
      identityFileCandidates(
        {
          alias: 'example',
          hostname: 'example.test',
          user: 'picard',
          port: 22,
          identityFiles: ['/home/test/custom', '/home/test/custom'],
        },
        '/home/test',
      ),
    ).toEqual(['/home/test/custom'])
  })

  it('loads conventional OpenSSH identities when none are configured', () => {
    expect(
      identityFileCandidates(
        {
          alias: 'example',
          hostname: 'example.test',
          user: 'picard',
          port: 22,
          identityFiles: [],
        },
        '/home/test',
      ),
    ).toEqual([
      '/home/test/.ssh/id_rsa',
      '/home/test/.ssh/id_ecdsa',
      '/home/test/.ssh/id_ecdsa_sk',
      '/home/test/.ssh/id_ed25519',
      '/home/test/.ssh/id_ed25519_sk',
      '/home/test/.ssh/id_xmss',
      '/home/test/.ssh/id_dsa',
    ])
  })

  it('connects before browsing and opens a selected local folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hvir-registry-'))
    const canonicalRoot = await realpath(root)
    cleanups.push(root)
    await mkdir(join(root, 'alpha'))
    await mkdir(join(root, 'zeta'))
    await writeFile(join(root, 'file.txt'), 'not a folder')
    const states: string[] = []
    const registry = await ProjectRegistry.create(
      localPath(root),
      { prompt: () => Promise.resolve(undefined) },
      join(root, 'known-hosts.json'),
      (state) => states.push(state.root.path),
    )

    const connected = await registry.connectHost('local')
    expect(connected.host.connectionState).toBe('connected')
    expect(connected.suggestedPath).toBe(canonicalRoot)

    const listing = await registry.browseHost('local', root)
    expect(listing.directories.map((entry) => entry.name)).toEqual(['alpha', 'zeta'])
    await expect(registry.browseHost('local', join(root, 'missing'))).rejects.toThrow(
      `Folder not found: ${join(root, 'missing')}`,
    )

    const opened = await registry.open('local', join(root, 'alpha'))
    expect(opened.root.path).toBe(join(canonicalRoot, 'alpha'))
    expect(states).toEqual([join(canonicalRoot, 'alpha')])
    await registry.dispose()
  })

  it('rejects browsing a host that has not connected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hvir-registry-'))
    cleanups.push(root)
    const registry = await ProjectRegistry.create(
      localPath(root),
      { prompt: () => Promise.resolve(undefined) },
      join(root, 'known-hosts.json'),
      () => undefined,
    )

    await expect(registry.browseHost('missing', '/')).rejects.toThrow(
      'Connect to missing before browsing folders',
    )
    await registry.dispose()
  })

  it('does not allow the local host to disconnect', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hvir-registry-'))
    cleanups.push(root)
    const registry = await ProjectRegistry.create(
      localPath(root),
      { prompt: () => Promise.resolve(undefined) },
      join(root, 'known-hosts.json'),
      () => undefined,
    )

    await expect(registry.disconnectHost('local')).rejects.toThrow(
      'The local host cannot disconnect',
    )
    await registry.dispose()
  })
})

describe('RendererSshPrompter', () => {
  it('keeps concurrent prompts independently addressable and cancels by host', async () => {
    const emitted: { id: number; hostId: string }[] = []
    const cancelled: string[] = []
    const prompter = new RendererSshPrompter(
      (prompt) => emitted.push(prompt),
      (hostId) => cancelled.push(hostId),
    )
    const first = prompter.prompt({
      hostId: 'alpha',
      kind: 'password',
      title: 'Alpha',
      prompts: [],
    })
    const second = prompter.prompt({
      hostId: 'beta',
      kind: 'password',
      title: 'Beta',
      prompts: [],
    })

    expect(emitted).toEqual([
      expect.objectContaining({ id: 1, hostId: 'alpha' }),
      expect.objectContaining({ id: 2, hostId: 'beta' }),
    ])
    prompter.cancelHost('alpha')
    prompter.respond(2, ['secret'])
    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toEqual(['secret'])
    expect(cancelled).toEqual(['alpha'])
  })
})
