import {
  basenameHostPath,
  dirnameHostPath,
  hostPath,
  type DiffBase,
  type GitDiffResponse,
  type HostPath,
} from '../../shared'
import type { ProjectHost } from '../project-host'

/**
 * Minimal, single-file git slice for ADR-007. Every command crosses the
 * ProjectHost seam, so the same implementation can be injected with SshHost
 * in Phase 4.
 */
export class GitEngine {
  constructor(private readonly host: ProjectHost) {}

  async diffInputs(path: HostPath, base: DiffBase): Promise<GitDiffResponse> {
    this.assertHost(path)
    const { repoRoot, relativePath } = await this.repoContext(path)
    const currentContent = await this.host.readTextFile(path)

    let baseContent: string
    let baseLabel: string
    if (base === 'working-tree') {
      baseContent = await this.showOrEmpty(repoRoot, `:${relativePath}`)
      baseLabel = 'Index'
    } else if (base === 'head') {
      baseContent = await this.showOrEmpty(repoRoot, `HEAD:${relativePath}`)
      baseLabel = 'HEAD'
    } else {
      const defaultBranch = await this.defaultBranch(repoRoot)
      const mergeBase = await this.run(repoRoot, ['merge-base', 'HEAD', defaultBranch])
      const commit = mergeBase.trim()
      if (!commit)
        throw new Error(`git merge-base returned no commit for ${defaultBranch}`)
      baseContent = await this.showOrEmpty(repoRoot, `${commit}:${relativePath}`)
      baseLabel = `Branch point (${shortRef(defaultBranch)})`
    }

    return {
      path,
      base,
      baseLabel,
      currentLabel: 'Working tree',
      baseContent,
      currentContent,
    }
  }

  async repoRoot(path: HostPath): Promise<HostPath> {
    return (await this.repoContext(path)).repoRoot
  }

  private async repoContext(path: HostPath): Promise<{
    readonly repoRoot: HostPath
    readonly relativePath: string
  }> {
    this.assertHost(path)
    const directory = dirnameHostPath(path)
    const root = (await this.run(directory, ['rev-parse', '--show-toplevel'])).trim()
    if (!root) throw new Error('git did not report a repository root')
    const prefix = await this.run(directory, ['rev-parse', '--show-prefix'])
    const normalizedPrefix = prefix.replace(/\r?\n$/, '')
    if (normalizedPrefix.startsWith('/') || normalizedPrefix.includes('../')) {
      throw new Error('git reported an invalid repository-relative prefix')
    }
    return {
      repoRoot: hostPath(path.hostId, root),
      relativePath: `${normalizedPrefix}${basenameHostPath(path)}`,
    }
  }

  private async defaultBranch(repoRoot: HostPath): Promise<string> {
    const symbolic = await this.tryRun(repoRoot, [
      'symbolic-ref',
      '--quiet',
      '--short',
      'refs/remotes/origin/HEAD',
    ])
    if (symbolic?.trim()) return symbolic.trim()

    for (const candidate of [
      'refs/remotes/origin/main',
      'refs/heads/main',
      'refs/remotes/origin/master',
      'refs/heads/master',
    ]) {
      const exists = await this.host.exec('git', [
        '-C',
        repoRoot.path,
        'show-ref',
        '--verify',
        '--quiet',
        candidate,
      ])
      if (exists.code === 0) return candidate
    }

    const upstream = await this.tryRun(repoRoot, [
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      '@{upstream}',
    ])
    if (upstream?.trim()) return upstream.trim()
    throw new Error(
      'Cannot determine the default branch (no origin/HEAD, main, or master)',
    )
  }

  private async showOrEmpty(repoRoot: HostPath, revision: string): Promise<string> {
    const result = await this.host.exec('git', ['-C', repoRoot.path, 'show', revision])
    if (result.code === 0) return result.stdout
    // A path absent from the index/commit is an empty side of the diff, not a
    // fatal error (new and untracked files are common in agent worktrees).
    if (result.code === 128) return ''
    throw gitError(['show', revision], result.stderr, result.code)
  }

  private async run(repoRoot: HostPath, args: readonly string[]): Promise<string> {
    const result = await this.host.exec('git', ['-C', repoRoot.path, ...args])
    if (result.code !== 0) throw gitError(args, result.stderr, result.code)
    return result.stdout
  }

  private async tryRun(
    repoRoot: HostPath,
    args: readonly string[],
  ): Promise<string | undefined> {
    const result = await this.host.exec('git', ['-C', repoRoot.path, ...args])
    return result.code === 0 ? result.stdout : undefined
  }

  private assertHost(path: HostPath): void {
    if (path.hostId !== this.host.hostId) {
      throw new Error(`GitEngine received path for host '${path.hostId}'`)
    }
  }
}

function gitError(args: readonly string[], stderr: string, code: number | null): Error {
  const detail = stderr.trim() || `exit code ${String(code)}`
  return new Error(`git ${args.join(' ')} failed: ${detail}`)
}

function shortRef(ref: string): string {
  return ref.replace(/^refs\/(heads|remotes)\//, '').replace(/^origin\//, '')
}
