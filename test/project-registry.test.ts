import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ProjectRegistry } from '../src/main/project-registry'
import { localPath } from '../src/shared'

const cleanups: string[] = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true })))
})

describe('ProjectRegistry session flow', () => {
  it('connects before browsing and opens a selected local folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hvir-registry-'))
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
    expect(connected.suggestedPath).toBe(root)

    const listing = await registry.browseHost('local', root)
    expect(listing.directories.map((entry) => entry.name)).toEqual(['alpha', 'zeta'])

    const opened = await registry.open('local', join(root, 'alpha'))
    expect(opened.root.path).toBe(join(root, 'alpha'))
    expect(states).toEqual([join(root, 'alpha')])
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
})
