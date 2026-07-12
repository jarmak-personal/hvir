import {
  basenameHostPath,
  dirnameHostPath,
  hostPath,
  type DiffBase,
  type GitDiffResponse,
  type GitBlameLine,
  type GitChangedFile,
  type GitChanges,
  type GitHistoryPage,
  type GitCommitDetail,
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

  async diffInputs(
    path: HostPath,
    base: DiffBase,
    revision?: string,
  ): Promise<GitDiffResponse> {
    this.assertHost(path)
    const { repoRoot, relativePath } = await this.repoContext(path)
    if (revision) {
      assertRevision(revision)
      return {
        path,
        base,
        revision,
        baseLabel: `${revision.slice(0, 8)}^`,
        currentLabel: revision.slice(0, 8),
        baseContent: await this.showOrEmpty(repoRoot, `${revision}^:${relativePath}`),
        currentContent: await this.showOrEmpty(repoRoot, `${revision}:${relativePath}`),
      }
    }
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

  async changes(projectRoot: HostPath): Promise<GitChanges> {
    const repoRoot = await this.discoverRoot(projectRoot)
    const status = await this.run(repoRoot, ['status', '--porcelain=v2', '-z'])
    const stats = parseNumstat(
      await this.run(repoRoot, ['diff', '--numstat', '-z', 'HEAD', '--']),
    )
    const workingTree = parseStatus(status).map((file) =>
      changedFile(repoRoot, file, stats),
    )
    const defaultBranch = await this.defaultBranch(repoRoot)
    const mergeBase = (
      await this.run(repoRoot, ['merge-base', 'HEAD', defaultBranch])
    ).trim()
    const branchStats = parseNumstat(
      await this.run(repoRoot, ['diff', '--numstat', '-z', mergeBase, 'HEAD', '--']),
    )
    const branchPoint = [...branchStats.entries()].map(([path, counts]) => ({
      path: hostPath(repoRoot.hostId, `${repoRoot.path}/${path}`),
      staged: false,
      unstaged: false,
      untracked: false,
      conflicted: false,
      additions: counts.additions,
      deletions: counts.deletions,
    }))
    return { workingTree, branchPoint }
  }

  async history(
    projectRoot: HostPath,
    skip: number,
    limit: number,
    path?: HostPath,
  ): Promise<GitHistoryPage> {
    const repoRoot = await this.discoverRoot(projectRoot)
    const count = Math.max(1, Math.min(200, Math.floor(limit)))
    const args = [
      'log',
      `--skip=${Math.max(0, Math.floor(skip))}`,
      `-n${count + 1}`,
      '--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e',
    ]
    if (path) args.push('--', (await this.repoContext(path)).relativePath)
    const records = (await this.run(repoRoot, args))
      .split('\x1e')
      .map((record) => record.trim())
      .filter(Boolean)
    return {
      commits: records.slice(0, count).map((record) => {
        const [hash = '', shortHash = '', author = '', authoredAt = '', subject = ''] =
          record.split('\x1f')
        return { hash, shortHash, author, authoredAt, subject }
      }),
      hasMore: records.length > count,
    }
  }

  async blame(path: HostPath): Promise<readonly GitBlameLine[]> {
    const { repoRoot, relativePath } = await this.repoContext(path)
    const output = await this.run(repoRoot, [
      'blame',
      '--line-porcelain',
      '--',
      relativePath,
    ])
    const lines: GitBlameLine[] = []
    let current:
      { hash: string; line: number; author: string; summary: string } | undefined
    for (const line of output.split('\n')) {
      const header = /^([0-9a-f^]{40}) \d+ (\d+)/.exec(line)
      if (header) {
        current = {
          hash: header[1] ?? '',
          line: Number(header[2]),
          author: '',
          summary: '',
        }
      } else if (current && line.startsWith('author ')) current.author = line.slice(7)
      else if (current && line.startsWith('summary ')) current.summary = line.slice(8)
      else if (current && line.startsWith('\t')) {
        lines.push(current)
        current = undefined
      }
    }
    return lines
  }

  async commitDetail(projectRoot: HostPath, hash: string): Promise<GitCommitDetail> {
    assertRevision(hash)
    const repoRoot = await this.discoverRoot(projectRoot)
    const output = await this.run(repoRoot, [
      'show',
      '--no-renames',
      '--format=%H%x1f%h%x1f%an%x1f%aI%x1f%B%x1e',
      '--numstat',
      '-z',
      hash,
      '--',
    ])
    const separator = output.indexOf('\x1e')
    if (separator < 0) throw new Error('git show returned malformed commit detail')
    const [fullHash = '', shortHash = '', author = '', authoredAt = '', ...message] =
      output.slice(0, separator).split('\x1f')
    const stats = parseNumstat(output.slice(separator + 1).replace(/^\r?\n/, ''))
    return {
      hash: fullHash,
      shortHash,
      author,
      authoredAt,
      subject: message.join('\x1f').trim().split('\n')[0] ?? '',
      message: message.join('\x1f').trim(),
      files: [...stats.entries()].map(([path, counts]) => ({
        path: hostPath(repoRoot.hostId, `${repoRoot.path}/${path}`),
        ...counts,
      })),
    }
  }

  private async discoverRoot(path: HostPath): Promise<HostPath> {
    this.assertHost(path)
    const root = (await this.run(path, ['rev-parse', '--show-toplevel'])).trim()
    if (!root) throw new Error('git did not report a repository root')
    return hostPath(path.hostId, root)
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

function assertRevision(revision: string): void {
  if (!/^[0-9a-f]{7,40}$/i.test(revision)) throw new Error('Invalid git revision')
}

interface ParsedStatus {
  readonly path: string
  readonly staged: boolean
  readonly unstaged: boolean
  readonly untracked: boolean
  readonly conflicted: boolean
}

function parseStatus(output: string): readonly ParsedStatus[] {
  const records = output.split('\0')
  const result: ParsedStatus[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? ''
    if (!record) continue
    if (record.startsWith('? ')) {
      result.push({
        path: record.slice(2),
        staged: false,
        unstaged: false,
        untracked: true,
        conflicted: false,
      })
      continue
    }
    if (record.startsWith('u ')) {
      const fields = record.split(' ')
      result.push({
        path: fields.slice(10).join(' '),
        staged: true,
        unstaged: true,
        untracked: false,
        conflicted: true,
      })
      continue
    }
    if (record.startsWith('1 ') || record.startsWith('2 ')) {
      const fields = record.split(' ')
      const xy = fields[1] ?? '..'
      const pathIndex = record.startsWith('2 ') ? 9 : 8
      result.push({
        path: fields.slice(pathIndex).join(' '),
        staged: xy[0] !== '.',
        unstaged: xy[1] !== '.',
        untracked: false,
        conflicted: xy.includes('U'),
      })
      if (record.startsWith('2 ')) index += 1
    }
  }
  return result
}

function parseNumstat(
  output: string,
): Map<string, { additions: number; deletions: number }> {
  const result = new Map<string, { additions: number; deletions: number }>()
  const records = output.split('\0')
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? ''
    if (!record) continue
    const [added, deleted, inlinePath = ''] = record.split('\t')
    const path = inlinePath || records[index + 2]
    if (!path) continue
    if (!inlinePath) index += 2
    result.set(path, {
      additions: added === '-' ? 0 : Number(added ?? 0),
      deletions: deleted === '-' ? 0 : Number(deleted ?? 0),
    })
  }
  return result
}

function changedFile(
  root: HostPath,
  file: ParsedStatus,
  stats: ReadonlyMap<string, { additions: number; deletions: number }>,
): GitChangedFile {
  const counts = stats.get(file.path) ?? { additions: 0, deletions: 0 }
  return {
    ...file,
    path: hostPath(root.hostId, `${root.path}/${file.path}`),
    additions: counts.additions,
    deletions: counts.deletions,
  }
}
