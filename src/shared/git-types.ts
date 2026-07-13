import type { HostPath } from './host-path'

export interface GitChangedFile {
  readonly path: HostPath
  readonly staged: boolean
  readonly unstaged: boolean
  readonly untracked: boolean
  readonly conflicted: boolean
  /** Omitted when Git reports a binary/otherwise uncountable change. */
  readonly additions?: number
  readonly deletions?: number
}

export interface GitChanges {
  /** Distinguishes an empty repository/view from a clean working tree. */
  readonly repositoryState: GitRepositoryState
  readonly workingTree: readonly GitChangedFile[]
  readonly branchPoint: readonly GitChangedFile[]
  /** False when no meaningful merge base can be established. */
  readonly branchPointAvailable: boolean
  readonly branchPointUnavailableReason?: string
}

export type GitRepositoryState = 'ready' | 'unborn' | 'not-git'

export interface GitCommitSummary {
  readonly hash: string
  readonly shortHash: string
  /** Direct parents, ordered as recorded by the commit object. */
  readonly parents: readonly string[]
  /** Branches, remote branches, tags, and HEAD decorations pointing here. */
  readonly refs: readonly string[]
  readonly author: string
  readonly authoredAt: string
  readonly subject: string
}

export interface GitHistoryRequest {
  readonly root: HostPath
  readonly limit: number
  /** Opaque continuation frontier returned by the preceding page. */
  readonly cursor?: string
  readonly path?: HostPath
  /** Start at every ref rather than only HEAD, for the repository graph. */
  readonly allRefs?: boolean
}

export interface GitHistoryPage {
  readonly repositoryState: GitRepositoryState
  readonly commits: readonly GitCommitSummary[]
  readonly hasMore: boolean
  readonly nextCursor?: string
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

/** Consecutive lines sharing commit metadata, compact across IPC and state. */
export interface GitBlameRun {
  readonly startLine: number
  readonly lineCount: number
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

export interface GitIgnoredEntriesRequest {
  readonly root: HostPath
  readonly directory: HostPath
  /** Immediate directory-entry names, never paths. */
  readonly names: readonly string[]
}

export interface GitIgnoredEntriesResponse {
  readonly ignoredNames: readonly string[]
}
