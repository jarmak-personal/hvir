import type {
  GitBranchModel,
  GitChanges,
  GitCommitSummary,
  GitHistoryPage,
  GitRepositoryState,
  HostConnectionState,
} from '../../../shared'
import {
  gitBaseDriftSummary,
  gitPullBlockReason,
  gitUpstreamSummary,
} from './git-sync-status'

export type GitRailView = 'changes' | 'history'
export type GitSyncOperation = 'fetch' | 'pull'

export interface GitRailModel {
  readonly generation: number
  readonly view: GitRailView
  readonly changes?: GitChanges
  readonly changesError?: string
  readonly changesLoading: boolean
  readonly commits: readonly GitCommitSummary[]
  readonly hasMore: boolean
  readonly historyCursor?: string
  readonly historyError?: string
  readonly historyInitialLoading: boolean
  readonly historyRepositoryState?: GitRepositoryState
  readonly historyRequestId: number
  readonly branchModel?: GitBranchModel
  readonly branchError?: string
  readonly branchSwitching: boolean
  readonly branchRequestId: number
  readonly branchRefreshVersion: number
  readonly syncBusy?: GitSyncOperation
  readonly syncError?: string
  readonly syncRequestId: number
  readonly lastFetchedAt?: number
  readonly autoFetchBlocked: boolean
}

export const initialGitRailModel: GitRailModel = {
  generation: 0,
  view: 'changes',
  changesLoading: false,
  commits: [],
  hasMore: false,
  historyInitialLoading: false,
  historyRequestId: 0,
  branchSwitching: false,
  branchRequestId: 0,
  branchRefreshVersion: 0,
  syncRequestId: 0,
  autoFetchBlocked: false,
}

export type GitRailAction =
  | { readonly type: 'context-reset'; readonly generation: number }
  | { readonly type: 'view-selected'; readonly view: GitRailView }
  | { readonly type: 'changes-requested'; readonly generation: number }
  | {
      readonly type: 'changes-loaded'
      readonly generation: number
      readonly changes: GitChanges
    }
  | {
      readonly type: 'changes-failed'
      readonly generation: number
      readonly error: string
    }
  | {
      readonly type: 'branch-requested'
      readonly generation: number
      readonly requestId: number
    }
  | {
      readonly type: 'branch-loaded'
      readonly generation: number
      readonly requestId: number
      readonly model: GitBranchModel
    }
  | {
      readonly type: 'branch-failed'
      readonly generation: number
      readonly requestId: number
      readonly error: string
    }
  | { readonly type: 'branch-switch-requested'; readonly generation: number }
  | { readonly type: 'branch-switch-succeeded'; readonly generation: number }
  | {
      readonly type: 'branch-switch-failed'
      readonly generation: number
      readonly error: string
    }
  | {
      readonly type: 'sync-requested'
      readonly generation: number
      readonly requestId: number
      readonly operation: GitSyncOperation
    }
  | {
      readonly type: 'sync-succeeded'
      readonly generation: number
      readonly requestId: number
      readonly operation: GitSyncOperation
      readonly fetchedAt: number
    }
  | {
      readonly type: 'sync-failed'
      readonly generation: number
      readonly requestId: number
      readonly operation: GitSyncOperation
      readonly error: string
    }
  | { readonly type: 'sync-retry-enabled'; readonly generation: number }
  | {
      readonly type: 'history-requested'
      readonly generation: number
      readonly requestId: number
      readonly append: boolean
    }
  | {
      readonly type: 'history-loaded'
      readonly generation: number
      readonly requestId: number
      readonly append: boolean
      readonly page: GitHistoryPage
    }
  | {
      readonly type: 'history-failed'
      readonly generation: number
      readonly requestId: number
      readonly append: boolean
      readonly error: string
    }

export function gitRailReducer(model: GitRailModel, action: GitRailAction): GitRailModel {
  if (action.type === 'context-reset') {
    return {
      ...initialGitRailModel,
      generation: action.generation,
      view: model.view,
    }
  }
  if (action.type === 'view-selected') return { ...model, view: action.view }
  if (action.generation !== model.generation) return model

  switch (action.type) {
    case 'changes-requested':
      return { ...model, changesLoading: !model.changes, changesError: undefined }
    case 'changes-loaded':
      return {
        ...model,
        changes: action.changes,
        changesLoading: false,
        changesError: undefined,
      }
    case 'changes-failed':
      return { ...model, changesLoading: false, changesError: action.error }
    case 'branch-requested':
      return {
        ...model,
        branchModel: undefined,
        branchError: undefined,
        branchRequestId: action.requestId,
      }
    case 'branch-loaded':
      if (action.requestId !== model.branchRequestId) return model
      return { ...model, branchModel: action.model, branchError: undefined }
    case 'branch-failed':
      if (action.requestId !== model.branchRequestId) return model
      return { ...model, branchError: action.error }
    case 'branch-switch-requested':
      return { ...model, branchSwitching: true, branchError: undefined }
    case 'branch-switch-succeeded':
      return {
        ...model,
        branchSwitching: false,
        branchRefreshVersion: model.branchRefreshVersion + 1,
      }
    case 'branch-switch-failed':
      return { ...model, branchSwitching: false, branchError: action.error }
    case 'sync-requested':
      return {
        ...model,
        syncBusy: action.operation,
        syncError: undefined,
        syncRequestId: action.requestId,
      }
    case 'sync-succeeded':
      if (action.requestId !== model.syncRequestId) return model
      return {
        ...model,
        syncBusy: undefined,
        syncError: undefined,
        lastFetchedAt: action.fetchedAt,
        autoFetchBlocked:
          action.operation === 'fetch' ? false : model.autoFetchBlocked,
        branchRefreshVersion: model.branchRefreshVersion + 1,
      }
    case 'sync-failed':
      if (action.requestId !== model.syncRequestId) return model
      return {
        ...model,
        syncBusy: undefined,
        syncError: action.error,
        autoFetchBlocked: action.operation === 'fetch' || model.autoFetchBlocked,
      }
    case 'sync-retry-enabled':
      return { ...model, autoFetchBlocked: false }
    case 'history-requested':
      return {
        ...model,
        commits: action.append ? model.commits : [],
        hasMore: action.append ? model.hasMore : false,
        historyCursor: action.append ? model.historyCursor : undefined,
        historyRepositoryState: action.append
          ? model.historyRepositoryState
          : undefined,
        historyInitialLoading: !action.append,
        historyError: undefined,
        historyRequestId: action.requestId,
      }
    case 'history-loaded': {
      if (action.requestId !== model.historyRequestId) return model
      const commits = action.append
        ? appendUniqueCommits(model.commits, action.page.commits)
        : action.page.commits
      return {
        ...model,
        commits,
        hasMore: action.page.hasMore,
        historyCursor: action.page.nextCursor,
        historyRepositoryState: action.page.repositoryState,
        historyInitialLoading: false,
        historyError: undefined,
      }
    }
    case 'history-failed':
      if (action.requestId !== model.historyRequestId) return model
      return {
        ...model,
        hasMore: action.append ? model.hasMore : false,
        historyCursor: action.append ? model.historyCursor : undefined,
        historyInitialLoading: false,
        historyError: action.error,
      }
  }
}

export interface GitChangeGroupModel {
  readonly key: 'working-tree' | 'branch-point'
  readonly title: string
  readonly files: GitChanges['workingTree']
  readonly base: 'head' | 'branch-point'
  readonly collapsible: boolean
}

export function gitChangeGroups(changes: GitChanges): readonly GitChangeGroupModel[] {
  const workingTree: GitChangeGroupModel = {
    key: 'working-tree',
    title: 'Working tree',
    files: changes.workingTree,
    base: 'head',
    collapsible: false,
  }
  if (
    changes.workingTreeLimited ||
    !changes.branchPointAvailable ||
    changes.branchPoint.length === 0
  ) {
    return [workingTree]
  }
  return [
    workingTree,
    {
      key: 'branch-point',
      title: 'Branch point',
      files: changes.branchPoint,
      base: 'branch-point',
      collapsible: true,
    },
  ]
}

export function gitChangeCountLabel(changes: GitChanges | undefined): string | undefined {
  if (!changes) return undefined
  return changes.workingTreeLimited
    ? `${(changes.workingTreeLimit ?? changes.workingTree.length).toLocaleString()}+`
    : changes.workingTree.length.toLocaleString()
}

export function gitRailSyncState({
  model,
  connectionState,
  hasDirtyViewerTabs,
}: {
  readonly model: GitRailModel
  readonly connectionState: HostConnectionState
  readonly hasDirtyViewerTabs: boolean
}) {
  const branchBlockReason =
    connectionState !== 'connected'
      ? 'Reconnect before switching branches'
      : hasDirtyViewerTabs
        ? 'Save or close unsaved viewer tabs before switching'
        : !model.changes
          ? 'Checking working tree…'
          : model.changes.workingTree.length > 0
            ? 'Commit or stash working tree changes before switching'
            : undefined
  const fetchBlockedReason =
    connectionState !== 'connected'
      ? 'Reconnect before fetching'
      : !model.branchModel
        ? 'Checking repository…'
        : !model.branchModel.remoteAvailable
          ? 'No Git remote is configured'
          : undefined
  return {
    branchBlockReason,
    hasAlternativeBranch: model.branchModel?.branches.some((branch) => !branch.current),
    pullBlockReason: gitPullBlockReason({
      model: model.branchModel,
      changes: model.changes,
      connectionState,
      hasDirtyViewerTabs,
    }),
    fetchBlockedReason,
    upstreamSummary: gitUpstreamSummary(model.branchModel),
    baseDrift: gitBaseDriftSummary(model.branchModel),
  }
}

export function gitAutoFetchDelay({
  hidden,
  connectionState,
  intervalMs,
  remoteAvailable,
  blocked,
  syncBusy,
  lastFetchedAt,
  now,
}: {
  readonly hidden: boolean
  readonly connectionState: HostConnectionState
  readonly intervalMs: number
  readonly remoteAvailable: boolean
  readonly blocked: boolean
  readonly syncBusy: boolean
  readonly lastFetchedAt?: number
  readonly now: number
}): number | undefined {
  if (
    hidden ||
    connectionState !== 'connected' ||
    intervalMs === 0 ||
    !remoteAvailable ||
    blocked ||
    syncBusy
  ) {
    return undefined
  }
  const elapsed = lastFetchedAt ? now - lastFetchedAt : intervalMs
  return Math.max(0, intervalMs - elapsed)
}

function appendUniqueCommits(
  current: readonly GitCommitSummary[],
  incoming: readonly GitCommitSummary[],
): readonly GitCommitSummary[] {
  const seen = new Set(current.map((commit) => commit.hash))
  return [...current, ...incoming.filter((commit) => !seen.has(commit.hash))]
}
