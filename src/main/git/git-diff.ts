import {
  DIFF_INPUT_BYTE_LIMIT,
  type DiffBase,
  type GitDiffResponse,
  type HostPath,
} from '../../shared'
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
        baseInput: await this.context.boundedShowOrEmpty(
          commandRoot,
          `${revision}^:${relativePath}`,
          DIFF_INPUT_BYTE_LIMIT,
        ),
        currentInput: await this.context.boundedShowOrEmpty(
          commandRoot,
          `${revision}:${relativePath}`,
          DIFF_INPUT_BYTE_LIMIT,
        ),
      }
    }
    if (base === 'working-tree' || base === 'head') {
      const currentInput = await this.context.readWorkingTreeOrEmpty(
        path,
        commandRoot,
        relativePath,
        DIFF_INPUT_BYTE_LIMIT,
      )
      if (base === 'working-tree') {
        return {
          path,
          base,
          baseLabel: 'Index',
          currentLabel: 'Working tree',
          baseInput: await this.context.boundedShowOrEmpty(
            commandRoot,
            `:${relativePath}`,
            DIFF_INPUT_BYTE_LIMIT,
          ),
          currentInput,
        }
      }
      return {
        path,
        base,
        baseLabel: 'HEAD',
        currentLabel: 'Working tree',
        baseInput: await this.context.boundedShowOrEmpty(
          commandRoot,
          `HEAD:${relativePath}`,
          DIFF_INPUT_BYTE_LIMIT,
        ),
        currentInput,
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
      baseInput: await this.context.boundedShowOrEmpty(
        commandRoot,
        `${commit}:${relativePath}`,
        DIFF_INPUT_BYTE_LIMIT,
      ),
      currentInput: await this.context.boundedShowOrEmpty(
        commandRoot,
        `HEAD:${relativePath}`,
        DIFF_INPUT_BYTE_LIMIT,
      ),
    }
  }

  async repoRoot(path: HostPath): Promise<HostPath> {
    return (await this.context.repository(path)).repositoryRoot
  }
}
