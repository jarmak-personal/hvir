import { describe, expect, it } from 'vitest'

import { sortClosedIssues } from '../scripts/release-changelog.mjs'

describe('release changelog', () => {
  it('retains issues with nullable close dates and sorts them deterministically', () => {
    const issues = [
      { closedAt: null, number: 9, title: 'Unknown later issue' },
      { closedAt: '2026-07-20T00:00:00Z', number: 8, title: 'Known issue' },
      { closedAt: null, number: 7, title: 'Unknown earlier issue' },
    ]

    expect(sortClosedIssues(issues)).toEqual([issues[1], issues[2], issues[0]])
    expect(issues.map((issue) => issue.number)).toEqual([9, 8, 7])
  })
})
