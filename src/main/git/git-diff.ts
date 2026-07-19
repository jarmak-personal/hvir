import type { DiffBase, GitDiffResponse, HostPath } from '../../shared'
import { shortRef, type GitCommandContext } from './git-command-context'
import { assertRevision } from './git-parsers'

export class GitDiffCapability {
  constructor(private readonly context: GitCommandContext) {}

  async inputs(
    path: HostPath,
    base: DiffBase,
    revision?: string,
  ): Promise<GitDiffResponse> {
    this.context.assertHost(path)
    const { commandRoot, relativePath } = await this.context.repository(path)
    if (revision) {
      assertRevision(revision)
      return {
        path,
        base,
        revision,
        baseLabel: `${revision.slice(0, 8)}^`,
        currentLabel: revision.slice(0, 8),
        baseContent: await this.context.showOrEmpty(
          commandRoot,
          `${revision}^:${relativePath}`,
        ),
        currentContent: await this.context.showOrEmpty(
          commandRoot,
          `${revision}:${relativePath}`,
        ),
      }
    }
    const currentContent = await this.context.readWorkingTreeOrEmpty(
      path,
      commandRoot,
      relativePath,
    )
    if (base === 'working-tree') {
      return {
        path,
        base,
        baseLabel: 'Index',
        currentLabel: 'Working tree',
        baseContent: await this.context.showOrEmpty(commandRoot, `:${relativePath}`),
        currentContent,
      }
    }
    if (base === 'head') {
      return {
        path,
        base,
        baseLabel: 'HEAD',
        currentLabel: 'Working tree',
        baseContent: await this.context.showOrEmpty(commandRoot, `HEAD:${relativePath}`),
        currentContent,
      }
    }
    const defaultBranch = await this.context.defaultBranch(commandRoot)
    const mergeBase = await this.context.run(commandRoot, [
      'merge-base',
      'HEAD',
      defaultBranch,
    ])
    const commit = mergeBase.trim()
    if (!commit) throw new Error(`git merge-base returned no commit for ${defaultBranch}`)
    return {
      path,
      base,
      baseLabel: `Branch point (${shortRef(defaultBranch)})`,
      currentLabel: 'HEAD',
      baseContent: await this.context.showOrEmpty(
        commandRoot,
        `${commit}:${relativePath}`,
      ),
      currentContent: await this.context.showOrEmpty(commandRoot, `HEAD:${relativePath}`),
    }
  }

  async repoRoot(path: HostPath): Promise<HostPath> {
    return (await this.context.repository(path)).repositoryRoot
  }
}
