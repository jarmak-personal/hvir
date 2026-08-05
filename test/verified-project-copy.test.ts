import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  copyVerifiedProjectEntry,
  removeExactStagingTree,
  type ProjectFileCopyLimits,
  type VerifiedProjectCopySource,
} from '../src/main/project-file-operations'
import {
  LocalHost,
  type ProjectFileTransferPort,
  type ProjectHost,
} from '../src/main/project-host'
import { localPath } from '../src/shared'

describe('verified project copy', () => {
  let directory: string
  let host: LocalHost

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'hvir-copy-'))
    host = new LocalHost()
  })

  afterEach(async () => {
    await host.dispose()
    await rm(directory, { recursive: true, force: true })
  })

  it('streams and verifies a directory tree with executable mode and mtime', async () => {
    const sourceDirectory = join(directory, 'external')
    const destinationDirectory = join(directory, 'project')
    await mkdir(join(sourceDirectory, 'nested'), { recursive: true })
    await mkdir(destinationDirectory)
    await writeFile(join(sourceDirectory, 'nested', 'run.sh'), '#!/bin/sh\necho ok\n')
    await chmod(join(sourceDirectory, 'nested', 'run.sh'), 0o755)
    const fileMtime = new Date(1_700_000_123_000)
    const nestedMtime = new Date(1_700_000_124_000)
    const rootMtime = new Date(1_700_000_125_000)
    await utimes(join(sourceDirectory, 'nested', 'run.sh'), fileMtime, fileMtime)
    await utimes(join(sourceDirectory, 'nested'), nestedMtime, nestedMtime)
    await utimes(sourceDirectory, rootMtime, rootMtime)

    const outcome = await copy(sourceDirectory, destinationDirectory, 'directory')
    if (outcome.result.status !== 'completed') {
      throw new Error(JSON.stringify(outcome.result))
    }

    expect(outcome.result).toMatchObject({
      status: 'completed',
      effect: 'copied-directory',
    })
    expect(
      await readFile(join(destinationDirectory, 'external', 'nested', 'run.sh'), 'utf8'),
    ).toContain('echo ok')
    expect(
      (await stat(join(destinationDirectory, 'external', 'nested', 'run.sh'))).mode &
        0o777,
    ).toBe(0o755)
    expect(
      Math.floor(
        (await stat(join(destinationDirectory, 'external', 'nested', 'run.sh'))).mtimeMs /
          1_000,
      ),
    ).toBe(fileMtime.getTime() / 1_000)
    expect(
      Math.floor(
        (await stat(join(destinationDirectory, 'external', 'nested'))).mtimeMs / 1_000,
      ),
    ).toBe(nestedMtime.getTime() / 1_000)
    expect(
      Math.floor((await stat(join(destinationDirectory, 'external'))).mtimeMs / 1_000),
    ).toBe(rootMtime.getTime() / 1_000)
  })

  it.each([
    {
      label: 'entry',
      makeSource: async (root: string) => {
        await mkdir(root)
        await writeFile(join(root, 'child.txt'), 'x')
      },
      sourceType: 'directory' as const,
      limits: { maxEntries: 1 },
      reason: 'entry limit',
    },
    {
      label: 'depth',
      makeSource: async (root: string) =>
        mkdir(join(root, 'nested'), { recursive: true }),
      sourceType: 'directory' as const,
      limits: { maxDepth: 0 },
      reason: 'depth limit',
    },
    {
      label: 'file-size',
      makeSource: async (root: string) => writeFile(root, '1234'),
      sourceType: 'file' as const,
      limits: { maxFileBytes: 3 },
      reason: 'file exceeds',
    },
    {
      label: 'total-size',
      makeSource: async (root: string) => {
        await mkdir(root)
        await writeFile(join(root, 'one.txt'), '123')
        await writeFile(join(root, 'two.txt'), '456')
      },
      sourceType: 'directory' as const,
      limits: { maxTotalBytes: 5 },
      reason: 'total byte limit',
    },
  ])('fails visibly at the $label bound before staging', async (testCase) => {
    const source = join(directory, `bounded-${testCase.label}`)
    const destination = join(directory, `project-${testCase.label}`)
    await testCase.makeSource(source)
    await mkdir(destination)

    const outcome = await copy(source, destination, testCase.sourceType, {
      limits: { ...generousLimits(), ...testCase.limits },
    })

    expect(outcome.result).toMatchObject({ status: 'skipped', effect: 'none' })
    expect(outcome.result.reason).toContain(testCase.reason)
    expect(await host.readdir(localPath(destination))).toEqual([])
  })

  it('rejects a nested symbolic link without following or staging it', async () => {
    const outside = join(directory, 'outside.txt')
    const source = join(directory, 'linked-tree')
    const destination = join(directory, 'linked-project')
    await writeFile(outside, 'outside')
    await mkdir(source)
    await symlink(outside, join(source, 'link.txt'))
    await mkdir(destination)

    const outcome = await copy(source, destination, 'directory')

    expect(outcome.result).toMatchObject({ status: 'skipped', effect: 'none' })
    expect(outcome.result.reason).toContain('Symbolic links are unsupported')
    expect(await host.readdir(localPath(destination))).toEqual([])
  })

  it('detects a source mutation during verification and removes staging', async () => {
    const sourcePath = join(directory, 'mutating-source.txt')
    const destination = join(directory, 'mutation-project')
    await writeFile(sourcePath, 'source')
    await mkdir(destination)
    const delegate = sourcePort(host, sourcePath)
    let streams = 0
    const source: VerifiedProjectCopySource = {
      ...delegate,
      readFileChunks(path, signal) {
        const chunks = delegate.readFileChunks(path, signal)
        const mutate = streams === 0
        streams += 1
        return (async function* () {
          for await (const chunk of chunks) yield chunk
          if (mutate) await writeFile(sourcePath, 'mutant')
        })()
      },
    }

    const outcome = await copy(sourcePath, destination, 'file', { source })

    expect(outcome.result).toMatchObject({ status: 'failed', effect: 'none' })
    expect(await host.readdir(localPath(destination))).toEqual([])
  })

  it('detects a staged-destination mutation during verification and removes it', async () => {
    const source = join(directory, 'destination-source.txt')
    const destination = join(directory, 'destination-project')
    await writeFile(source, 'source')
    await mkdir(destination)
    const destinationHost = tamperingHost(host, 'mutant')

    const outcome = await copy(source, destination, 'file', { destinationHost })

    expect(outcome.result).toMatchObject({ status: 'failed', effect: 'none' })
    expect(outcome.result.reason).toContain('did not match')
    expect(await host.readdir(localPath(destination))).toEqual([])
  })

  it('cancels after staging ownership begins and removes the unpublished file', async () => {
    const sourcePath = join(directory, 'cancelled-source.txt')
    const destination = join(directory, 'cancelled-project')
    await writeFile(sourcePath, 'source')
    await mkdir(destination)
    const controller = new AbortController()
    const delegate = sourcePort(host, sourcePath)
    const source: VerifiedProjectCopySource = {
      ...delegate,
      readFileChunks: () =>
        (async function* () {
          await Promise.resolve()
          yield Buffer.from('source')
          controller.abort(new Error('cancelled in test'))
        })(),
    }

    const outcome = await copy(sourcePath, destination, 'file', {
      source,
      signal: controller.signal,
    })

    expect(outcome.result).toMatchObject({ status: 'cancelled', effect: 'none' })
    expect(await host.readdir(localPath(destination))).toEqual([])
  })

  it('skips when the top-level type differs from the acquired grant type', async () => {
    const sourceDirectory = join(directory, 'changed')
    const destinationDirectory = join(directory, 'project')
    await mkdir(sourceDirectory)
    await mkdir(destinationDirectory)

    const outcome = await copy(sourceDirectory, destinationDirectory, 'file')

    expect(outcome.result).toMatchObject({ status: 'skipped', effect: 'none' })
    expect(outcome.result.reason).toContain('type changed')
  })

  it('re-proves the destination before publication and cleans a staged tree', async () => {
    const sourceFile = join(directory, 'outside.txt')
    const destinationDirectory = join(directory, 'project')
    await writeFile(sourceFile, 'outside')
    await mkdir(destinationDirectory)

    const outcome = await copy(sourceFile, destinationDirectory, 'file', {
      revalidate: () => Promise.reject(new Error('destination became a symlink')),
    })

    expect(outcome.result).toMatchObject({ status: 'failed', effect: 'none' })
    expect(outcome.result.reason).toContain('symlink')
    expect(
      (await host.readdir(localPath(destinationDirectory))).map((entry) => entry.name),
    ).toEqual([])
  })

  it('cleans staging when the final absence check observes a race conflict', async () => {
    const sourceFile = join(directory, 'raced.txt')
    const destinationDirectory = join(directory, 'project')
    await writeFile(sourceFile, 'source')
    await mkdir(destinationDirectory)

    const outcome = await copy(sourceFile, destinationDirectory, 'file', {
      revalidate: async () => {
        await writeFile(join(destinationDirectory, 'raced.txt'), 'winner')
        return localPath(destinationDirectory)
      },
    })

    expect(outcome.result).toMatchObject({ status: 'conflicted', effect: 'none' })
    expect(await readFile(join(destinationDirectory, 'raced.txt'), 'utf8')).toBe('winner')
    expect(
      (await host.readdir(localPath(destinationDirectory))).map((entry) => entry.name),
    ).toEqual(['raced.txt'])
  })

  async function copy(
    sourcePath: string,
    destinationPath: string,
    sourceType: 'file' | 'directory',
    overrides: {
      readonly revalidate?: () => Promise<ReturnType<typeof localPath>>
      readonly limits?: ProjectFileCopyLimits
      readonly source?: VerifiedProjectCopySource
      readonly destinationHost?: ProjectHost
      readonly signal?: AbortSignal
    } = {},
  ) {
    const source = overrides.source ?? sourcePort(host, sourcePath)
    const destinationHost = overrides.destinationHost ?? host
    return copyVerifiedProjectEntry({
      itemId: 'external:0',
      name: sourcePath.split('/').at(-1)!,
      source,
      sourceType,
      visibleDestinationDirectory: localPath(destinationPath),
      canonicalDestinationDirectory: localPath(destinationPath),
      destinationHost,
      signal: overrides.signal ?? new AbortController().signal,
      assertCurrent: () => undefined,
      revalidateDestinationDirectory:
        overrides.revalidate ?? (() => Promise.resolve(localPath(destinationPath))),
      ...(overrides.limits ? { limits: overrides.limits } : {}),
      createStagingId: () => 'test-stage',
      cleanupStaging: removeExactStagingTree,
    })
  }
})

function sourcePort(host: ProjectHost, root: string): VerifiedProjectCopySource {
  const transfer = host.fileTransfer!
  return {
    root: localPath(root),
    stat: (path) => host.stat(path),
    readdir: (path) => host.readdir(path),
    readFileChunks: (path, signal) => transfer.readFileChunks(path, { signal }),
  }
}

function tamperingHost(host: LocalHost, replacement: string): ProjectHost {
  const transfer = host.fileTransfer
  const tamperingTransfer: ProjectFileTransferPort = {
    readFileChunks: (path, options) => transfer.readFileChunks(path, options),
    async writeFileChunksExclusive(path, chunks, options) {
      await transfer.writeFileChunksExclusive(path, chunks, options)
      await writeFile(path.path, replacement)
    },
    setMetadata: (path, options) => transfer.setMetadata(path, options),
    renameNoReplace: (source, destination, options) =>
      transfer.renameNoReplace(source, destination, options),
    removeDirectory: (path, options) => transfer.removeDirectory(path, options),
  }
  return {
    hostId: host.hostId,
    get connectionState() {
      return host.connectionState
    },
    stat: (path: ReturnType<typeof localPath>) => host.stat(path),
    readdir: (path: ReturnType<typeof localPath>) => host.readdir(path),
    createDirectoryExclusive: (
      path: ReturnType<typeof localPath>,
      options: Parameters<ProjectHost['createDirectoryExclusive']>[1],
    ) => host.createDirectoryExclusive(path, options),
    removeFile: (
      path: ReturnType<typeof localPath>,
      options: Parameters<ProjectHost['removeFile']>[1],
    ) => host.removeFile(path, options),
    fileTransfer: tamperingTransfer,
  } as unknown as ProjectHost
}

function generousLimits(): ProjectFileCopyLimits {
  return {
    maxEntries: 100,
    maxDepth: 100,
    maxFileBytes: 100,
    maxTotalBytes: 100,
  }
}
