import { describe, expect, it } from 'vitest'

import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  parseBlame,
  parseBranchTracking,
  parseCommitDetail,
  parseLegacyWorktreeList,
  parseNumstat,
  parseStatus,
  parseWorktreeList,
} from '../src/main/git/git-parsers'
import { asHostId, hostPath } from '../src/shared'

const hostId = asHostId('local')

describe('Git pure parsers', () => {
  it('normalizes modern worktree porcelain and ignores unknown fields', () => {
    const hash = 'a'.repeat(64)
    const parsed = parseWorktreeList(
      `worktree /repo\0HEAD ${hash}\0branch refs/heads/main\0future value\0\0`,
      hostId,
    )

    expect(parsed).toEqual([
      {
        root: { hostId, path: '/repo' },
        head: hash,
        branch: 'main',
        detached: false,
        bare: false,
      },
    ])
  })

  it('accepts the legacy line-delimited worktree format and rejects unsafe roots', () => {
    expect(
      parseLegacyWorktreeList(
        `worktree /repo with spaces\r\nHEAD ${'b'.repeat(40)}\r\ndetached\r\n`,
        hostId,
      ),
    ).toEqual([
      {
        root: { hostId, path: '/repo with spaces' },
        head: 'b'.repeat(40),
        detached: true,
        bare: false,
      },
    ])
    expect(() => parseWorktreeList('worktree relative\0', hostId)).toThrow(
      'non-absolute worktree',
    )
  })

  it('parses status v2 rename records without mistaking the source path for a change', () => {
    const output = [
      '? untracked file',
      '2 R. N... 100644 100644 100644 a b R100 renamed file',
      'old file',
      '1 M. N... 100644 100644 100644 a b tracked file',
      '? ',
      'malformed',
      '',
    ].join('\0')

    expect(parseStatus(output)).toEqual([
      expect.objectContaining({ path: 'untracked file', untracked: true }),
      expect.objectContaining({ path: 'renamed file', staged: true }),
      expect.objectContaining({ path: 'tracked file', staged: true }),
    ])
  })

  it('normalizes binary and rename numstat while dropping malformed counts', () => {
    const stats = parseNumstat(
      ['-\t-\tbinary.dat', '4\t2\t', 'old.ts', 'new.ts', 'nope\t3\tbad.ts', ''].join(
        '\0',
      ),
    )

    expect([...stats.entries()]).toEqual([
      ['binary.dat', { additions: 0, deletions: 0 }],
      ['new.ts', { additions: 4, deletions: 2 }],
    ])
  })

  it('marks a configured upstream gone when older status output omits branch.ab', () => {
    expect(parseBranchTracking('# branch.upstream origin/main\0')).toEqual({
      name: 'origin/main',
      ahead: 0,
      behind: 0,
      gone: true,
    })
    expect(
      parseBranchTracking('# branch.upstream origin/main\0# branch.ab +2 -3\0'),
    ).toEqual({ name: 'origin/main', ahead: 2, behind: 3 })
  })

  it('round-trips a bounded history frontier and rejects malformed cursors', () => {
    const frontier = ['c'.repeat(40), 'd'.repeat(64)]
    expect(decodeHistoryCursor(encodeHistoryCursor(frontier))).toEqual(frontier)
    expect(() => decodeHistoryCursor('not-json')).toThrow('Invalid Git history cursor')
    expect(() => encodeHistoryCursor([])).toThrow('continuation frontier is invalid')
  })

  it('coalesces adjacent blame lines and ignores incomplete records', () => {
    const hash = 'e'.repeat(40)
    expect(
      parseBlame(
        [
          `${hash} 1 1`,
          'author Seven',
          'summary Engage',
          '\tfirst',
          'malformed header',
          `${hash} 2 2`,
          'author Seven',
          'summary Engage',
          '\tsecond',
          `${hash} 3 3`,
          'author Incomplete',
        ].join('\n'),
      ),
    ).toEqual([
      {
        startLine: 1,
        lineCount: 2,
        hash,
        author: 'Seven',
        summary: 'Engage',
      },
    ])
  })

  it('rejects malformed commit detail before path normalization', () => {
    expect(() =>
      parseCommitDetail('missing record separator', hostPath(hostId, '/repo'), ''),
    ).toThrow('malformed commit detail')
  })
})
