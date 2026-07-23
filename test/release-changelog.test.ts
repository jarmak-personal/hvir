import { describe, expect, it } from 'vitest'

import { sortClosedIssues } from '../scripts/release-changelog.mjs'

describe('release changelog', () => {
  it('retains issues with nullable close dates and sorts them deterministically', () => {
    const issues = [
      {
        closedAt: null,
        number: 9,
        title: 'Unknown later issue',
        url: 'https://github.com/example/repo/issues/9',
      },
      {
        closedAt: '2026-07-20T00:00:00Z',
        number: 8,
        title: 'Known issue',
        url: 'https://github.com/example/repo/issues/8',
      },
      {
        closedAt: null,
        number: 7,
        title: 'Unknown earlier issue',
        url: 'https://github.com/example/repo/issues/7',
      },
    ]

    expect(sortClosedIssues(issues)).toEqual([issues[1], issues[2], issues[0]])
    expect(issues.map((issue) => issue.number)).toEqual([9, 8, 7])
  })

  it('rejects redacted issue records before creating a release PR', () => {
    expect(() =>
      sortClosedIssues([{ closedAt: null, number: 0, title: '', url: '' }]),
    ).toThrow('verify the workflow has issues: read')
  })
})
