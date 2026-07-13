import { describe, expect, it } from 'vitest'

import {
  directoryEntriesEqual,
  isGitIgnoreRulePath,
} from '../src/renderer/src/tree/git-ignore-refresh'

describe('Git ignore decoration refreshes', () => {
  it('reuses an unchanged sorted directory listing', () => {
    expect(
      directoryEntriesEqual(
        [
          { name: 'src', type: 'dir' },
          { name: 'README.md', type: 'file' },
        ],
        [
          { name: 'src', type: 'dir' },
          { name: 'README.md', type: 'file' },
        ],
      ),
    ).toBe(true)
    expect(
      directoryEntriesEqual(
        [{ name: 'src', type: 'dir' }],
        [{ name: 'src', type: 'file' }],
      ),
    ).toBe(false)
  })

  it('separates ignore-rule edits from ordinary file watch events', () => {
    expect(isGitIgnoreRulePath('/project/.gitignore')).toBe(true)
    expect(isGitIgnoreRulePath('/project/docs/.gitignore')).toBe(true)
    expect(isGitIgnoreRulePath('/project/.git/info/exclude')).toBe(true)
    expect(isGitIgnoreRulePath('/project/src/App.tsx')).toBe(false)
  })
})
