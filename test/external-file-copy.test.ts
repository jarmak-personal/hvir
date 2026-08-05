import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { copyExternalFileGrant } from '../src/main/project-file-operations/external-file-copy'
import { removeExactStagingTree } from '../src/main/project-file-operations'
import { LocalHost } from '../src/main/project-host'
import { localPath } from '../src/shared'

describe('copyExternalFileGrant', () => {
  let directory: string
  let host: LocalHost

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'hvir-batch-'))
    host = new LocalHost()
  })

  afterEach(async () => {
    await host.dispose()
    await rm(directory, { recursive: true, force: true })
  })

  it('preserves a completed sibling when later source authority fails', async () => {
    const first = localPath(join(directory, 'first.txt'))
    const second = localPath(join(directory, 'second.txt'))
    const destination = localPath(join(directory, 'project'))
    await writeFile(first.path, 'first')
    await writeFile(second.path, 'second')
    await mkdir(destination.path)
    const transfer = host.fileTransfer

    const result = await copyExternalFileGrant({
      operationId: 'operation',
      generation: 1,
      visibleDestinationDirectory: destination,
      canonicalDestinationDirectory: destination,
      destinationHost: host,
      grant: {
        grantId: 'grant',
        generation: 1,
        owner: { id: 1, generation: 1 },
        items: [
          {
            itemId: 'external:0',
            name: 'first.txt',
            type: 'file',
            source: first,
            initialStat: await host.stat(first),
          },
          {
            itemId: 'external:1',
            name: 'second.txt',
            type: 'file',
            source: second,
            initialStat: await host.stat(second),
          },
        ],
        source: (itemId) => {
          if (itemId === 'external:1') throw new Error('grant was revoked')
          return {
            stat: (path) => host.stat(path),
            readdir: (path) => host.readdir(path),
            readFileChunks: (path, signal) => transfer.readFileChunks(path, { signal }),
          }
        },
        assertCurrent: () => undefined,
        revoke: () => undefined,
      },
      signal: new AbortController().signal,
      assertCurrent: () => undefined,
      revalidateDestinationDirectory: () => Promise.resolve(destination),
      createStagingId: (() => {
        let id = 0
        return () => `stage-${(id += 1)}`
      })(),
      cleanupStaging: removeExactStagingTree,
      onProgress: () => undefined,
    })

    expect(result).toMatchObject({
      items: [
        { itemId: 'external:0', status: 'completed', effect: 'copied-file' },
        { itemId: 'external:1', status: 'failed', effect: 'none' },
      ],
    })
  })

  it('enforces operation-wide totals while keeping file streams sequential', async () => {
    const sources = await Promise.all(
      ['one.txt', 'two.txt', 'three.txt'].map(async (name) => {
        const path = localPath(join(directory, name))
        await writeFile(path.path, name.slice(0, 2))
        return path
      }),
    )
    const destination = localPath(join(directory, 'bounded-project'))
    await mkdir(destination.path)
    const transfer = host.fileTransfer
    let activeStreams = 0
    let maxActiveStreams = 0

    const result = await copyExternalFileGrant({
      operationId: 'bounded-operation',
      generation: 1,
      visibleDestinationDirectory: destination,
      canonicalDestinationDirectory: destination,
      destinationHost: host,
      grant: {
        grantId: 'bounded-grant',
        generation: 1,
        owner: { id: 1, generation: 1 },
        items: await Promise.all(
          sources.map(async (source, index) => ({
            itemId: `external:${index}`,
            name: source.path.split('/').at(-1)!,
            type: 'file' as const,
            source,
            initialStat: await host.stat(source),
          })),
        ),
        source: () => ({
          stat: (path) => host.stat(path),
          readdir: (path) => host.readdir(path),
          readFileChunks: (path, signal) =>
            (async function* () {
              activeStreams += 1
              maxActiveStreams = Math.max(maxActiveStreams, activeStreams)
              try {
                yield* transfer.readFileChunks(path, { signal })
              } finally {
                activeStreams -= 1
              }
            })(),
        }),
        assertCurrent: () => undefined,
        revoke: () => undefined,
      },
      signal: new AbortController().signal,
      assertCurrent: () => undefined,
      revalidateDestinationDirectory: () => Promise.resolve(destination),
      limits: {
        maxEntries: 10,
        maxDepth: 10,
        maxFileBytes: 10,
        maxTotalBytes: 5,
      },
      createStagingId: (() => {
        let id = 0
        return () => `bounded-stage-${(id += 1)}`
      })(),
      cleanupStaging: removeExactStagingTree,
      onProgress: () => undefined,
    })

    expect(result.items).toMatchObject([
      { status: 'completed', effect: 'copied-file' },
      { status: 'completed', effect: 'copied-file' },
      { status: 'skipped', effect: 'none' },
    ])
    expect(result.items[2]?.reason).toContain('total byte limit')
    expect(maxActiveStreams).toBe(1)
  })
})
