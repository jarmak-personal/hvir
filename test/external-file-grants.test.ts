import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ExternalFileGrantRegistry } from '../src/main/project-file-operations'
import { LocalHost } from '../src/main/project-host'
import { localPath } from '../src/shared'

const owner = { id: 17, generation: 2 }

describe('ExternalFileGrantRegistry', () => {
  let directory: string
  let project: string
  let host: LocalHost
  let resources: GrantResources
  let registry: ExternalFileGrantRegistry

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'hvir-grant-'))
    project = join(directory, 'registered', 'project')
    await mkdir(project, { recursive: true })
    host = new LocalHost()
    resources = new GrantResources()
    registry = new ExternalFileGrantRegistry({
      sourceHost: host,
      registeredRoots: () => [localPath(project)],
      resources,
      createGrantId: (() => {
        let id = 0
        return () => `grant-${(id += 1)}`
      })(),
    })
  })

  afterEach(async () => {
    registry.dispose()
    await host.dispose()
    await rm(directory, { recursive: true, force: true })
  })

  it('grants exact outside roots and rejects links, projects, and project containers', async () => {
    const outside = join(directory, 'outside.txt')
    const linked = join(directory, 'linked.txt')
    await writeFile(outside, 'outside')
    await symlink(outside, linked)

    const result = await registry.acquire(owner, [
      outside,
      linked,
      project,
      join(directory, 'registered'),
    ])

    expect(result).toMatchObject({
      outcome: 'available',
      grant: {
        items: [
          { name: 'outside.txt', type: 'file' },
          { name: 'linked.txt', type: 'unsupported' },
          { name: 'project', type: 'unsupported' },
          { name: 'registered', type: 'unsupported' },
        ],
      },
    })
    expect(JSON.stringify(result)).not.toContain(outside)
  })

  it('marks invalid or overlong basenames unsupported before granting authority', async () => {
    const result = await registry.acquire(owner, [
      `${directory}/..`,
      `${directory}/${'x'.repeat(256)}`,
    ])

    expect(result).toMatchObject({
      outcome: 'available',
      grant: {
        items: [
          { type: 'unsupported', name: 'Unsupported entry 1' },
          { type: 'unsupported', name: 'Unsupported entry 2' },
        ],
      },
    })
  })

  it('releases the pending grant lease on consume without revoking a consumed sibling', async () => {
    const firstPath = join(directory, 'first.txt')
    const secondPath = join(directory, 'second.txt')
    await writeFile(firstPath, 'first')
    await writeFile(secondPath, 'second')

    const firstResult = await registry.acquire(owner, [firstPath])
    if (firstResult.outcome !== 'available') throw new Error('expected first grant')
    const first = registry.consume(
      owner,
      firstResult.grant.grantId,
      firstResult.grant.generation,
    )
    expect(resources.active).toBe(0)

    const secondResult = await registry.acquire(owner, [secondPath])
    if (secondResult.outcome !== 'available') throw new Error('expected second grant')
    const second = registry.consume(
      owner,
      secondResult.grant.grantId,
      secondResult.grant.generation,
    )

    await expect(
      first.source('external:0').stat(first.items[0]!.source!),
    ).resolves.toMatchObject({ type: 'file' })
    await expect(
      second.source('external:0').stat(second.items[0]!.source!),
    ).resolves.toMatchObject({ type: 'file' })
    expect(() =>
      registry.consume(owner, firstResult.grant.grantId, firstResult.grant.generation),
    ).toThrow('unavailable')
  })
})

class GrantResources {
  active = 0

  isRendererCurrent(): boolean {
    return true
  }

  registerGrant(_owner: typeof owner, _id: string, _revoke: () => void) {
    if (this.active > 0) throw new Error('duplicate pending grant resource')
    this.active += 1
    let current = true
    return {
      release: () => {
        if (!current) return
        current = false
        this.active -= 1
      },
    }
  }
}
