import type { GitBlameRun, GitCommitDetail, HostPath } from '../../shared'
import type { GitCommandContext } from './git-command-context'
import { assertRevision, parseBlame, parseCommitDetail } from './git-parsers'

export class GitDetailCapability {
  constructor(private readonly context: GitCommandContext) {}

  async blame(path: HostPath): Promise<readonly GitBlameRun[]> {
    const { commandRoot, relativePath } = await this.context.repository(path)
    const output = await this.context.run(
      commandRoot,
      ['blame', '--line-porcelain', '--', relativePath],
      64 * 1024 * 1024,
    )
    return parseBlame(output)
  }

  async commitDetail(projectRoot: HostPath, hash: string): Promise<GitCommitDetail> {
    assertRevision(hash)
    const context = await this.context.project(projectRoot)
    if (!context) throw new Error('Not a Git repository')
    const { commandRoot, repositoryPrefix } = context
    const output = await this.context.run(commandRoot, [
      'show',
      '--no-renames',
      '--no-ext-diff',
      '--no-textconv',
      '--diff-merges=first-parent',
      '--format=%H%x1f%h%x1f%P%x1f%an%x1f%aI%x1f%D%x1f%B%x1e',
      '--numstat',
      '-z',
      hash,
      '--',
      '.',
    ])
    return parseCommitDetail(output, commandRoot, repositoryPrefix)
  }
}
