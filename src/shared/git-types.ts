import type { HostPath } from './host-path'

export interface GitChangedFile {
  readonly path: HostPath
  readonly staged: boolean
  readonly unstaged: boolean
  readonly untracked: boolean
  readonly conflicted: boolean
  readonly additions: number
  readonly deletions: number
}

export interface GitChanges {
  readonly workingTree: readonly GitChangedFile[]
  readonly branchPoint: readonly GitChangedFile[]
}

export interface GitCommitSummary {
  readonly hash: string
  readonly shortHash: string
  readonly author: string
  readonly authoredAt: string
  readonly subject: string
}

export interface GitHistoryRequest {
  readonly root: HostPath
  readonly skip: number
  readonly limit: number
  readonly path?: HostPath
}

export interface GitHistoryPage {
  readonly commits: readonly GitCommitSummary[]
  readonly hasMore: boolean
}

export interface GitCommitFile {
  readonly path: HostPath
  readonly additions: number
  readonly deletions: number
}

export interface GitCommitDetail extends GitCommitSummary {
  readonly message: string
  readonly files: readonly GitCommitFile[]
}

export interface GitCommitDetailRequest {
  readonly root: HostPath
  readonly hash: string
}

export interface GitBlameLine {
  readonly line: number
  readonly hash: string
  readonly author: string
  readonly summary: string
}

export interface GitBlameRequest {
  readonly path: HostPath
}
export interface GitChangesRequest {
  readonly root: HostPath
}
