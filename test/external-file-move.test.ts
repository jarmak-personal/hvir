import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  moveExternalFileGrant,
  type ExternalFileMoveGrantUse,
} from '../src/main/project-file-operations'
import {
  LocalHost,
  type ProjectFileTransferPort,
  type ProjectHost,
} from '../src/main/project-host'
import {
  asHostId,
  containsHostPath,
  hostPath,
  joinHostPath,
  localPath,
  type HostPath,
} from '../src/shared'

describe('external file move policy', () => {
  let directory: string
  let sourceDirectory: string
  let projectDirectory: string
  let host: LocalHost

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'hvir-external-move-'))
    sourceDirectory = join(directory, 'outside')
    projectDirectory = join(directory, 'project')
    await Promise.all([mkdir(sourceDirectory), mkdir(projectDirectory)])
    host = new LocalHost()
  })

  afterEach(async () => {
    await host.dispose()
    await rm(directory, { recursive: true, force: true })
  })

  it.each([
    { name: 'regular file', kind: 'file' as const },
    { name: 'bounded directory tree', kind: 'directory' as const },
  ])(
    'moves a $name only after verified publication and confirmed absence',
    async ({ kind }) => {
      const source = localPath(
        join(sourceDirectory, kind === 'file' ? 'file.txt' : 'tree'),
      )
      if (kind === 'file') await writeFile(source.path, 'exact bytes')
      else {
        await mkdir(source.path)
        await writeFile(join(source.path, 'nested.txt'), 'nested bytes')
      }
      const grant = await moveGrant(host, [source], async (_itemId, options) => {
        options.onSubmitted()
        await rm(source.path, { recursive: true })
        return 'removed'
      })

      const result = await runMove({ host, grant, projectDirectory })

      expect(result.items[0]).toMatchObject({
        status: 'completed',
        effect: kind === 'file' ? 'moved-external-file' : 'moved-external-directory',
        sourceDisposition: { outcome: 'removed' },
      })
      const destination = join(projectDirectory, kind === 'file' ? 'file.txt' : 'tree')
      await expect(
        readFile(kind === 'file' ? destination : join(destination, 'nested.txt'), 'utf8'),
      ).resolves.toContain('bytes')
      await expect(host.stat(source)).rejects.toThrow()
    },
  )

  it.each([
    { name: 'regular file', kind: 'file' as const },
    { name: 'bounded directory tree', kind: 'directory' as const },
  ])('moves a $name through an SSH-qualified destination host', async ({ kind }) => {
    const entryName = kind === 'file' ? 'remote-file.txt' : 'remote-tree'
    const source = localPath(join(sourceDirectory, entryName))
    if (kind === 'file') await writeFile(source.path, 'remote exact bytes')
    else {
      await mkdir(source.path)
      await writeFile(join(source.path, 'nested.txt'), 'remote nested bytes')
    }
    const grant = await moveGrant(host, [source], async (_itemId, options) => {
      options.onSubmitted()
      await rm(source.path, { recursive: true })
      return 'removed'
    })
    const visibleDestination = hostPath(asHostId('ssh:test'), '/srv/project')
    const destinationHost = remoteDestinationHost(
      host,
      localPath(projectDirectory),
      visibleDestination,
    )

    const result = await runMove({
      host: destinationHost,
      grant,
      projectDirectory,
      destination: visibleDestination,
    })

    expect(result.items[0]).toMatchObject({
      status: 'completed',
      destination: joinHostPath(visibleDestination, entryName),
      effect: kind === 'file' ? 'moved-external-file' : 'moved-external-directory',
      sourceDisposition: { outcome: 'removed' },
    })
    const backingDestination = join(projectDirectory, entryName)
    await expect(
      readFile(
        kind === 'file' ? backingDestination : join(backingDestination, 'nested.txt'),
        'utf8',
      ),
    ).resolves.toContain('bytes')
    await expect(host.stat(source)).rejects.toThrow()
  })

  it('keeps a changed source and reports the published destination as a copy', async () => {
    const source = localPath(join(sourceDirectory, 'changed.txt'))
    await writeFile(source.path, 'original')
    const grant = await moveGrant(host, [source])
    const destinationHost = wrapTransfer(host, {
      renameNoReplace: async (staging, destination, options) => {
        await host.fileTransfer.renameNoReplace(staging, destination, options)
        await writeFile(source.path, 'changed after publication')
      },
    })

    const result = await runMove({
      host: destinationHost,
      grant,
      projectDirectory,
    })

    expect(result.items[0]).toMatchObject({
      status: 'completed',
      effect: 'copied-file',
      sourceDisposition: { outcome: 'retained' },
    })
    expect(result.items[0]?.reason).toContain('changed')
    await expect(readFile(source.path, 'utf8')).resolves.toBe('changed after publication')
    await expect(readFile(join(projectDirectory, 'changed.txt'), 'utf8')).resolves.toBe(
      'original',
    )
  })

  it('retains the source when the published destination no longer matches its receipt', async () => {
    const source = localPath(join(sourceDirectory, 'destination-mismatch.txt'))
    await writeFile(source.path, 'original')
    const grant = await moveGrant(host, [source])
    const destinationHost = wrapTransfer(host, {
      renameNoReplace: async (staging, destination, options) => {
        await host.fileTransfer.renameNoReplace(staging, destination, options)
        await writeFile(destination.path, 'corrupt destination')
      },
    })

    const result = await runMove({
      host: destinationHost,
      grant,
      projectDirectory,
    })

    expect(result.items[0]).toMatchObject({
      status: 'completed',
      effect: 'copied-file',
      sourceDisposition: { outcome: 'retained' },
    })
    expect(result.items[0]?.reason).toContain('changed')
    await expect(readFile(source.path, 'utf8')).resolves.toBe('original')
  })

  it('retains the source when grant authority is revoked before Trash', async () => {
    const source = localPath(join(sourceDirectory, 'revoked.txt'))
    await writeFile(source.path, 'original')
    const grant = await moveGrant(host, [source])
    let current = true
    const destinationHost = wrapTransfer(host, {
      renameNoReplace: async (staging, destination, options) => {
        await host.fileTransfer.renameNoReplace(staging, destination, options)
        current = false
      },
    })

    const result = await runMove({
      host: destinationHost,
      grant,
      projectDirectory,
      assertCurrent: () => {
        if (!current) throw new Error('External file grant was revoked')
      },
    })

    expect(result.items[0]).toMatchObject({
      status: 'completed',
      effect: 'copied-file',
      sourceDisposition: { outcome: 'retained' },
    })
    expect(result.items[0]?.reason).toContain('revoked')
    await expect(readFile(source.path, 'utf8')).resolves.toBe('original')
  })

  it('retains a source when Trash fails before submission', async () => {
    const source = localPath(join(sourceDirectory, 'retained.txt'))
    await writeFile(source.path, 'retained')
    const grant = await moveGrant(host, [source], () => {
      throw new Error('Trash was unavailable before submission')
    })

    const result = await runMove({ host, grant, projectDirectory })

    expect(result.items[0]).toMatchObject({
      status: 'completed',
      effect: 'copied-file',
      sourceDisposition: { outcome: 'retained' },
    })
    await expect(readFile(source.path, 'utf8')).resolves.toBe('retained')
  })

  it('redacts the granted source root from hostile Trash failures', async () => {
    const source = localPath(join(sourceDirectory, 'private', 'hostile.txt'))
    await mkdir(join(sourceDirectory, 'private'))
    await writeFile(source.path, 'retained')
    const grant = await moveGrant(host, [source], () => {
      throw new Error(`Trash failed for ${source.path}/descendant`)
    })

    const result = await runMove({ host, grant, projectDirectory })

    expect(result.items[0]).toMatchObject({
      status: 'completed',
      effect: 'copied-file',
      sourceDisposition: { outcome: 'retained' },
    })
    expect(result.items[0]?.reason).toContain('[external source]/descendant')
    expect(JSON.stringify(result)).not.toContain(source.path)
  })

  it('does not claim retained or moved when submitted Trash is uncertain', async () => {
    const source = localPath(join(sourceDirectory, 'unknown.txt'))
    await writeFile(source.path, 'unknown')
    const grant = await moveGrant(host, [source], (_itemId, options) => {
      options.onSubmitted()
      return Promise.resolve('unknown')
    })

    const result = await runMove({ host, grant, projectDirectory })

    expect(result.items[0]).toMatchObject({
      status: 'completed',
      effect: 'copied-file',
      sourceDisposition: { outcome: 'unknown' },
    })
  })

  it('treats cancellation after publication as a completed copy with source retained', async () => {
    const source = localPath(join(sourceDirectory, 'cancelled.txt'))
    await writeFile(source.path, 'published')
    const grant = await moveGrant(host, [source])
    const abort = new AbortController()
    const destinationHost = wrapTransfer(host, {
      renameNoReplace: async (staging, destination, options) => {
        await host.fileTransfer.renameNoReplace(staging, destination, options)
        abort.abort(new Error('cancelled after publication'))
      },
    })

    const result = await runMove({
      host: destinationHost,
      grant,
      projectDirectory,
      abort,
    })

    expect(result.items[0]).toMatchObject({
      status: 'completed',
      effect: 'copied-file',
      sourceDisposition: { outcome: 'retained' },
    })
    await expect(readFile(source.path, 'utf8')).resolves.toBe('published')
  })

  it('cancels before publication without exposing a destination', async () => {
    const source = localPath(join(sourceDirectory, 'never-published.txt'))
    await writeFile(source.path, 'source')
    const grant = await moveGrant(host, [source])
    const abort = new AbortController()
    abort.abort(new Error('cancelled before transfer'))

    const result = await runMove({ host, grant, projectDirectory, abort })

    expect(result.items[0]).toMatchObject({ status: 'cancelled', effect: 'none' })
    await expect(
      readFile(join(projectDirectory, 'never-published.txt')),
    ).rejects.toThrow()
  })

  it('keeps independent moved, conflicted, and unsupported batch outcomes', async () => {
    const moved = localPath(join(sourceDirectory, 'moved.txt'))
    const conflicted = localPath(join(sourceDirectory, 'conflict.txt'))
    const linked = localPath(join(sourceDirectory, 'linked'))
    await Promise.all([
      writeFile(moved.path, 'moved'),
      writeFile(conflicted.path, 'source conflict'),
      writeFile(join(projectDirectory, 'conflict.txt'), 'destination conflict'),
      symlink(moved.path, linked.path),
    ])
    const grant = await moveGrant(
      host,
      [moved, conflicted],
      async (itemId, options) => {
        options.onSubmitted()
        await rm(itemId === 'external:0' ? moved.path : conflicted.path)
        return 'removed'
      },
      [
        {
          itemId: 'external:2',
          name: 'linked',
          type: 'unsupported',
          reason: 'Symbolic links are not supported',
        },
      ],
    )

    const result = await runMove({ host, grant, projectDirectory })

    expect(result.items).toMatchObject([
      { status: 'completed', effect: 'moved-external-file' },
      {
        status: 'conflicted',
        effect: 'none',
        sourceDisposition: { outcome: 'retained' },
      },
      { status: 'skipped', effect: 'none' },
    ])
    await expect(readFile(conflicted.path, 'utf8')).resolves.toBe('source conflict')
  })
})

async function moveGrant(
  host: LocalHost,
  sources: readonly HostPath[],
  trashSource: ExternalFileMoveGrantUse['trashSource'] = () =>
    Promise.reject(new Error('Trash should not be reached')),
  extraItems: ExternalFileMoveGrantUse['items'] = [],
): Promise<ExternalFileMoveGrantUse> {
  return {
    grantId: 'move-grant',
    generation: 1,
    owner: { id: 1, generation: 1 },
    purpose: 'move',
    items: [
      ...(await Promise.all(
        sources.map(async (source, index) => ({
          itemId: `external:${index}`,
          name: source.path.split('/').at(-1)!,
          type:
            (await host.stat(source)).type === 'dir'
              ? ('directory' as const)
              : ('file' as const),
          source,
          initialStat: await host.stat(source),
        })),
      )),
      ...extraItems,
    ],
    source: () => ({
      stat: (path) => host.stat(path),
      readdir: (path) => host.readdir(path),
      readFileChunks: (path, signal) =>
        host.fileTransfer.readFileChunks(path, { signal }),
    }),
    trashSource,
    assertCurrent: () => undefined,
    revoke: () => undefined,
  }
}

async function runMove(options: {
  readonly host: ProjectHost
  readonly grant: ExternalFileMoveGrantUse
  readonly projectDirectory: string
  readonly destination?: HostPath
  readonly abort?: AbortController
  readonly assertCurrent?: () => void
}) {
  const destination = options.destination ?? localPath(options.projectDirectory)
  const abort = options.abort ?? new AbortController()
  const result = await moveExternalFileGrant({
    operationId: 'move-operation',
    generation: 1,
    visibleDestinationDirectory: destination,
    canonicalDestinationDirectory: destination,
    destinationHost: options.host,
    grant: options.grant,
    signal: abort.signal,
    assertCurrent: () => {
      abort.signal.throwIfAborted()
      options.assertCurrent?.()
    },
    revalidateDestinationDirectory: () => Promise.resolve(destination),
    createStagingId: (() => {
      let id = 0
      return () => `staging-${(id += 1)}`
    })(),
    cleanupStaging: async (_host, path) => {
      await rm(path.path, { recursive: true, force: true })
    },
    onProgress: () => undefined,
  })
  for (const item of options.grant.items) {
    if (item.source) expect(JSON.stringify(result)).not.toContain(item.source.path)
  }
  return result
}

function remoteDestinationHost(
  host: LocalHost,
  localRoot: HostPath,
  remoteRoot: HostPath,
): ProjectHost {
  const toLocal = (path: HostPath): HostPath => {
    if (!containsHostPath(remoteRoot, path)) {
      throw new Error('Remote test path escaped its destination root')
    }
    const suffix = path.path.slice(remoteRoot.path.length).replace(/^\//, '')
    return suffix ? joinHostPath(localRoot, suffix) : localRoot
  }
  const toRemote = (path: HostPath): HostPath => {
    if (!containsHostPath(localRoot, path)) {
      throw new Error('Local test path escaped its backing root')
    }
    const suffix = path.path.slice(localRoot.path.length).replace(/^\//, '')
    return suffix ? joinHostPath(remoteRoot, suffix) : remoteRoot
  }
  const transfer: ProjectFileTransferPort = {
    readFileChunks: (path, options) =>
      host.fileTransfer.readFileChunks(toLocal(path), options),
    writeFileChunksExclusive: (path, chunks, options) =>
      host.fileTransfer.writeFileChunksExclusive(toLocal(path), chunks, options),
    setMetadata: (path, options) => host.fileTransfer.setMetadata(toLocal(path), options),
    renameNoReplace: (source, destination, options) =>
      host.fileTransfer.renameNoReplace(toLocal(source), toLocal(destination), options),
    removeDirectory: (path, options) =>
      host.fileTransfer.removeDirectory(toLocal(path), options),
  }
  const pathMethods = new Set<PropertyKey>([
    'stat',
    'readdir',
    'readFile',
    'readTextFile',
    'createFileExclusive',
    'createDirectoryExclusive',
    'removeFile',
  ])
  return new Proxy(host, {
    get(target, property) {
      if (property === 'hostId') return remoteRoot.hostId
      if (property === 'watchTier') return 'polling'
      if (property === 'fileTransfer') return transfer
      if (property === 'fileDeletion') return { capability: 'permanent' }
      if (property === 'realpath') {
        return async (path: HostPath): Promise<HostPath> =>
          toRemote(await host.realpath(toLocal(path)))
      }
      const value = Reflect.get(target, property, target) as unknown
      if (pathMethods.has(property) && typeof value === 'function') {
        return (path: HostPath, ...args: readonly unknown[]): unknown =>
          Reflect.apply(value, target, [toLocal(path), ...args])
      }
      return typeof value === 'function'
        ? (...args: readonly unknown[]): unknown => Reflect.apply(value, target, args)
        : value
    },
  })
}

function wrapTransfer(
  host: LocalHost,
  overrides: Partial<ProjectFileTransferPort>,
): ProjectHost {
  const transfer = { ...host.fileTransfer, ...overrides }
  return new Proxy(host, {
    get(target, property) {
      if (property === 'fileTransfer') return transfer
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function'
        ? (...args: readonly unknown[]): unknown => Reflect.apply(value, target, args)
        : value
    },
  })
}
