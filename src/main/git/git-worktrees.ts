import type { HostPath, WorktreeDiscovery } from '../../shared'
import { gitError, type GitCommandContext } from './git-command-context'
import { parseLegacyWorktreeList, parseWorktreeList } from './git-parsers'

export class GitWorktreeCapability {
  constructor(private readonly context: GitCommandContext) {}

  async discover(projectRoot: HostPath): Promise<WorktreeDiscovery> {
    this.context.assertHost(projectRoot)
    const args = ['worktree', 'list', '--porcelain', '-z'] as const
    const result = await this.context.readOnly(projectRoot, args)
    if (result.code !== 0) {
      if (result.code === 129 || result.code === null) {
        const legacyArgs = ['worktree', 'list', '--porcelain'] as const
        const legacy = await this.context.readOnly(projectRoot, legacyArgs)
        if (legacy.code !== 0) {
          throw gitError(legacyArgs, legacy.stderr, legacy.code)
        }
        const worktrees = parseLegacyWorktreeList(legacy.stdout, projectRoot.hostId)
        if (worktrees.length === 0) throw new Error('git reported no worktrees')
        return { repository: true, worktrees }
      }
      if (await this.context.project(projectRoot)) {
        throw gitError(args, result.stderr, result.code)
      }
      return {
        repository: false,
        worktrees: [{ root: projectRoot, detached: false, bare: false }],
      }
    }
    const worktrees = parseWorktreeList(result.stdout, projectRoot.hostId)
    if (worktrees.length === 0) throw new Error('git reported no worktrees')
    return { repository: true, worktrees }
  }

  async prune(projectRoot: HostPath): Promise<WorktreeDiscovery> {
    this.context.assertHost(projectRoot)
    const args = ['worktree', 'prune', '--expire', 'now', '--verbose'] as const
    const result = await this.context.mutate(projectRoot, args)
    if (result.code !== 0) throw gitError(args, result.stderr, result.code)
    return this.discover(projectRoot)
  }
}
