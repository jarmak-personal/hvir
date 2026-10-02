import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LocalHost } from '../src/main/project-host/local-host'
import { ProjectHostCatalog } from '../src/main/project-host/project-host-catalog'
import { SshConfiguration } from '../src/main/project-host/ssh-configuration'
import { localPath } from '../src/shared/host-path'

const request = {
  alias: 'added',
  hostname: 'new.example.test',
  username: 'riker',
  port: 2222,
}
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture(text?: string) {
  const home = await mkdtemp(join(tmpdir(), 'hvir-ssh-config-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const file = join(home, '.ssh/config')
  if (text !== undefined) {
    await mkdir(join(home, '.ssh'))
    await writeFile(file, text)
  }
  const local = new LocalHost()
  cleanups.push(() => local.dispose())
  const configuration = new SshConfiguration(local, home)
  cleanups.push(() => configuration.dispose())
  const catalog = await ProjectHostCatalog.create({
    home,
    trustFile: localPath(join(home, 'trust.json')),
    agentSocket: '',
    prompter: { prompt: () => Promise.resolve(undefined) },
  })
  cleanups.push(() => catalog.dispose())
  return { home, file, local, configuration, catalog }
}

describe('local SSH configuration', () => {
  it('creates private config and directory, remains discoverable after restart, and does not connect', async () => {
    const { home, file, catalog } = await fixture()
    const hosts = await catalog.addSshHost(request, () => undefined)
    expect(hosts).toContainEqual(
      expect.objectContaining({ hostId: 'added', connectionState: 'disconnected' }),
    )
    expect(catalog.hostById('added')).toBeUndefined()
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect((await stat(join(home, '.ssh'))).mode & 0o777).toBe(0o700)
    const restarted = await ProjectHostCatalog.create({
      home,
      trustFile: localPath(join(home, 'trust.json')),
      agentSocket: '',
      prompter: { prompt: () => Promise.resolve(undefined) },
    })
    cleanups.push(() => restarted.dispose())
    expect(restarted.listHosts().map(({ hostId }) => hostId)).toEqual(['local', 'added'])
  })

  it('preserves existing text and permissions and rejects duplicates against current disk contents', async () => {
    const text = '# user comment\nHost old\n  HostName old.example.test\n'
    const { file, configuration } = await fixture(text)
    await chmod(file, 0o640)
    await configuration.save(request, () => undefined)
    expect((await readFile(file, 'utf8')).endsWith(text)).toBe(true)
    expect((await stat(file)).mode & 0o777).toBe(0o640)
    await expect(configuration.save(request, () => undefined)).rejects.toThrow(
      'already exists',
    )
  })

  it('detects external changes while preparing save, retains the external text, and can retry', async () => {
    const { file, local, configuration } = await fixture('Host old\n')
    const create = local.createDirectoryExclusive.bind(local)
    vi.spyOn(local, 'createDirectoryExclusive').mockImplementationOnce(
      async (...args) => {
        await writeFile(file, 'Host external\n')
        return create(...args)
      },
    )
    await expect(configuration.save(request, () => undefined)).rejects.toThrow(
      'changed while saving',
    )
    expect(await readFile(file, 'utf8')).toBe('Host external\n')
    await expect(configuration.save(request, () => undefined)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ alias: 'added' })]),
    )
  })

  it('detects a version change at publication and removes its temporary file', async () => {
    const { file, local, configuration } = await fixture('Host old\n')
    const write = local.writeFile.bind(local)
    vi.spyOn(local, 'writeFile').mockImplementationOnce(async (...args) => {
      await writeFile(file, 'Host external\n')
      await utimes(file, new Date(), new Date(Date.now() + 10000))
      return write(...args)
    })
    await expect(configuration.save(request, () => undefined)).rejects.toThrow('changed')
    expect(await readFile(file, 'utf8')).toBe('Host external\n')
    expect(await readdir(join(file, '..'))).toEqual(['config'])
  })

  it('does not overwrite a file externally created before the absent-file publication', async () => {
    const { file, local, configuration } = await fixture()
    const write = local.writeFile.bind(local)
    vi.spyOn(local, 'writeFile').mockImplementationOnce(async (...args) => {
      await writeFile(file, 'Host external\n')
      return write(...args)
    })
    await expect(configuration.save(request, () => undefined)).rejects.toThrow(
      'changed while saving',
    )
    expect(await readFile(file, 'utf8')).toBe('Host external\n')
    expect(await readdir(join(file, '..'))).toEqual(['config'])
  })

  it('refuses symlinks, malformed UTF-8, and oversized configs without modifying them', async () => {
    const { file, configuration, home } = await fixture('')
    await writeFile(file, Buffer.from([0xff]))
    await expect(configuration.save(request, () => undefined)).rejects.toThrow('UTF-8')
    await writeFile(file, '#'.repeat(256 * 1024 + 1))
    await expect(configuration.refresh()).rejects.toThrow('256 KiB')
    await rm(file)
    const target = join(home, 'target')
    await writeFile(target, 'Host protected\n')
    await symlink(target, file)
    await expect(configuration.save(request, () => undefined)).rejects.toThrow(
      'regular file',
    )
    expect(await readFile(target, 'utf8')).toBe('Host protected\n')
  })

  it('serializes saves so only one request can claim an alias', async () => {
    const { configuration } = await fixture()
    const results = await Promise.allSettled([
      configuration.save(request, () => undefined),
      configuration.save(request, () => undefined),
    ])
    expect(results.map(({ status }) => status)).toEqual(['fulfilled', 'rejected'])
  })

  it('rejects revoked request authority before publishing', async () => {
    const { file, configuration } = await fixture('Host old\n')
    let active = true
    await expect(
      configuration.save(request, () => {
        if (!active) throw new Error('Renderer revoked')
        active = false
      }),
    ).rejects.toThrow('Renderer revoked')
    expect(await readFile(file, 'utf8')).toBe('Host old\n')
  })

  it('refreshes external aliases without replacing materialized hosts or authentication ownership', async () => {
    const { file, catalog } = await fixture('Host live\n  HostName live.example.test\n')
    const live = await catalog.materializeHost('live')
    const dispose = vi.spyOn(live, 'dispose')
    await writeFile(file, 'Host external\n  HostName external.example.test\n')
    expect((await catalog.refreshHosts()).map(({ hostId }) => hostId)).toEqual([
      'local',
      'external',
      'live',
    ])
    expect(await catalog.materializeHost('live')).toBe(live)
    expect(dispose).not.toHaveBeenCalled()
    await writeFile(file, Buffer.from([0xff]))
    await expect(catalog.refreshHosts()).rejects.toThrow('UTF-8')
    expect(catalog.listHosts().map(({ hostId }) => hostId)).toEqual([
      'local',
      'external',
      'live',
    ])
  })

  it('rejects late refresh after catalog disposal and remains idempotent', async () => {
    const { catalog } = await fixture('Host old\n')
    const read = catalog.local.readTextFilePrefix.bind(catalog.local)
    let resolve: (() => void) | undefined
    vi.spyOn(catalog.local, 'readTextFilePrefix').mockImplementationOnce(
      async (...args) => {
        await new Promise<void>((done) => {
          resolve = done
        })
        return read(...args)
      },
    )
    const refresh = catalog.refreshHosts()
    await vi.waitFor(() => expect(resolve).toBeDefined())
    const rejected = expect(refresh).rejects.toThrow()
    const disposal = catalog.dispose()
    expect(catalog.dispose()).toBe(disposal)
    resolve!()
    await rejected
    await disposal
    expect(catalog.listHosts().map(({ hostId }) => hostId)).toEqual(['local', 'old'])
  })
})
