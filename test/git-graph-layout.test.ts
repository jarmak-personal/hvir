import { describe, expect, it } from 'vitest'

import { buildGitGraphLayout } from '../src/renderer/src/git/git-graph-layout'
import type { GitCommitSummary } from '../src/shared'

describe('Git graph layout', () => {
  it('keeps a linear history in one lane', () => {
    const layout = buildGitGraphLayout([
      commit('c', ['b']),
      commit('b', ['a']),
      commit('a', []),
    ])

    expect(layout.laneCount).toBe(1)
    expect(layout.rows.map((row) => row.lane)).toEqual([0, 0, 0])
  })

  it('allocates and rejoins merge lanes without losing passthrough branches', () => {
    const layout = buildGitGraphLayout([
      commit('merge', ['main', 'side']),
      commit('main', ['base']),
      commit('side', ['base']),
      commit('base', []),
    ])

    expect(layout.laneCount).toBe(2)
    expect(layout.rows.map((row) => row.lane)).toEqual([0, 0, 1, 0])
    expect(layout.rows[1]?.passthrough).toEqual([expect.objectContaining({ lane: 1 })])
    expect(layout.rows[2]?.segments.filter((segment) => !segment.incoming)).toEqual(
      expect.arrayContaining([expect.objectContaining({ fromLane: 1, toLane: 0 })]),
    )
  })

  it('retains commit metadata for refs and selection', () => {
    const layout = buildGitGraphLayout([commit('head', [], ['HEAD -> main', 'tag: v1'])])

    expect(layout.rows[0]?.commit.refs).toEqual(['HEAD -> main', 'tag: v1'])
  })
})

function commit(
  hash: string,
  parents: readonly string[],
  refs: readonly string[] = [],
): GitCommitSummary {
  return {
    hash,
    shortHash: hash,
    parents,
    refs,
    author: 'hvir',
    authoredAt: '2026-07-13T00:00:00Z',
    subject: hash,
  }
}
