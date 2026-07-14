import { describe, expect, it } from 'vitest'

import {
  buildTreeGitDecorations,
  treeGitPathKey,
} from '../src/renderer/src/tree/git-status-decoration'
import { localPath, type GitChangedFile } from '../src/shared'

describe('file-tree Git decorations', () => {
  it('decorates files and aggregates the strongest status through collapsed parents', () => {
    const root = localPath('/repo')
    const decorations = buildTreeGitDecorations(root, [
      changed('/repo/src/modified.ts', { unstaged: true }),
      changed('/repo/src/new.ts', { untracked: true }),
      changed('/repo/docs/conflict.md', {
        staged: true,
        unstaged: true,
        conflicted: true,
      }),
    ])

    expect(decorations.files.get(key('/repo/src/modified.ts'))).toEqual({
      tone: 'modified',
      marker: 'M',
      label: 'Git modified',
    })
    expect(decorations.files.get(key('/repo/src/new.ts'))).toEqual({
      tone: 'untracked',
      marker: '?',
      label: 'Git untracked',
    })
    expect(decorations.directories.get(key('/repo/src'))).toEqual({
      tone: 'modified',
      changedCount: 2,
      label: '2 changed files: 1 modified, 1 untracked',
    })
    expect(decorations.directories.get(key('/repo'))).toEqual({
      tone: 'conflict',
      changedCount: 3,
      label: '3 changed files: 1 conflict, 1 modified, 1 untracked',
    })
  })

  it('keeps deleted descendants visible in directory summaries', () => {
    const decorations = buildTreeGitDecorations(localPath('/repo'), [
      changed('/repo/removed/deleted.ts', { unstaged: true }),
    ])

    expect(decorations.directories.get(key('/repo/removed'))).toEqual({
      tone: 'modified',
      changedCount: 1,
      label: '1 changed file: 1 modified',
    })
  })

  it('describes staged combinations and excludes paths outside the project root', () => {
    const decorations = buildTreeGitDecorations(localPath('/repo'), [
      changed('/repo/both.ts', { staged: true, unstaged: true }),
      changed('/repo/staged.ts', { staged: true }),
      changed('/other/outside.ts', { unstaged: true }),
    ])

    expect(decorations.files.get(key('/repo/both.ts'))?.marker).toBe('±')
    expect(decorations.files.get(key('/repo/staged.ts'))?.marker).toBe('S')
    expect(decorations.files.has(key('/other/outside.ts'))).toBe(false)
    expect(decorations.directories.get(key('/repo'))?.changedCount).toBe(2)
  })
})

function changed(
  path: string,
  state: Partial<Omit<GitChangedFile, 'path'>>,
): GitChangedFile {
  return {
    path: localPath(path),
    staged: false,
    unstaged: false,
    untracked: false,
    conflicted: false,
    ...state,
  }
}

function key(path: string): string {
  return treeGitPathKey(localPath(path))
}
