import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  organizeProjectEntry,
  removeVerifiedProjectEntry,
  removeExactStagingTree,
} from '../src/main/project-file-operations'
import { PROJECT_FILE_COPY_LIMITS } from '../src/main/project-file-operations/project-file-copy-limits'
import { LocalHost } from '../src/main/project-host/local-host'
import type {
  ProjectFileTransferPort,
  ProjectHost,
} from '../src/main/project-host/project-host'
import { joinHostPath, localPath, type HostPath } from '../src/shared'

describe('project entry organization policy', () => {
  let directory: string
  let host: LocalHost
  let root: HostPath
  let nextId: number

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'hvir-organize-'))
    host = new LocalHost()
    await host.connect()
    root = localPath(directory)
    nextId = 0
  })

  afterEach(async () => {
    await host.dispose()
    await rm(directory, { recursive: true, force: true })
  })

  it('renames a file and moves a directory without rewriting their contents', async () => {
    const source = joinHostPath(root, 'source.txt')
    await writeFile(source.path, 'source bytes')
    const sourceMetadata = await host.stat(source)
    const renamed = await organize({
      action: 'rename',
      workspaceRoot: root,
      source,
      name: 'renamed.txt',
    })

    expect(renamed).toMatchObject({
      status: 'completed',
      effect: 'renamed-entry',
      source,
      destination: joinHostPath(root, 'renamed.txt'),
    })
    await expect(readFile(source.path)).rejects.toThrow()
    await expect(readFile(join(root.path, 'renamed.txt'), 'utf8')).resolves.toBe(
      'source bytes',
    )
    const renamedMetadata = await host.stat(joinHostPath(root, 'renamed.txt'))
    expect(renamedMetadata.mode).toBe(sourceMetadata.mode)
    expect(renamedMetadata.mtimeMs).toBe(sourceMetadata.mtimeMs)

    const from = joinHostPath(root, 'from')
    const to = joinHostPath(root, 'to')
    await mkdir(join(from.path, 'nested'), { recursive: true })
    await mkdir(to.path)
    await writeFile(join(from.path, 'nested', 'entry.txt'), 'nested bytes')
    const moved = await organize({
      action: 'move',
      workspaceRoot: root,
      source: from,
      destinationDirectory: to,
    })

    expect(moved).toMatchObject({
      status: 'completed',
      effect: 'moved-entry',
      destination: joinHostPath(to, 'from'),
    })
    await expect(readFile(join(from.path, 'nested', 'entry.txt'))).rejects.toThrow()
    await expect(
      readFile(join(to.path, 'from', 'nested', 'entry.txt'), 'utf8'),
    ).resolves.toBe('nested bytes')
  })

  it('duplicates through verified staging and leaves the source unchanged', async () => {
    const source = joinHostPath(root, 'source')
    const destinationDirectory = joinHostPath(root, 'copies')
    await mkdir(source.path)
    await mkdir(destinationDirectory.path)
    await writeFile(join(source.path, 'entry.sh'), '#!/bin/sh\necho exact\n', {
      mode: 0o755,
    })

    const result = await organize({
      action: 'duplicate',
      workspaceRoot: root,
      source,
      destinationDirectory,
      name: 'duplicate',
    })

    expect(result).toMatchObject({
      status: 'completed',
      effect: 'duplicated-directory',
      sourceDisposition: { outcome: 'retained', path: source },
    })
    await expect(readFile(join(source.path, 'entry.sh'), 'utf8')).resolves.toContain(
      'echo exact',
    )
    await expect(
      readFile(join(destinationDirectory.path, 'duplicate', 'entry.sh'), 'utf8'),
    ).resolves.toContain('echo exact')
  })

  it('never overwrites and rejects roots, descendants, and symbolic-link copies', async () => {
    const source = joinHostPath(root, 'source')
    const existing = joinHostPath(root, 'existing')
    await writeFile(source.path, 'source')
    await writeFile(existing.path, 'existing')
    await expect(
      organize({ action: 'rename', workspaceRoot: root, source, name: 'existing' }),
    ).resolves.toMatchObject({ status: 'conflicted', effect: 'none' })
    await expect(readFile(existing.path, 'utf8')).resolves.toBe('existing')
    await expect(readFile(source.path, 'utf8')).resolves.toBe('source')

    await expect(
      organize({ action: 'rename', workspaceRoot: root, source: root, name: 'nope' }),
    ).resolves.toMatchObject({ status: 'skipped', effect: 'none' })

    const tree = joinHostPath(root, 'tree')
    const child = joinHostPath(tree, 'child')
    await mkdir(child.path, { recursive: true })
    await expect(
      organize({
        action: 'move',
        workspaceRoot: root,
        source: tree,
        destinationDirectory: child,
      }),
    ).resolves.toMatchObject({ status: 'skipped', effect: 'none' })

    const link = joinHostPath(root, 'link')
    await symlink(source.path, link.path)
    await expect(
      organize({
        action: 'duplicate',
        workspaceRoot: root,
        source: link,
        destinationDirectory: root,
        name: 'link-copy',
      }),
    ).resolves.toMatchObject({ status: 'skipped', effect: 'none' })
  })

  it('moves symbolic links as entries without following their targets', async () => {
    const target = joinHostPath(root, 'target.txt')
    const source = joinHostPath(root, 'link')
    const destinationDirectory = joinHostPath(root, 'destination')
    await writeFile(target.path, 'target stays')
    await symlink(target.path, source.path)
    await mkdir(destinationDirectory.path)

    const result = await organize({
      action: 'move',
      workspaceRoot: root,
      source,
      destinationDirectory,
    })

    expect(result).toMatchObject({ status: 'completed', effect: 'moved-entry' })
    await expect(readFile(target.path, 'utf8')).resolves.toBe('target stays')
    expect(await host.stat(joinHostPath(destinationDirectory, 'link'))).toMatchObject({
      type: 'symlink',
    })
  })

  it('restores a case-only rename when publication conflicts', async () => {
    const source = joinHostPath(root, 'File.txt')
    await writeFile(source.path, 'recover me')
    let calls = 0
    const wrapped = wrappedHost(host, {
      renameNoReplace: async (from, to, options) => {
        calls += 1
        if (calls === 2) {
          throw Object.assign(new Error('collision'), { code: 'EEXIST' })
        }
        return host.fileTransfer.renameNoReplace(from, to, options)
      },
    })

    const result = await organizeWithHost(wrapped, {
      action: 'rename',
      workspaceRoot: root,
      source,
      name: 'file.txt',
    })

    expect(result).toMatchObject({
      status: 'failed',
      effect: 'none',
      sourceDisposition: { outcome: 'retained', path: source },
    })
    await expect(readFile(source.path, 'utf8')).resolves.toBe('recover me')
  })

  it('completes a case-only rename with exact requested casing and no recovery path', async () => {
    const source = joinHostPath(root, 'File.txt')
    const destination = joinHostPath(root, 'file.txt')
    await writeFile(source.path, 'case exact bytes')

    const result = await organize({
      action: 'rename',
      workspaceRoot: root,
      source,
      name: 'file.txt',
    })

    expect(result).toMatchObject({
      status: 'completed',
      effect: 'renamed-entry',
      destination,
      sourceDisposition: { outcome: 'removed' },
    })
    await expect(readFile(destination.path, 'utf8')).resolves.toBe('case exact bytes')
    const names = await readdir(root.path)
    expect(names).toContain('file.txt')
    expect(names).not.toContain('File.txt')
    expect(names.filter((name) => name.includes('.hvir-rename-'))).toEqual([])
  })

  it('reports the exact retained temporary path when case-only rollback fails', async () => {
    const source = joinHostPath(root, 'File.txt')
    await writeFile(source.path, 'only copy')
    let calls = 0
    const wrapped = wrappedHost(host, {
      renameNoReplace: async (from, to, options) => {
        calls += 1
        if (calls > 1)
          throw new Error(calls === 2 ? 'publication failed' : 'restore failed')
        return host.fileTransfer.renameNoReplace(from, to, options)
      },
    })

    const result = await organizeWithHost(wrapped, {
      action: 'rename',
      workspaceRoot: root,
      source,
      name: 'file.txt',
    })

    expect(result).toMatchObject({ status: 'failed', effect: 'none' })
    expect(result.sourceDisposition?.outcome).toBe('retained')
    expect(result.sourceDisposition?.path?.path).toContain('.hvir-rename-temp-')
    await expect(readFile(source.path)).rejects.toThrow()
    await expect(readFile(result.sourceDisposition!.path!.path, 'utf8')).resolves.toBe(
      'only copy',
    )
  })

  it('falls back on EXDEV and reports copied-but-retained source removal failure', async () => {
    const source = joinHostPath(root, 'source.txt')
    const destinationDirectory = joinHostPath(root, 'destination')
    const destination = joinHostPath(destinationDirectory, 'source.txt')
    await writeFile(source.path, 'cross-device bytes')
    await mkdir(destinationDirectory.path)
    const wrapped = wrappedHost(
      host,
      {
        renameNoReplace: (from, to, options) =>
          from.path === source.path
            ? Promise.reject(Object.assign(new Error('cross-device'), { code: 'EXDEV' }))
            : host.fileTransfer.renameNoReplace(from, to, options),
      },
      {
        removeFile: (path, options) =>
          path.path === source.path
            ? Promise.reject(new Error('source retained by policy test'))
            : host.removeFile(path, options),
      },
    )

    const result = await organizeWithHost(wrapped, {
      action: 'move',
      workspaceRoot: root,
      source,
      destinationDirectory,
    })

    expect(result).toMatchObject({
      status: 'failed',
      effect: 'copied-file',
      sourceDisposition: { outcome: 'retained', path: source },
    })
    await expect(readFile(source.path, 'utf8')).resolves.toBe('cross-device bytes')
    await expect(readFile(destination.path, 'utf8')).resolves.toBe('cross-device bytes')
  })

  it('completes an EXDEV file move only after verified source removal', async () => {
    const source = joinHostPath(root, 'source.txt')
    const destinationDirectory = joinHostPath(root, 'destination')
    const destination = joinHostPath(destinationDirectory, 'source.txt')
    await writeFile(source.path, 'cross-device success')
    await mkdir(destinationDirectory.path)
    const wrapped = wrappedHost(host, {
      renameNoReplace: (from, to, options) =>
        from.path === source.path
          ? Promise.reject(Object.assign(new Error('cross-device'), { code: 'EXDEV' }))
          : host.fileTransfer.renameNoReplace(from, to, options),
    })

    const result = await organizeWithHost(wrapped, {
      action: 'move',
      workspaceRoot: root,
      source,
      destinationDirectory,
    })

    expect(result).toMatchObject({
      status: 'completed',
      effect: 'moved-entry',
      sourceDisposition: { outcome: 'removed' },
    })
    await expect(readFile(source.path)).rejects.toThrow()
    await expect(readFile(destination.path, 'utf8')).resolves.toBe('cross-device success')
  })

  it('reports a partially removed EXDEV directory without claiming a move', async () => {
    const source = joinHostPath(root, 'source')
    const destinationDirectory = joinHostPath(root, 'destination')
    const destination = joinHostPath(destinationDirectory, 'source')
    await mkdir(source.path)
    await mkdir(destinationDirectory.path)
    await writeFile(join(source.path, 'a.txt'), 'a')
    await writeFile(join(source.path, 'b.txt'), 'b')
    let removals = 0
    const wrapped = wrappedHost(
      host,
      {
        renameNoReplace: (from, to, options) =>
          from.path === source.path
            ? Promise.reject(Object.assign(new Error('cross-device'), { code: 'EXDEV' }))
            : host.fileTransfer.renameNoReplace(from, to, options),
      },
      {
        removeFile: (path, options) => {
          removals += 1
          return removals === 1
            ? host.removeFile(path, options)
            : Promise.reject(new Error('second removal failed'))
        },
      },
    )

    const result = await organizeWithHost(wrapped, {
      action: 'move',
      workspaceRoot: root,
      source,
      destinationDirectory,
    })

    expect(result).toMatchObject({
      status: 'failed',
      effect: 'copied-directory',
      sourceDisposition: {
        outcome: 'partially-removed',
        path: source,
        removedEntries: 1,
        totalEntries: 3,
      },
    })
    await expect(readFile(join(destination.path, 'a.txt'), 'utf8')).resolves.toBe('a')
    await expect(readFile(join(destination.path, 'b.txt'), 'utf8')).resolves.toBe('b')
  })

  it('retains the source when cancellation arrives after EXDEV publication', async () => {
    const source = joinHostPath(root, 'source.txt')
    const destinationDirectory = joinHostPath(root, 'destination')
    const destination = joinHostPath(destinationDirectory, 'source.txt')
    const abort = new AbortController()
    await writeFile(source.path, 'published bytes')
    await mkdir(destinationDirectory.path)
    const wrapped = wrappedHost(host, {
      renameNoReplace: async (from, to, options) => {
        if (from.path === source.path) {
          throw Object.assign(new Error('cross-device'), { code: 'EXDEV' })
        }
        await host.fileTransfer.renameNoReplace(from, to, options)
        abort.abort(new Error('cancelled after destination publication'))
      },
    })

    const result = await organizeWithHost(
      wrapped,
      { action: 'move', workspaceRoot: root, source, destinationDirectory },
      abort,
    )

    expect(result).toMatchObject({
      status: 'failed',
      effect: 'copied-file',
      sourceDisposition: { outcome: 'retained', path: source },
    })
    await expect(readFile(source.path, 'utf8')).resolves.toBe('published bytes')
    await expect(readFile(destination.path, 'utf8')).resolves.toBe('published bytes')
  })

  it('refuses source removal when live metadata changed after receipt verification', async () => {
    const source = joinHostPath(root, 'source.txt')
    await writeFile(source.path, 'old')
    const initial = await host.stat(source)
    await writeFile(source.path, 'mutated after verification')
    const assertCommitAllowed = vi.fn()

    const result = await removeVerifiedProjectEntry({
      host,
      source,
      receipt: {
        plan: {
          entries: [
            {
              relativePath: '',
              type: 'file',
              size: initial.size,
              mode: (initial.mode & 0o111) !== 0 ? 0o755 : 0o644,
              mtimeSeconds: Math.floor(initial.mtimeMs / 1_000),
            },
          ],
          totalBytes: initial.size,
        },
        manifest: [],
      },
      assertCommitAllowed,
    })

    expect(result.disposition).toMatchObject({
      outcome: 'retained',
      path: source,
      removedEntries: 0,
    })
    expect(assertCommitAllowed).not.toHaveBeenCalled()
    await expect(readFile(source.path, 'utf8')).resolves.toBe(
      'mutated after verification',
    )
  })

  it('cancels before rename submission without changing either path', async () => {
    const source = joinHostPath(root, 'source.txt')
    const destination = joinHostPath(root, 'destination.txt')
    await writeFile(source.path, 'source')
    const abort = new AbortController()
    const wrapped = wrappedHost(host, {
      renameNoReplace: (_from, _to, options) => {
        abort.abort(new Error('cancelled while the host prepared submission'))
        options?.signal?.throwIfAborted()
        return Promise.resolve()
      },
    })

    const result = await organizeWithHost(
      wrapped,
      { action: 'rename', workspaceRoot: root, source, name: 'destination.txt' },
      abort,
    )

    expect(result).toMatchObject({ status: 'cancelled', effect: 'none' })
    await expect(readFile(source.path, 'utf8')).resolves.toBe('source')
    await expect(readFile(destination.path)).rejects.toThrow()
  })

  async function organize(
    request: Parameters<typeof organizeProjectEntry>[0]['request'],
  ) {
    return organizeWithHost(host, request)
  }

  async function organizeWithHost(
    selectedHost: ProjectHost,
    request: Parameters<typeof organizeProjectEntry>[0]['request'],
    abort = new AbortController(),
  ) {
    return organizeProjectEntry({
      request,
      host: selectedHost,
      canonicalRoot: root,
      signal: abort.signal,
      assertCurrent: () => abort.signal.throwIfAborted(),
      limits: PROJECT_FILE_COPY_LIMITS,
      createStagingId: () => `stage-${(nextId += 1)}`,
      createTemporaryId: () => `temp-${(nextId += 1)}`,
      cleanupStaging: removeExactStagingTree,
    })
  }
})

function wrappedHost(
  host: LocalHost,
  transferOverrides: Partial<ProjectFileTransferPort>,
  hostOverrides: Partial<ProjectHost> = {},
): ProjectHost {
  const transfer: ProjectFileTransferPort = {
    ...host.fileTransfer,
    ...transferOverrides,
  }
  return new Proxy(host, {
    get(target, property) {
      if (property === 'fileTransfer') return transfer
      const override = hostOverrides[property as keyof ProjectHost]
      if (override !== undefined) return override
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function'
        ? (...args: readonly unknown[]): unknown =>
            Reflect.apply(value, target, args) as unknown
        : value
    },
  })
}
