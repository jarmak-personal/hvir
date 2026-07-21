import { describe, expect, it } from 'vitest'

import {
  expectedBranchRef,
  expectedMarkerRef,
  expectedWorktreePath,
  isDisposableIgnored,
  parseWorktreeStatus,
} from '../scripts/issue-worktree/worktree-policy.ts'

describe('issue worktree policy', () => {
  it('derives one deterministic workflow namespace from the issue number', () => {
    expect(expectedBranchRef(129)).toBe('refs/heads/agent/issue-129')
    expect(expectedMarkerRef(129)).toBe('refs/hvir/issue-worktrees/129')
    expect(expectedWorktreePath('/repos/hvir', 129)).toBe(
      '/repos/hvir-worktrees/issue-129',
    )
  })

  it.each([
    'node_modules/',
    'node_modules/pkg/cache',
    'out/',
    'dist/bundle.js',
    'coverage/index.html',
    '.cache/tool/output',
    'test-results/',
  ])('recognizes an explicitly disposable ignored path: %s', (candidate) => {
    expect(isDisposableIgnored(candidate)).toBe(true)
  })

  it.each([
    '.env',
    '.private-cache/',
    'src/generated/',
    '../node_modules/',
    '/tmp/node_modules/',
    'packages/client/node_modules/',
  ])('retains an ignored path outside the exact disposable roots: %s', (candidate) => {
    expect(isDisposableIgnored(candidate)).toBe(false)
  })

  it('separates tracked/untracked and safe/unsafe ignored state', () => {
    expect(
      parseWorktreeStatus(
        [
          '1 .M N... 100644 100644 100644 a a src/file.ts',
          '? scratch.txt',
          '! out/',
          '! .env',
        ]
          .join('\0')
          .concat('\0'),
      ),
    ).toEqual({
      trackedOrUntrackedPaths: ['src/file.ts', 'scratch.txt'],
      ignoredPaths: ['out/', '.env'],
      unsafeIgnoredPaths: ['.env'],
    })
  })
})
