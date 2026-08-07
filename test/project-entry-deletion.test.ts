import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { deleteProjectEntry } from '../src/main/project-file-operations'
import { PROJECT_FILE_COPY_LIMITS } from '../src/main/project-file-operations/project-file-copy-limits'
import { LocalHost } from '../src/main/project-host/local-host'
import type { ProjectHost } from '../src/main/project-host/project-host'
import { joinHostPath, localPath, type HostPath } from '../src/shared'

describe('project entry deletion policy', () => {
  let directory: string
  let outsideDirectory: string
  let root: HostPath
  let host: LocalHost

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'hvir-delete-'))
    outsideDirectory = await mkdtemp(join(tmpdir(), 'hvir-delete-outside-'))
    root = localPath(directory)
    host = new LocalHost()
    await host.connect()
  })

  afterEach(async () => {
    await host.dispose()
    await Promise.all([
      rm(directory, { recursive: true, force: true }),
      rm(outsideDirectory, { recursive: true, force: true }),
    ])
  })

  it('moves one top-level entry through the recoverable port and never falls back', async () => {
    const source = joinHostPath(root, 'recoverable.txt')
    const recovered = joinHostPath(root, '.recovered.txt')
    await writeFile(source.path, 'recoverable bytes')
    await host.dispose()
    host = new LocalHost({
      trashItem: async (path) => rename(path.path, recovered.path),
    })
    await host.connect()
    const removeFile = vi.spyOn(host, 'removeFile')

    const result = await run(host, source, 'recoverable')

    expect(result).toMatchObject({
      status: 'completed',
      effect: 'trashed-entry',
      sourceDisposition: { outcome: 'removed', removedEntries: 1, totalEntries: 1 },
    })
    expect(removeFile).not.toHaveBeenCalled()
    await expect(readFile(source.path)).rejects.toThrow()
    await expect(readFile(recovered.path, 'utf8')).resolves.toBe('recoverable bytes')
  })

  it('keeps the entry when recoverable trash fails and does not remove permanently', async () => {
    const source = joinHostPath(root, 'retained.txt')
    await writeFile(source.path, 'must remain')
    await host.dispose()
    host = new LocalHost({
      trashItem: () => Promise.reject(new Error('trash unavailable now')),
    })
    await host.connect()
    const removeFile = vi.spyOn(host, 'removeFile')

    const result = await run(host, source, 'recoverable')

    expect(result).toMatchObject({
      status: 'failed',
      effect: 'none',
      sourceDisposition: { outcome: 'retained', path: source },
      reason: 'trash unavailable now',
    })
    expect(removeFile).not.toHaveBeenCalled()
    await expect(readFile(source.path, 'utf8')).resolves.toBe('must remain')
  })

  it('reports unknown source state when submitted Trash moves then rejects', async () => {
    const source = joinHostPath(root, 'submitted.txt')
    const recovered = joinHostPath(root, '.submitted-recovered.txt')
    await writeFile(source.path, 'submitted bytes')
    await host.dispose()
    host = new LocalHost({
      trashItem: async (path) => {
        await rename(path.path, recovered.path)
        throw new Error('Trash callback rejected after moving')
      },
    })
    await host.connect()
    const removeFile = vi.spyOn(host, 'removeFile')

    const result = await run(host, source, 'recoverable')

    expect(result).toMatchObject({
      status: 'failed',
      effect: 'deletion-state-unknown',
      sourceDisposition: { outcome: 'unknown', path: source, totalEntries: 1 },
      reason: 'Trash callback rejected after moving',
    })
    expect(removeFile).not.toHaveBeenCalled()
    await expect(readFile(source.path)).rejects.toThrow()
    await expect(readFile(recovered.path, 'utf8')).resolves.toBe('submitted bytes')
  })

  it('removes a permanent directory bottom-up without following its symbolic link', async () => {
    const source = joinHostPath(root, 'tree')
    const outside = join(outsideDirectory, 'outside.txt')
    await mkdir(source.path)
    await writeFile(join(source.path, 'inside.txt'), 'inside')
    await writeFile(outside, 'outside')
    await symlink(outside, join(source.path, 'outside-link'))

    const result = await run(permanentHost(host), source, 'permanent')

    expect(result).toMatchObject({
      status: 'completed',
      effect: 'permanently-deleted-entry',
      sourceDisposition: { outcome: 'removed', removedEntries: 3, totalEntries: 3 },
    })
    await expect(host.stat(source)).rejects.toThrow()
    await expect(readFile(outside, 'utf8')).resolves.toBe('outside')
  })

  it('rejects a bounded tree before destructive execution', async () => {
    const source = joinHostPath(root, 'bounded')
    await mkdir(source.path)
    await writeFile(join(source.path, 'one.txt'), 'one')
    await writeFile(join(source.path, 'two.txt'), 'two')

    const result = await run(permanentHost(host), source, 'permanent', {
      ...PROJECT_FILE_COPY_LIMITS,
      maxEntries: 2,
    })

    expect(result).toMatchObject({ status: 'failed', effect: 'none' })
    expect(result.reason).toContain('entry limit')
    await expect(readFile(join(source.path, 'one.txt'), 'utf8')).resolves.toBe('one')
    await expect(readFile(join(source.path, 'two.txt'), 'utf8')).resolves.toBe('two')
  })

  it('reports exact partial retained state when permanent removal fails', async () => {
    const source = joinHostPath(root, 'partial')
    await mkdir(source.path)
    await writeFile(join(source.path, 'a.txt'), 'a')
    await writeFile(join(source.path, 'b.txt'), 'b')
    const wrapped = permanentHost(host, {
      removeFile: (path, options) =>
        basename(path.path) === 'a.txt'
          ? Promise.reject(new Error('a retained'))
          : host.removeFile(path, options),
    })

    const result = await run(wrapped, source, 'permanent')

    expect(result).toMatchObject({
      status: 'failed',
      effect: 'partially-deleted-entry',
      sourceDisposition: {
        outcome: 'partially-removed',
        path: source,
        removedEntries: 1,
        totalEntries: 3,
      },
      reason: 'a retained',
    })
    await expect(readFile(join(source.path, 'a.txt'), 'utf8')).resolves.toBe('a')
    await expect(readFile(join(source.path, 'b.txt'))).rejects.toThrow()
  })

  it('returns failed partial truth when cancellation arrives after the first primitive', async () => {
    const source = joinHostPath(root, 'cancel-partial')
    await mkdir(source.path)
    await writeFile(join(source.path, 'a.txt'), 'a')
    await writeFile(join(source.path, 'b.txt'), 'b')
    const abort = new AbortController()
    const wrapped = permanentHost(host, {
      removeFile: async (path, options) => {
        await host.removeFile(path, options)
        abort.abort(new Error('deadline reached'))
      },
    })

    const result = await run(
      wrapped,
      source,
      'permanent',
      PROJECT_FILE_COPY_LIMITS,
      abort,
    )

    expect(result).toMatchObject({
      status: 'failed',
      effect: 'partially-deleted-entry',
      sourceDisposition: { outcome: 'partially-removed', removedEntries: 1 },
      reason: 'deadline reached',
    })
  })

  it('cancels before destructive execution and rejects a stale target', async () => {
    const cancelledSource = joinHostPath(root, 'cancelled.txt')
    await writeFile(cancelledSource.path, 'cancelled')
    const abort = new AbortController()
    abort.abort(new Error('cancelled before commit'))
    const cancelled = await run(
      permanentHost(host),
      cancelledSource,
      'permanent',
      PROJECT_FILE_COPY_LIMITS,
      abort,
    )
    expect(cancelled).toMatchObject({ status: 'cancelled', effect: 'none' })
    await expect(readFile(cancelledSource.path, 'utf8')).resolves.toBe('cancelled')

    const staleSource = joinHostPath(root, 'stale.txt')
    await writeFile(staleSource.path, 'old')
    let observations = 0
    const staleHost = permanentHost(host, {
      stat: async (path) => {
        if (basename(path.path) === 'stale.txt' && (observations += 1) === 3) {
          await writeFile(staleSource.path, 'changed after confirmation')
        }
        return host.stat(path)
      },
    })
    const stale = await run(staleHost, staleSource, 'permanent')
    expect(stale).toMatchObject({ status: 'failed', effect: 'none' })
    expect(stale.reason).toContain('changed during confirmation')
    await expect(readFile(staleSource.path, 'utf8')).resolves.toBe(
      'changed after confirmation',
    )
  })

  async function run(
    selectedHost: ProjectHost,
    source: HostPath,
    recovery: 'recoverable' | 'permanent',
    limits = PROJECT_FILE_COPY_LIMITS,
    abort = new AbortController(),
  ) {
    return deleteProjectEntry({
      host: selectedHost,
      workspaceRoot: root,
      canonicalRoot: await selectedHost.realpath(root),
      source,
      confirmedRecovery: recovery,
      signal: abort.signal,
      assertCurrent: () => abort.signal.throwIfAborted(),
      limits,
    })
  }
})

function permanentHost(
  host: LocalHost,
  overrides: Partial<ProjectHost> = {},
): ProjectHost {
  return new Proxy(host, {
    get(target, property) {
      if (property === 'fileDeletion') return { capability: 'permanent' }
      const override = overrides[property as keyof ProjectHost]
      if (override !== undefined) return override
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function'
        ? (...args: readonly unknown[]): unknown => Reflect.apply(value, target, args)
        : value
    },
  })
}
