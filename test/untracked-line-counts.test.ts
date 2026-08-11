import { describe, expect, it, vi } from 'vitest'

import { GitCommandContext, type GitHostPort } from '../src/main/git/git-command-context'
import { type GitFileStats, type ParsedStatus } from '../src/main/git/git-parsers'
import { addUntrackedLineCounts } from '../src/main/git/untracked-line-counts'
import {
  DIFF_INPUT_BYTE_LIMIT,
  LOCAL_HOST_ID,
  boundTextWorkload,
  localPath,
  type Stat,
  type TextWorkload,
} from '../src/shared'

const root = localPath('/repo')

describe('untracked line counts', () => {
  it('matches Git new-file line counts for complete bounded UTF-8 text', async () => {
    const contents = new Map([
      ['/repo/empty.txt', ''],
      ['/repo/trailing.txt', 'one\ntwo\nthree\n'],
      ['/repo/no-trailing.txt', 'one\ntwo'],
      ['/repo/probed.txt', 'line\n'.repeat(2_000)],
    ])
    const fixture = hostFixture({ contents })
    const stats: GitFileStats = new Map()

    await addUntrackedLineCounts(
      root,
      '',
      [...contents.keys()].map((path) => untracked(path.slice('/repo/'.length))),
      stats,
      fixture.context,
    )

    expect(stats).toEqual(
      new Map([
        ['empty.txt', { additions: 0, deletions: 0 }],
        ['trailing.txt', { additions: 3, deletions: 0 }],
        ['no-trailing.txt', { additions: 2, deletions: 0 }],
        ['probed.txt', { additions: 2_000, deletions: 0 }],
      ]),
    )
    expect(
      fixture.readTextFilePrefix.mock.calls
        .filter(([path]) => path.path === '/repo/probed.txt')
        .map(([, maxBytes]) => maxBytes),
    ).toEqual([8_000, contents.get('/repo/probed.txt')?.length])
  })

  it('skips oversized, non-file, binary, malformed, and unavailable entries', async () => {
    const metadata = new Map<string, Stat | Error>([
      ['/repo/oversized.bin', fileStat(DIFF_INPUT_BYTE_LIMIT + 1)],
      ['/repo/link', { ...fileStat(4), type: 'symlink' }],
      ['/repo/binary.bin', fileStat(128 * 1024)],
      ['/repo/malformed.bin', fileStat(128 * 1024)],
      ['/repo/missing.txt', new Error('missing')],
    ])
    const fixture = hostFixture({
      metadata,
      read: (path, maxBytes) => ({
        ...boundTextWorkload(
          path.path.endsWith('binary.bin') ? `\0${'x'.repeat(maxBytes)}` : 'bad',
          maxBytes,
          false,
        ),
        validUtf8: !path.path.endsWith('malformed.bin'),
      }),
    })
    const stats: GitFileStats = new Map()

    await addUntrackedLineCounts(
      root,
      '',
      [...metadata.keys()].map((path) => untracked(path.slice('/repo/'.length))),
      stats,
      fixture.context,
    )

    expect(stats).toEqual(new Map())
    expect(fixture.readTextFilePrefix).toHaveBeenCalledTimes(2)
    expect(
      fixture.readTextFilePrefix.mock.calls.map(([path, maxBytes]) => [
        path.path,
        maxBytes,
      ]),
    ).toEqual([
      ['/repo/binary.bin', 8_000],
      ['/repo/malformed.bin', 8_000],
    ])
  })

  it('caps all content reads for one changes request', async () => {
    const paths = Array.from({ length: 9 }, (_, index) => `/repo/file-${index}.txt`)
    const metadata = new Map(paths.map((path) => [path, fileStat(DIFF_INPUT_BYTE_LIMIT)]))
    const fixture = hostFixture({
      metadata,
      read: (_path, maxBytes) => ({
        content: maxBytes === 8_000 ? 'probe' : 'complete\n',
        byteLength: maxBytes === 8_000 ? 5 : 9,
        lineCount: 1,
        complete: maxBytes !== 8_000,
        validUtf8: true,
      }),
    })
    const stats: GitFileStats = new Map()

    await addUntrackedLineCounts(
      root,
      '',
      paths.map((path) => untracked(path.slice('/repo/'.length))),
      stats,
      fixture.context,
    )

    expect(stats.size).toBe(7)
    expect(fixture.stat).toHaveBeenCalledTimes(9)
    expect(fixture.readTextFilePrefix).toHaveBeenCalledTimes(14)
    expect(
      fixture.readTextFilePrefix.mock.calls.some(([path]) =>
        path.path.endsWith('file-7.txt'),
      ),
    ).toBe(false)
    expect(
      fixture.readTextFilePrefix.mock.calls.some(([path]) =>
        path.path.endsWith('file-8.txt'),
      ),
    ).toBe(false)
  })
})

function hostFixture(options: {
  readonly contents?: ReadonlyMap<string, string>
  readonly metadata?: ReadonlyMap<string, Stat | Error>
  readonly read?: (path: ReturnType<typeof localPath>, maxBytes: number) => TextWorkload
}): {
  readonly context: GitCommandContext
  readonly stat: ReturnType<typeof vi.fn<GitHostPort['stat']>>
  readonly readTextFilePrefix: ReturnType<typeof vi.fn<GitHostPort['readTextFilePrefix']>>
} {
  const stat = vi.fn<GitHostPort['stat']>((path) => {
    const configured = options.metadata?.get(path.path)
    if (configured instanceof Error) return Promise.reject(configured)
    if (configured) return Promise.resolve(configured)
    const content = options.contents?.get(path.path)
    if (content === undefined) {
      return Promise.reject(new Error(`missing metadata for ${path.path}`))
    }
    return Promise.resolve(fileStat(Buffer.byteLength(content)))
  })
  const readTextFilePrefix = vi.fn<GitHostPort['readTextFilePrefix']>(
    (path, maxBytes) => {
      if (options.read) return Promise.resolve(options.read(path, maxBytes))
      const content = options.contents?.get(path.path)
      if (content === undefined) {
        return Promise.reject(new Error(`missing content for ${path.path}`))
      }
      return Promise.resolve({
        ...boundTextWorkload(content, maxBytes),
        validUtf8: true,
      })
    },
  )
  const host: GitHostPort = {
    hostId: LOCAL_HOST_ID,
    exec: vi.fn(() =>
      Promise.resolve({
        code: 0,
        signal: null,
        stdout: '',
        stderr: '',
      }),
    ),
    readTextFile: vi.fn(() => Promise.resolve('')),
    readTextFilePrefix,
    stat,
  }
  return { context: new GitCommandContext(host), stat, readTextFilePrefix }
}

function fileStat(size: number): Stat {
  return { type: 'file', size, mtimeMs: 0, mode: 0o644 }
}

function untracked(path: string): ParsedStatus {
  return {
    path,
    statusCode: '?',
    staged: false,
    unstaged: false,
    untracked: true,
    conflicted: false,
  }
}
