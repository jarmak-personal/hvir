import { describe, expect, it } from 'vitest'

import {
  gitAutoFetchDelay,
  gitChangeCountLabel,
  gitChangeGroups,
  gitRailReducer,
  gitRailSyncState,
  initialGitRailModel,
  type GitRailAction,
  type GitRailModel,
} from '../src/renderer/src/git/git-rail-model'
import {
  localPath,
  type GitBranchModel,
  type GitChangedFile,
  type GitChanges,
  type GitCommitSummary,
} from '../src/shared'

describe('Git rail model', () => {
  it('rejects stale and out-of-order refreshes across workspace generations', () => {
    let model = reduce(initialGitRailModel, { type: 'context-reset', generation: 1 })
    model = reduce(model, { type: 'branch-requested', generation: 1, requestId: 2 })
    model = reduce(model, { type: 'branch-requested', generation: 1, requestId: 3 })

    const outOfOrder = reduce(model, {
      type: 'branch-loaded',
      generation: 1,
      requestId: 2,
      model: branchModel('stale'),
    })
    expect(outOfOrder).toBe(model)

    model = reduce(model, { type: 'context-reset', generation: 2 })
    const staleChanges = reduce(model, {
      type: 'changes-loaded',
      generation: 1,
      changes: changes([file('/stale')]),
    })
    const staleFailure = reduce(model, {
      type: 'history-failed',
      generation: 1,
      requestId: 3,
      append: false,
      error: 'old workspace failed',
    })
    expect(staleChanges).toBe(model)
    expect(staleFailure).toBe(model)
    expect(model.changes).toBeUndefined()
    expect(model.syncBusy).toBeUndefined()
  })

  it('retains settled branch state during a current-context refresh', () => {
    let model = reduce(initialGitRailModel, { type: 'context-reset', generation: 3 })
    model = reduce(model, { type: 'branch-requested', generation: 3, requestId: 1 })
    model = reduce(model, {
      type: 'branch-loaded',
      generation: 3,
      requestId: 1,
      model: branchModel('feature'),
    })

    const refreshing = reduce(model, {
      type: 'branch-requested',
      generation: 3,
      requestId: 2,
    })
    expect(refreshing.branchModel).toBe(model.branchModel)
    expect(refreshing.branchError).toBeUndefined()

    const nextContext = reduce(refreshing, {
      type: 'context-reset',
      generation: 4,
    })
    expect(nextContext.branchModel).toBeUndefined()
  })

  it('deduplicates paged history and ignores an older page completion', () => {
    let model = reduce(initialGitRailModel, { type: 'context-reset', generation: 4 })
    model = reduce(model, {
      type: 'history-requested',
      generation: 4,
      requestId: 1,
      append: false,
    })
    model = reduce(model, {
      type: 'history-loaded',
      generation: 4,
      requestId: 1,
      append: false,
      page: page([commit('a'), commit('b')], 'next'),
    })
    model = reduce(model, {
      type: 'history-requested',
      generation: 4,
      requestId: 2,
      append: true,
    })
    const stale = reduce(model, {
      type: 'history-loaded',
      generation: 4,
      requestId: 1,
      append: true,
      page: page([commit('stale')]),
    })
    expect(stale).toBe(model)

    model = reduce(model, {
      type: 'history-loaded',
      generation: 4,
      requestId: 2,
      append: true,
      page: page([commit('b'), commit('c')]),
    })
    expect(model.commits.map(({ hash }) => hash)).toEqual(['a', 'b', 'c'])
  })

  it('retains settled history during refresh and refresh failure', () => {
    let model = reduce(initialGitRailModel, { type: 'context-reset', generation: 4 })
    model = reduce(model, {
      type: 'history-requested',
      generation: 4,
      requestId: 1,
      append: false,
    })
    model = reduce(model, {
      type: 'history-loaded',
      generation: 4,
      requestId: 1,
      append: false,
      page: page([commit('settled')], 'next'),
    })

    model = reduce(model, {
      type: 'history-requested',
      generation: 4,
      requestId: 2,
      append: false,
    })
    expect(model.commits.map(({ hash }) => hash)).toEqual(['settled'])
    expect(model.historyCursor).toBe('next')
    expect(model.historyInitialLoading).toBe(false)

    model = reduce(model, {
      type: 'history-failed',
      generation: 4,
      requestId: 2,
      append: false,
      error: 'refresh failed',
    })
    expect(model.commits.map(({ hash }) => hash)).toEqual(['settled'])
    expect(model.historyCursor).toBe('next')
    expect(model.historyError).toBe('refresh failed')

    model = reduce(model, { type: 'context-reset', generation: 5 })
    expect(model.commits).toEqual([])
    expect(model.historyCursor).toBeUndefined()
  })

  it('makes mutation failure retryable while blocking failed automatic fetches', () => {
    let model = reduce(initialGitRailModel, { type: 'context-reset', generation: 5 })
    model = reduce(model, {
      type: 'sync-requested',
      generation: 5,
      requestId: 1,
      operation: 'fetch',
    })
    model = reduce(model, {
      type: 'sync-failed',
      generation: 5,
      requestId: 1,
      operation: 'fetch',
      error: 'Git fetch denied by mutation authority',
    })
    expect(model.syncBusy).toBeUndefined()
    expect(model.syncError).toContain('denied')
    expect(model.autoFetchBlocked).toBe(true)

    model = reduce(model, { type: 'sync-retry-enabled', generation: 5 })
    model = reduce(model, {
      type: 'sync-requested',
      generation: 5,
      requestId: 2,
      operation: 'fetch',
    })
    model = reduce(model, {
      type: 'sync-succeeded',
      generation: 5,
      requestId: 2,
      operation: 'fetch',
      fetchedAt: 100,
    })
    expect(model.syncError).toBeUndefined()
    expect(model.autoFetchBlocked).toBe(false)
    expect(model.lastFetchedAt).toBe(100)
    expect(model.branchRefreshVersion).toBe(1)
  })

  it('derives grouping, badges, sync controls, and auto-fetch timing', () => {
    const working = file('/repo/working.ts')
    const branch = file('/repo/branch.ts')
    const value = changes([working], [branch])
    expect(gitChangeGroups(value).map(({ key }) => key)).toEqual([
      'working-tree',
      'branch-point',
    ])
    expect(gitChangeCountLabel({ ...value, workingTreeLimited: true })).toBe('1+')

    const model: GitRailModel = {
      ...initialGitRailModel,
      changes: changes([working]),
      branchModel: branchModel('feature', 0, 2),
    }
    const sync = gitRailSyncState({
      model,
      connectionState: 'connected',
      hasDirtyViewerTabs: false,
    })
    expect(sync.upstreamSummary).toContain('↓2 incoming')
    expect(sync.branchBlockReason).toBeUndefined()
    expect(sync.pullBlockReason).toBeUndefined()
    const unsaved = gitRailSyncState({
      model,
      connectionState: 'connected',
      hasDirtyViewerTabs: true,
    })
    expect(unsaved.branchBlockReason).toContain('unsaved viewer tabs')
    expect(unsaved.pullBlockReason).toContain('unsaved viewer tabs')
    expect(
      gitAutoFetchDelay({
        hidden: false,
        connectionState: 'connected',
        intervalMs: 60_000,
        remoteAvailable: true,
        blocked: false,
        syncBusy: false,
        lastFetchedAt: 10_000,
        now: 25_000,
      }),
    ).toBe(45_000)
  })
})

function reduce(model: GitRailModel, action: GitRailAction): GitRailModel {
  return gitRailReducer(model, action)
}

function file(path: string): GitChangedFile {
  return {
    path: localPath(path),
    staged: false,
    unstaged: true,
    untracked: false,
    conflicted: false,
    additions: 1,
    deletions: 0,
  }
}

function changes(
  workingTree: readonly GitChangedFile[] = [],
  branchPoint: readonly GitChangedFile[] = [],
): GitChanges {
  return {
    repositoryState: 'ready',
    workingTree,
    branchPoint,
    branchPointAvailable: true,
  }
}

function branchModel(current: string, ahead = 0, behind = 0): GitBranchModel {
  return {
    repositoryState: 'ready',
    current,
    head: '0123456789012345678901234567890123456789',
    detached: false,
    remoteAvailable: true,
    sync: { upstream: { name: `origin/${current}`, ahead, behind } },
    branches: [
      { name: current, current: true },
      { name: 'main', current: false },
    ],
  }
}

function commit(hash: string): GitCommitSummary {
  return {
    hash,
    shortHash: hash,
    parents: [],
    refs: [],
    author: 'Agent',
    authoredAt: '2026-07-18T00:00:00Z',
    subject: hash,
  }
}

function page(commits: readonly GitCommitSummary[], nextCursor?: string) {
  return {
    repositoryState: 'ready' as const,
    commits,
    hasMore: Boolean(nextCursor),
    nextCursor,
  }
}
