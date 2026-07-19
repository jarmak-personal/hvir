import {
  hostPathEquals,
  type GitBranchModel,
  type GitBranchSync,
  type HostPath,
} from '../../shared'
import { gitError, shortRef, type GitCommandContext } from './git-command-context'
import {
  assertBranchName,
  parseAheadBehind,
  parseBranchTracking,
  parseLocalBranches,
} from './git-parsers'
import type { GitStatusCapability } from './git-status'
import type { GitWorktreeCapability } from './git-worktrees'

export const GIT_FETCH_ARGS = ['fetch', '--prune', '--no-recurse-submodules'] as const
export const GIT_PULL_ARGS = [
  'pull',
  '--no-rebase',
  '--ff-only',
  '--no-recurse-submodules',
] as const

export class GitBranchCapability {
  constructor(
    private readonly context: GitCommandContext,
    private readonly worktrees: GitWorktreeCapability,
    private readonly status: GitStatusCapability,
  ) {}

  async branches(workspaceRoot: HostPath): Promise<GitBranchModel> {
    this.context.assertHost(workspaceRoot)
    const context = await this.context.project(workspaceRoot)
    if (!context) {
      return {
        repositoryState: 'not-git',
        detached: false,
        remoteAvailable: false,
        branches: [],
      }
    }
    const { commandRoot } = context
    const [headOutput, currentOutput, refsOutput, discovery, statusOutput, remoteOutput] =
      await Promise.all([
        this.context.tryRun(commandRoot, ['rev-parse', '--verify', 'HEAD']),
        this.context.tryRun(commandRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
        this.context.run(commandRoot, [
          'for-each-ref',
          '--format=%(refname:short)%00',
          'refs/heads',
        ]),
        this.worktrees.discover(workspaceRoot),
        this.context.run(commandRoot, [
          'status',
          '--porcelain=v2',
          '--branch',
          '-z',
          '--untracked-files=no',
        ]),
        this.context.run(commandRoot, ['remote']),
      ])
    const head = headOutput?.trim() || undefined
    const current = currentOutput?.trim() || undefined
    const sync =
      head && current ? await this.branchSync(commandRoot, statusOutput) : undefined
    const occupied = new Map(
      discovery.worktrees.flatMap((worktree) =>
        worktree.branch ? [[worktree.branch, worktree.root] as const] : [],
      ),
    )
    return {
      repositoryState: head ? 'ready' : 'unborn',
      current,
      head,
      detached: Boolean(head && !current),
      remoteAvailable: remoteOutput.trim().length > 0,
      ...(sync ? { sync } : {}),
      branches: parseLocalBranches(refsOutput).map((name) => ({
        name,
        current: name === current,
        ...(occupied.get(name) ? { worktree: occupied.get(name) } : {}),
      })),
    }
  }

  async fetch(workspaceRoot: HostPath): Promise<void> {
    this.context.assertHost(workspaceRoot)
    const context = await this.context.project(workspaceRoot)
    if (!context) throw new Error('Not a Git repository')
    const remotes = await this.context.run(context.commandRoot, ['remote'])
    if (!remotes.trim()) throw new Error('No Git remote is configured')
    const result = await this.context.mutate(context.commandRoot, GIT_FETCH_ARGS)
    if (result.code !== 0) throw gitError(GIT_FETCH_ARGS, result.stderr, result.code)
  }

  async pullFastForward(
    workspaceRoot: HostPath,
    relatedWorktreeRoots: readonly HostPath[] = [],
  ): Promise<void> {
    this.context.assertHost(workspaceRoot)
    const model = await this.branches(workspaceRoot)
    if (model.repositoryState === 'not-git') throw new Error('Not a Git repository')
    if (!model.current) throw new Error('A detached HEAD cannot be pulled')
    if (!model.remoteAvailable) throw new Error('No Git remote is configured')
    const upstream = model.sync?.upstream
    if (!upstream) throw new Error('The current branch has no upstream')
    if (upstream.gone) throw new Error('The configured upstream no longer exists')
    if (upstream.ahead > 0 && upstream.behind > 0) {
      throw new Error('The branch has diverged; ask an agent to integrate it')
    }
    if (upstream.behind === 0) throw new Error('The branch is already up to date')
    await this.status.assertClean(
      workspaceRoot,
      relatedWorktreeRoots,
      'Working tree changed; ask an agent to commit or stash it',
    )
    const context = await this.context.project(workspaceRoot)
    if (!context) throw new Error('Not a Git repository')
    const result = await this.context.mutate(context.commandRoot, GIT_PULL_ARGS)
    if (result.code !== 0) throw gitError(GIT_PULL_ARGS, result.stderr, result.code)
  }

  async switchBranch(
    workspaceRoot: HostPath,
    branch: string,
    relatedWorktreeRoots: readonly HostPath[] = [],
  ): Promise<void> {
    assertBranchName(branch)
    const model = await this.branches(workspaceRoot)
    if (model.repositoryState === 'not-git') throw new Error('Not a Git repository')
    const target = model.branches.find((candidate) => candidate.name === branch)
    if (!target) throw new Error('Branch no longer exists')
    if (target.current) throw new Error(`${branch} is already checked out`)
    if (target.worktree && !hostPathEquals(target.worktree, workspaceRoot)) {
      throw new Error(`${branch} is checked out in ${target.worktree.path}`)
    }
    await this.status.assertClean(
      workspaceRoot,
      relatedWorktreeRoots,
      'Working tree changed; commit or stash before switching',
    )
    const args = ['switch', '--no-guess', branch] as const
    const result = await this.context.mutate(workspaceRoot, args)
    if (result.code !== 0) throw gitError(args, result.stderr, result.code)
  }

  private async branchSync(root: HostPath, statusOutput: string): Promise<GitBranchSync> {
    const upstream = parseBranchTracking(statusOutput)
    let base: GitBranchSync['base']
    try {
      const defaultRef = await this.context.defaultBranch(root)
      const counts = await this.context.tryRun(root, [
        'rev-list',
        '--left-right',
        '--count',
        `HEAD...${defaultRef}`,
      ])
      const parsed = counts ? parseAheadBehind(counts) : undefined
      if (parsed) {
        base = {
          name: shortRef(defaultRef),
          ahead: parsed.ahead,
          behind: parsed.behind,
        }
      }
    } catch {
      // Configured-upstream status remains useful without a conventional base.
    }
    return {
      ...(upstream ? { upstream } : {}),
      ...(base ? { base } : {}),
    }
  }
}
