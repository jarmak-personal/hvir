import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  let trashItem: (path: string) => Promise<void>

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'hvir-grant-'))
    project = join(directory, 'registered', 'project')
    await mkdir(project, { recursive: true })
    trashItem = (path) => rm(path)
    host = new LocalHost({ trashItem: (path) => trashItem(path.path) })
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

  it('binds source removal only to native-picker move grants', async () => {
    const outside = join(directory, 'move-only.txt')
    await writeFile(outside, 'move')

    const copyResult = await registry.acquire(owner, [outside])
    if (copyResult.outcome !== 'available') throw new Error('expected copy grant')
    expect(() =>
      registry.consume(
        owner,
        copyResult.grant.grantId,
        copyResult.grant.generation,
        'move',
      ),
    ).toThrow('unavailable')
    const copy = registry.consume(
      owner,
      copyResult.grant.grantId,
      copyResult.grant.generation,
    )
    expect(copy.purpose).toBe('copy')
    expect('trashSource' in copy).toBe(false)

    const moveResult = await registry.acquire(owner, [outside], 'move')
    if (moveResult.outcome !== 'available') throw new Error('expected move grant')
    expect(() =>
      registry.consume(owner, moveResult.grant.grantId, moveResult.grant.generation),
    ).toThrow('unavailable')
  })

  it('releases only the exact pending move grant and leaves replacements untouched', async () => {
    const firstPath = join(directory, 'first-move.txt')
    const secondPath = join(directory, 'second-move.txt')
    await Promise.all([writeFile(firstPath, 'first'), writeFile(secondPath, 'second')])
    const firstResult = await registry.acquire(owner, [firstPath], 'move')
    if (firstResult.outcome !== 'available') throw new Error('expected first grant')

    expect(
      registry.release(
        { id: owner.id, generation: owner.generation + 1 },
        firstResult.grant.grantId,
        firstResult.grant.generation,
        'move',
      ),
    ).toBe(false)
    expect(
      registry.release(
        owner,
        firstResult.grant.grantId,
        firstResult.grant.generation,
        'copy',
      ),
    ).toBe(false)
    expect(
      registry.release(
        owner,
        firstResult.grant.grantId,
        firstResult.grant.generation,
        'move',
      ),
    ).toBe(true)

    const secondResult = await registry.acquire(owner, [secondPath], 'move')
    if (secondResult.outcome !== 'available') throw new Error('expected second grant')
    expect(
      registry.release(
        owner,
        firstResult.grant.grantId,
        firstResult.grant.generation,
        'move',
      ),
    ).toBe(false)
    const consumed = registry.consume(
      owner,
      secondResult.grant.grantId,
      secondResult.grant.generation,
      'move',
    )
    expect(
      registry.release(
        owner,
        secondResult.grant.grantId,
        secondResult.grant.generation,
        'move',
      ),
    ).toBe(false)
    await expect(
      consumed.source('external:0').stat(consumed.items[0]!.source!),
    ).resolves.toMatchObject({ type: 'file' })
  })

  it('keeps move grants for the operation horizon without extending copy grants', async () => {
    const outside = join(directory, 'grant-horizon.txt')
    await writeFile(outside, 'horizon')
    vi.useFakeTimers()
    try {
      const copyResult = await registry.acquire(owner, [outside], 'copy')
      if (copyResult.outcome !== 'available') throw new Error('expected copy grant')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(() =>
        registry.consume(
          owner,
          copyResult.grant.grantId,
          copyResult.grant.generation,
          'copy',
        ),
      ).toThrow('unavailable')

      const moveResult = await registry.acquire(owner, [outside], 'move')
      if (moveResult.outcome !== 'available') throw new Error('expected move grant')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(() =>
        registry.consume(
          owner,
          moveResult.grant.grantId,
          moveResult.grant.generation,
          'move',
        ),
      ).not.toThrow()

      const expiringMove = await registry.acquire(owner, [outside], 'move')
      if (expiringMove.outcome !== 'available') throw new Error('expected move grant')
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(() =>
        registry.consume(
          owner,
          expiringMove.grant.grantId,
          expiringMove.grant.generation,
          'move',
        ),
      ).toThrow('unavailable')
    } finally {
      vi.useRealTimers()
    }
  })

  it('confirms resolved Trash only when the exact granted path is absent', async () => {
    const outside = join(directory, 'removed.txt')
    await writeFile(outside, 'move')
    const result = await registry.acquire(owner, [outside], 'move')
    if (result.outcome !== 'available') throw new Error('expected move grant')
    const grant = registry.consume(
      owner,
      result.grant.grantId,
      result.grant.generation,
      'move',
    )
    let submitted = false

    await expect(
      grant.trashSource('external:0', {
        signal: new AbortController().signal,
        onSubmitted: () => {
          submitted = true
        },
        confirmExpectedSource: () => Promise.resolve(true),
      }),
    ).resolves.toBe('removed')
    expect(submitted).toBe(true)
    await expect(readFile(outside)).rejects.toThrow()
  })

  it('reports submitted Trash rejection retained only after full expected-source confirmation', async () => {
    const outside = join(directory, 'rejected.txt')
    await writeFile(outside, 'original')
    trashItem = () => Promise.reject(new Error('Trash rejected'))
    const result = await registry.acquire(owner, [outside], 'move')
    if (result.outcome !== 'available') throw new Error('expected move grant')
    const grant = registry.consume(
      owner,
      result.grant.grantId,
      result.grant.generation,
      'move',
    )

    await expect(
      grant.trashSource('external:0', {
        signal: new AbortController().signal,
        onSubmitted: () => undefined,
        confirmExpectedSource: async () =>
          (await readFile(outside, 'utf8')) === 'original',
      }),
    ).resolves.toBe('retained')
  })

  it.each([
    {
      name: 'removed before rejection',
      mutate: (path: string) => rm(path),
    },
    {
      name: 'replaced before rejection',
      mutate: (path: string) => writeFile(path, 'replacement'),
    },
  ])('reports submitted Trash rejection unknown when $name', async ({ mutate }) => {
    const outside = join(directory, 'uncertain.txt')
    await writeFile(outside, 'original')
    trashItem = async (path) => {
      await mutate(path)
      throw new Error('Trash rejected after submission')
    }
    const result = await registry.acquire(owner, [outside], 'move')
    if (result.outcome !== 'available') throw new Error('expected move grant')
    const grant = registry.consume(
      owner,
      result.grant.grantId,
      result.grant.generation,
      'move',
    )

    await expect(
      grant.trashSource('external:0', {
        signal: new AbortController().signal,
        onSubmitted: () => undefined,
        confirmExpectedSource: async () => {
          try {
            return (await readFile(outside, 'utf8')) === 'original'
          } catch {
            return false
          }
        },
      }),
    ).resolves.toBe('unknown')
  })

  it('does not call a replacement at the granted path a successful move', async () => {
    const outside = join(directory, 'replaced-after-trash.txt')
    await writeFile(outside, 'original')
    trashItem = async (path) => {
      await rm(path)
      await writeFile(path, 'replacement')
    }
    const result = await registry.acquire(owner, [outside], 'move')
    if (result.outcome !== 'available') throw new Error('expected move grant')
    const grant = registry.consume(
      owner,
      result.grant.grantId,
      result.grant.generation,
      'move',
    )

    await expect(
      grant.trashSource('external:0', {
        signal: new AbortController().signal,
        onSubmitted: () => undefined,
        confirmExpectedSource: () => Promise.resolve(true),
      }),
    ).resolves.toBe('unknown')
    await expect(readFile(outside, 'utf8')).resolves.toBe('replacement')
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
