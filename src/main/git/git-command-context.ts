import {
  basenameHostPath,
  dirnameHostPath,
  hostPath,
  GIT_CHANGE_DISPLAY_LIMIT,
  type ExecResult,
  type HostId,
  type HostPath,
} from '../../shared'
import type { ExecOptions } from '../project-host'

const GIT_STATUS_MAX_BUFFER = 20 * 1024 * 1024
const GIT_STATUS_MAX_RECORDS = (GIT_CHANGE_DISPLAY_LIMIT + 1) * 2

/** The exact host operations used by the off-thread Git engine. */
export interface GitHostPort {
  readonly hostId: HostId
  exec(command: string, args: readonly string[], opts?: ExecOptions): Promise<ExecResult>
  readTextFile(path: HostPath): Promise<string>
}

export interface GitProjectContext {
  readonly repositoryRoot: HostPath
  readonly commandRoot: HostPath
  readonly repositoryPrefix: string
}

export interface GitRepositoryContext {
  readonly repositoryRoot: HostPath
  readonly commandRoot: HostPath
  readonly relativePath: string
}

/** Shared command, cancellation, root-validation, and error policy. */
export class GitCommandContext {
  constructor(
    readonly host: GitHostPort,
    private readonly projectRoot?: HostPath,
  ) {}

  assertHost(path: HostPath): void {
    if (path.hostId !== this.host.hostId) {
      throw new Error(`GitEngine received path for host '${path.hostId}'`)
    }
  }

  readOnly(
    root: HostPath,
    args: readonly string[],
    opts: ExecOptions = {},
  ): Promise<ExecResult> {
    this.assertHost(root)
    return this.host.exec('git', ['-C', root.path, ...args], {
      ...opts,
      env: { ...opts.env, GIT_OPTIONAL_LOCKS: '0' },
    })
  }

  mutate(
    root: HostPath,
    args: readonly string[],
    opts: ExecOptions = {},
  ): Promise<ExecResult> {
    this.assertHost(root)
    return this.host.exec('git', ['-C', root.path, ...args], opts)
  }

  async run(
    root: HostPath,
    args: readonly string[],
    maxBuffer?: number,
  ): Promise<string> {
    const result = await this.readOnly(root, args, { maxBuffer })
    if (result.code !== 0) throw gitError(args, result.stderr, result.code)
    return result.stdout
  }

  async tryRun(root: HostPath, args: readonly string[]): Promise<string | undefined> {
    const result = await this.readOnly(root, args)
    return result.code === 0 ? result.stdout : undefined
  }

  async boundedStatus(
    root: HostPath,
    args: readonly string[],
  ): Promise<{ readonly output: string; readonly truncated: boolean }> {
    const result = await this.readOnly(root, args, {
      maxBuffer: GIT_STATUS_MAX_BUFFER,
      allowTruncatedOutput: true,
      maxStdoutNulRecords: GIT_STATUS_MAX_RECORDS,
    })
    if (!result.outputTruncated && result.code !== 0) {
      throw gitError(args, result.stderr, result.code)
    }
    return { output: result.stdout, truncated: result.outputTruncated === true }
  }

  async project(projectRoot: HostPath): Promise<GitProjectContext | undefined> {
    this.assertHost(projectRoot)
    const rootResult = await this.readOnly(projectRoot, ['rev-parse', '--show-toplevel'])
    if (rootResult.code !== 0) {
      if (/not a git repository/i.test(rootResult.stderr)) return undefined
      throw gitError(['rev-parse', '--show-toplevel'], rootResult.stderr, rootResult.code)
    }
    const root = rootResult.stdout.trim()
    if (!root) throw new Error('git did not report a repository root')
    const prefix = (await this.run(projectRoot, ['rev-parse', '--show-prefix'])).replace(
      /\r?\n$/,
      '',
    )
    if (prefix.startsWith('/') || prefix.split('/').includes('..')) {
      throw new Error('git reported an invalid repository-relative prefix')
    }
    return {
      repositoryRoot: hostPath(projectRoot.hostId, root),
      commandRoot: projectRoot,
      repositoryPrefix: prefix,
    }
  }

  async repository(path: HostPath): Promise<GitRepositoryContext> {
    this.assertHost(path)
    if (this.projectRoot) {
      const prefix = this.projectRoot.path === '/' ? '/' : `${this.projectRoot.path}/`
      if (!path.path.startsWith(prefix)) {
        throw new Error('Git path escapes the active project')
      }
      const context = await this.project(this.projectRoot)
      if (!context) throw new Error('Not a Git repository')
      return {
        repositoryRoot: context.repositoryRoot,
        commandRoot: context.commandRoot,
        relativePath: `${context.repositoryPrefix}${path.path.slice(prefix.length)}`,
      }
    }
    const directory = dirnameHostPath(path)
    const root = (await this.run(directory, ['rev-parse', '--show-toplevel'])).trim()
    if (!root) throw new Error('git did not report a repository root')
    const prefix = await this.run(directory, ['rev-parse', '--show-prefix'])
    const normalizedPrefix = prefix.replace(/\r?\n$/, '')
    if (normalizedPrefix.startsWith('/') || normalizedPrefix.includes('../')) {
      throw new Error('git reported an invalid repository-relative prefix')
    }
    return {
      repositoryRoot: hostPath(path.hostId, root),
      commandRoot: this.projectRoot ?? hostPath(path.hostId, root),
      relativePath: `${normalizedPrefix}${basenameHostPath(path)}`,
    }
  }

  async defaultBranch(root: HostPath): Promise<string> {
    const symbolic = await this.tryRun(root, [
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
      const exists = await this.readOnly(root, [
        'show-ref',
        '--verify',
        '--quiet',
        candidate,
      ])
      if (exists.code === 0) return candidate
    }
    throw new Error(
      'Cannot determine the default branch (no origin/HEAD, main, or master)',
    )
  }

  async showOrEmpty(root: HostPath, revision: string): Promise<string> {
    const result = await this.readOnly(root, ['show', revision])
    if (result.code === 0) return result.stdout
    if (result.code === 128) return ''
    throw gitError(['show', revision], result.stderr, result.code)
  }

  async readWorkingTreeOrEmpty(
    path: HostPath,
    commandRoot: HostPath,
    relativePath: string,
  ): Promise<string> {
    try {
      return await this.host.readTextFile(path)
    } catch (reason) {
      const trackedDeletion = await this.readOnly(commandRoot, [
        'ls-files',
        '--deleted',
        '--error-unmatch',
        '--',
        relativePath,
      ])
      if (trackedDeletion.code === 0 && trackedDeletion.stdout.trim()) return ''
      throw reason
    }
  }
}

export function gitError(
  args: readonly string[],
  stderr: string,
  code: number | null,
): Error {
  const detail = stderr.trim() || `exit code ${String(code)}`
  return new Error(`git ${args.join(' ')} failed: ${detail}`)
}

export function shortRef(ref: string): string {
  return ref.replace(/^refs\/(heads|remotes)\//, '').replace(/^origin\//, '')
}
