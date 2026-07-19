import type {
  DiffBase,
  GitBlameRun,
  GitBranchModel,
  GitChanges,
  GitCommitDetail,
  GitDiffResponse,
  GitHistoryPage,
  HostPath,
  WorktreeDiscovery,
} from '../../shared'
import { GitBranchCapability } from './git-branches'
import { GitCommandContext, type GitHostPort } from './git-command-context'
import { GitDetailCapability } from './git-detail'
import { GitDiffCapability } from './git-diff'
import { GitHistoryCapability } from './git-history'
import { GitStatusCapability } from './git-status'
import { GitWorktreeCapability } from './git-worktrees'

export { GIT_FETCH_ARGS, GIT_PULL_ARGS } from './git-branches'
export { parseLocalBranches, parseWorktreeList } from './git-parsers'

/** Stable worker-facing façade over cohesive, host-local Git capabilities. */
export class GitEngine {
  private readonly worktreeCapability: GitWorktreeCapability
  private readonly statusCapability: GitStatusCapability
  private readonly branchCapability: GitBranchCapability
  private readonly diffCapability: GitDiffCapability
  private readonly historyCapability: GitHistoryCapability
  private readonly detailCapability: GitDetailCapability

  constructor(host: GitHostPort, projectRoot?: HostPath) {
    const context = new GitCommandContext(host, projectRoot)
    this.worktreeCapability = new GitWorktreeCapability(context)
    this.statusCapability = new GitStatusCapability(context)
    this.branchCapability = new GitBranchCapability(
      context,
      this.worktreeCapability,
      this.statusCapability,
    )
    this.diffCapability = new GitDiffCapability(context)
    this.historyCapability = new GitHistoryCapability(context)
    this.detailCapability = new GitDetailCapability(context)
  }

  worktrees(projectRoot: HostPath): Promise<WorktreeDiscovery> {
    return this.worktreeCapability.discover(projectRoot)
  }

  pruneWorktrees(projectRoot: HostPath): Promise<WorktreeDiscovery> {
    return this.worktreeCapability.prune(projectRoot)
  }

  changedFileCount(
    workspaceRoot: HostPath,
    relatedWorktreeRoots: readonly HostPath[] = [],
  ): Promise<number> {
    return this.statusCapability.changedFileCount(workspaceRoot, relatedWorktreeRoots)
  }

  branches(workspaceRoot: HostPath): Promise<GitBranchModel> {
    return this.branchCapability.branches(workspaceRoot)
  }

  fetch(workspaceRoot: HostPath): Promise<void> {
    return this.branchCapability.fetch(workspaceRoot)
  }

  pullFastForward(
    workspaceRoot: HostPath,
    relatedWorktreeRoots: readonly HostPath[] = [],
  ): Promise<void> {
    return this.branchCapability.pullFastForward(workspaceRoot, relatedWorktreeRoots)
  }

  switchBranch(
    workspaceRoot: HostPath,
    branch: string,
    relatedWorktreeRoots: readonly HostPath[] = [],
  ): Promise<void> {
    return this.branchCapability.switchBranch(workspaceRoot, branch, relatedWorktreeRoots)
  }

  diffInputs(
    path: HostPath,
    base: DiffBase,
    revision?: string,
  ): Promise<GitDiffResponse> {
    return this.diffCapability.inputs(path, base, revision)
  }

  repoRoot(path: HostPath): Promise<HostPath> {
    return this.diffCapability.repoRoot(path)
  }

  changes(
    projectRoot: HostPath,
    relatedWorktreeRoots: readonly HostPath[] = [],
  ): Promise<GitChanges> {
    return this.statusCapability.changes(projectRoot, relatedWorktreeRoots)
  }

  ignoredEntries(
    projectRoot: HostPath,
    directory: HostPath,
    names: readonly string[],
  ): Promise<{ readonly ignoredNames: readonly string[] }> {
    return this.statusCapability.ignoredEntries(projectRoot, directory, names)
  }

  history(
    projectRoot: HostPath,
    limit: number,
    cursor?: string,
    path?: HostPath,
    allRefs = false,
  ): Promise<GitHistoryPage> {
    return this.historyCapability.history(projectRoot, limit, cursor, path, allRefs)
  }

  blame(path: HostPath): Promise<readonly GitBlameRun[]> {
    return this.detailCapability.blame(path)
  }

  commitDetail(projectRoot: HostPath, hash: string): Promise<GitCommitDetail> {
    return this.detailCapability.commitDetail(projectRoot, hash)
  }
}
