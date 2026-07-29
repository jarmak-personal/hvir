import { describe, expect, it } from 'vitest'

import { rankFilenameMatches } from '../src/main/filename-search/filename-search-policy'
import { localPath } from '../src/shared'

describe('filename search policy', () => {
  it('matches literal basenames without case and ranks exact, prefix, then substring', () => {
    const ranked = rankFilenameMatches(
      [
        file('src/my-README.md'),
        file('docs/readme-guide.md'),
        file('README.md'),
        file('src/other.ts'),
      ],
      'readme.md',
    )

    expect(ranked.results.map((result) => result.path.path)).toEqual([
      '/workspace/README.md',
      '/workspace/src/my-README.md',
    ])
  })

  it('uses filename and relative parent path as deterministic tie breakers', () => {
    const ranked = rankFilenameMatches(
      [file('z/readme.md'), file('a/README.md'), file('b/readme.md-notes')],
      'readme.md',
    )

    expect(ranked.results.map((result) => result.parentPath)).toEqual(['a', 'z', 'b'])
  })

  it('treats punctuation literally and bounds returned matches', () => {
    const ranked = rankFilenameMatches(
      [file('a/file[1].ts'), file('b/file1.ts'), file('c/file[2].ts')],
      '[',
      1,
    )

    expect(ranked.results.map((result) => result.name)).toEqual(['file[1].ts'])
    expect(ranked.truncated).toBe(true)
  })
})

function file(relativePath: string) {
  const slash = relativePath.lastIndexOf('/')
  return {
    path: localPath(`/workspace/${relativePath}`),
    name: relativePath.slice(slash + 1),
    parentPath: slash < 0 ? '.' : relativePath.slice(0, slash),
  }
}
