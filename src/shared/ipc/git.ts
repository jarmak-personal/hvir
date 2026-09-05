import { invoke, type IpcFeatureContract } from '../ipc-contract'
import { type GitDiffRequest, type GitDiffResponse } from '../viewer-types'
import {
  type GitBlameRun,
  type GitBlameRequest,
  type GitChanges,
  type GitChangesRequest,
  type GitCommitDetail,
  type GitCommitDetailRequest,
  type GitHistoryPage,
  type GitHistoryRequest,
  type GitIgnoredEntriesRequest,
  type GitIgnoredEntriesResponse,
  type GitBranchModel,
  type GitFetchRequest,
  type GitPullRequest,
  type GitSwitchBranchRequest,
} from '../git-types'
import { type ProjectState } from '../workspace-types'
import { type OperationResult } from '../operation-result'

export const gitIpc = {
  invoke: {
    'git:diff-inputs': invoke<GitDiffRequest, GitDiffResponse>(),
    'git:changes': invoke<GitChangesRequest, GitChanges>(),
    'git:history': invoke<GitHistoryRequest, GitHistoryPage>(),
    'git:ignored-entries': invoke<GitIgnoredEntriesRequest, GitIgnoredEntriesResponse>(),
    'git:commit-detail': invoke<GitCommitDetailRequest, GitCommitDetail>(),
    'git:blame': invoke<GitBlameRequest, readonly GitBlameRun[]>(),
    'git:branches': invoke<GitChangesRequest, GitBranchModel>(),
    'git:fetch': invoke<GitFetchRequest, OperationResult<ProjectState>>(),
    'git:pull': invoke<GitPullRequest, OperationResult<ProjectState>>(),
    'git:switch-branch': invoke<GitSwitchBranchRequest, OperationResult<ProjectState>>(),
  },
  send: {},
  event: {},
} satisfies IpcFeatureContract
