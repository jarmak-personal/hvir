import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  enumerateFilenames,
  type GitIgnorePort,
} from '../src/main/filename-search/filename-enumerator'
import { LocalHost, SshHost } from '../src/main/project-host'
import type { SshFileAccess } from '../src/main/project-host/ssh-file-access'
import { hostPath, localPath } from '../src/shared'

const cleanupPaths: string[] = []

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true })))
})

describe('filename enumeration', () => {
  it('searches a local tree, excludes Git internals and ignored entries, and confines links', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hvir-filename-search-'))
    cleanupPaths.push(directory)
    await Promise.all([
      mkdir(join(directory, 'src'), { recursive: true }),
      mkdir(join(directory, 'docs'), { recursive: true }),
      mkdir(join(directory, 'lib'), { recursive: true }),
      mkdir(join(directory, 'ignored'), { recursive: true }),
      mkdir(join(directory, '.git'), { recursive: true }),
    ])
    await Promise.all([
      writeFile(join(directory, 'src', 'inside.ts'), ''),
      writeFile(join(directory, 'docs', 'guide.md'), ''),
      writeFile(join(directory, 'lib', 'helper.ts'), ''),
      writeFile(join(directory, 'ignored', 'secret.ts'), ''),
      writeFile(join(directory, '.git', 'config'), ''),
    ])
    await symlink(join(directory, 'src'), join(directory, 'src', 'loop'))
    await symlink(tmpdir(), join(directory, 'outside'))
    const host = new LocalHost()
    const root = localPath(directory)
    const ignoredPaths = vi.fn((_root, paths: readonly string[]) =>
      Promise.resolve(new Set(paths.filter((path) => path === 'ignored'))),
    )
    const ignored: GitIgnorePort = { ignoredPaths }

    const result = await enumerateFilenames({
      host,
      root,
      canonicalRoot: await host.realpath(root),
      includeIgnored: false,
      gitIgnore: ignored,
      signal: new AbortController().signal,
    })

    expect(result.files.map((file) => file.name)).toEqual([
      'guide.md',
      'helper.ts',
      'inside.ts',
    ])
    expect(result.truncated).toBe(false)
    expect(ignoredPaths).toHaveBeenCalledTimes(2)
  })

  it('uses the same traversal contract through SshHost', async () => {
    const session = Object.assign(new EventEmitter(), {
      end: vi.fn(),
      readdir: vi.fn(
        (
          path: string,
          callback: (error: Error | undefined, entries: unknown[]) => void,
        ) => {
          callback(
            undefined,
            path === '/project'
              ? [directoryEntry('nested', 0o040755), directoryEntry('root.md')]
              : [directoryEntry('remote.ts')],
          )
        },
      ),
    })
    const host = new SshHost({
      config: {
        alias: 'test',
        hostname: 'example.test',
        user: 'test',
        port: 22,
        identityFiles: [],
      },
      prompter: { prompt: () => Promise.resolve(undefined) },
    })
    ;(host as unknown as { state: 'connected' }).state = 'connected'
    ;(
      (host as unknown as { files: SshFileAccess }).files as unknown as {
        getSftp(): Promise<SFTPWrapper>
      }
    ).getSftp = () => Promise.resolve(session as unknown as SFTPWrapper)
    const root = hostPath(host.hostId, '/project')

    const result = await enumerateFilenames({
      host,
      root,
      canonicalRoot: root,
      includeIgnored: true,
      signal: new AbortController().signal,
    })

    expect(result.files.map((file) => file.path.path).sort()).toEqual([
      '/project/nested/remote.ts',
      '/project/root.md',
    ])
  })

  it('discloses entry, depth, and time bounds and rejects cancellation', async () => {
    const host = new LocalHost()
    const directory = await mkdtemp(join(tmpdir(), 'hvir-filename-bounds-'))
    cleanupPaths.push(directory)
    await Promise.all(
      ['one.ts', 'two.ts', 'three.ts'].map((name) =>
        writeFile(join(directory, name), ''),
      ),
    )
    const root = localPath(directory)
    const bounded = await enumerateFilenames({
      host,
      root,
      canonicalRoot: root,
      includeIgnored: true,
      signal: new AbortController().signal,
      limits: { entries: 2, directories: 1, depth: 0, timeMs: 1_000 },
    })
    expect(bounded.files).toHaveLength(2)
    expect(bounded.truncated).toBe(true)

    const controller = new AbortController()
    controller.abort(new Error('cancelled by test'))
    await expect(
      enumerateFilenames({
        host,
        root,
        canonicalRoot: root,
        includeIgnored: true,
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled by test')
  })
})

function directoryEntry(filename: string, mode = 0o100644) {
  return { filename, attrs: { mode, size: 0, mtime: 100 } }
}
