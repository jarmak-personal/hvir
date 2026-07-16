import { describe, expect, it } from 'vitest'

import {
  gitBaseDriftSummary,
  gitPullBlockReason,
  gitUpstreamSummary,
} from '../src/renderer/src/git/git-sync-status'
import type { GitBranchModel, GitChanges } from '../src/shared'

const cleanChanges: GitChanges = {
  repositoryState: 'ready',
  workingTree: [],
  branchPoint: [],
  branchPointAvailable: true,
}

function model(ahead: number, behind: number): GitBranchModel {
  return {
    repositoryState: 'ready',
    current: 'feature',
    head: '0123456789012345678901234567890123456789',
    detached: false,
    remoteAvailable: true,
    sync: {
      upstream: { name: 'origin/feature', ahead, behind },
      base: { name: 'main', ahead: 2, behind: 3 },
    },
    branches: [{ name: 'feature', current: true }],
  }
}

describe('Git sync status', () => {
  it('summarizes incoming, outgoing, diverged, and base drift states', () => {
    expect(gitUpstreamSummary(model(0, 2))).toBe('origin/feature · ↓2 incoming')
    expect(gitUpstreamSummary(model(4, 0))).toBe('origin/feature · ↑4 outgoing')
    expect(gitUpstreamSummary(model(1, 2))).toContain('needs agent')
    expect(gitBaseDriftSummary(model(0, 2))).toBe(
      'main has 3 newer commits · ask agent to update',
    )
  })

  it('offers pull only for a clean behind-only branch', () => {
    expect(
      gitPullBlockReason({
        model: model(0, 2),
        changes: cleanChanges,
        connectionState: 'connected',
        hasDirtyViewerTabs: false,
      }),
    ).toBeUndefined()
    expect(
      gitPullBlockReason({
        model: model(1, 2),
        changes: cleanChanges,
        connectionState: 'connected',
        hasDirtyViewerTabs: false,
      }),
    ).toContain('agent')
    expect(
      gitPullBlockReason({
        model: model(0, 2),
        changes: { ...cleanChanges, workingTree: [{} as never] },
        connectionState: 'connected',
        hasDirtyViewerTabs: false,
      }),
    ).toContain('agent')
  })

  it('explains missing upstream and detached states', () => {
    const noUpstream = { ...model(0, 0), sync: { base: model(0, 0).sync?.base } }
    expect(gitUpstreamSummary(noUpstream)).toBe('No upstream configured')
    expect(
      gitPullBlockReason({
        model: noUpstream,
        changes: cleanChanges,
        connectionState: 'connected',
        hasDirtyViewerTabs: false,
      }),
    ).toContain('upstream')
    expect(
      gitUpstreamSummary({
        ...model(0, 0),
        current: undefined,
        detached: true,
      }),
    ).toBe('Detached HEAD')
  })
})
