import { describe, expect, it } from 'vitest'

import {
  commitTreeEntryHeight,
  displayGitParentPath,
  flattenCommitFiles,
  sumCommitFileChanges,
} from '../src/renderer/src/git/commit-file-tree'
import { localPath, type GitCommitFile } from '../src/shared'

describe('commit file tree', () => {
  const root = localPath('/project')
  const files: readonly GitCommitFile[] = [
    {
      path: localPath('/project/README.md'),
      additions: 2,
      deletions: 0,
    },
    {
      path: localPath('/project/src/App.tsx'),
      additions: 8,
      deletions: 3,
    },
    {
      path: localPath('/project/src/git/history.ts'),
      additions: 12,
      deletions: 1,
    },
  ]

  it('flattens host-qualified paths into stable directory and file rows', () => {
    expect(flattenCommitFiles(files, root, new Set())).toMatchObject([
      { kind: 'directory', path: 'src', name: 'src', depth: 0, expanded: true },
      { kind: 'directory', path: 'src/git', name: 'git', depth: 1, expanded: true },
      { kind: 'file', name: 'history.ts', depth: 2 },
      { kind: 'file', name: 'App.tsx', depth: 1 },
      { kind: 'file', name: 'README.md', depth: 0 },
    ])
  })

  it('omits descendants of a collapsed directory', () => {
    expect(flattenCommitFiles(files, root, new Set(['src']))).toMatchObject([
      { kind: 'directory', path: 'src', expanded: false },
      { kind: 'file', name: 'README.md', depth: 0 },
    ])
  })

  it('uses tighter rows for directory chains than for file siblings', () => {
    expect(flattenCommitFiles(files, root, new Set()).map(commitTreeEntryHeight)).toEqual(
      [18, 18, 22, 22, 22],
    )
  })

  it('summarizes additions and deletions once for commit surfaces', () => {
    expect(sumCommitFileChanges(files)).toEqual({ additions: 22, deletions: 4 })
  })

  it('provides a compact parent label for duplicate basenames', () => {
    expect(displayGitParentPath(localPath('/project/src/api/index.ts'), root)).toBe(
      'src/api',
    )
    expect(displayGitParentPath(localPath('/project/README.md'), root)).toBe('')
  })
})
