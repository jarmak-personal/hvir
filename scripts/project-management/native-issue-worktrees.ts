import { spawn } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import type {
  DependencyPreparationFailure,
  DependencyPreparationResult,
  IssueBranchSnapshot,
  IssueStartRepositoryPort,
  IssueWorktreeSnapshot,
  IssueWorktreeState,
} from './issue-start.ts'

const MAX_CAPTURE_BYTES = 2 * 1024 * 1024
const MAX_CLASSIFICATION_BYTES = 64 * 1024

interface NativeIssueWorktreeRepositoryOptions {
  primaryRoot: string
  environment?: NodeJS.ProcessEnv
  output?: {
    stdout: (chunk: Uint8Array) => void
    stderr: (chunk: Uint8Array) => void
  }
}

interface CapturedCommand {
  exitCode: number
  stdout: string
}

export class NativeIssueWorktreeRepository implements IssueStartRepositoryPort {
  readonly #primaryRoot: string
  readonly #environment: NodeJS.ProcessEnv
  readonly #output: NativeIssueWorktreeRepositoryOptions['output']

  constructor(options: NativeIssueWorktreeRepositoryOptions) {
    this.#primaryRoot = options.primaryRoot
    this.#environment = options.environment ?? process.env
    this.#output = options.output ?? {
      stdout: (chunk) => process.stdout.write(chunk),
      stderr: (chunk) => process.stderr.write(chunk),
    }
  }

  async refreshRemoteRefs(): Promise<void> {
    await this.#git(['fetch', '--prune', 'origin'])
  }

  async canonicalPath(path: string): Promise<string> {
    let candidate = resolve(path)
    const suffix: string[] = []
    while (true) {
      try {
        return join(await realpath(candidate), ...suffix.reverse())
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'ENOENT') {
          throw new Error('The issue worktree path could not be resolved.', {
            cause: error,
          })
        }
        const parent = dirname(candidate)
        if (parent === candidate) return join(candidate, ...suffix.reverse())
        suffix.push(basename(candidate))
        candidate = parent
      }
    }
  }

  async listWorktrees(): Promise<IssueWorktreeSnapshot[]> {
    const result = await this.#git(['worktree', 'list', '--porcelain', '-z'])
    return parseWorktreeList(result.stdout)
  }

  async inspectBranch(branch: string): Promise<IssueBranchSnapshot | null> {
    const reference = `refs/heads/${branch}`
    const head = await this.#git(
      ['rev-parse', '--verify', '--quiet', `${reference}^{commit}`],
      [0, 1],
    )
    if (head.exitCode === 1) return null

    const remote = await this.#git(['config', '--get', `branch.${branch}.remote`], [0, 1])
    const merge = await this.#git(['config', '--get', `branch.${branch}.merge`], [0, 1])
    let upstream: IssueBranchSnapshot['upstream'] = null
    if (remote.exitCode === 0 && merge.exitCode === 0) {
      const remoteName = remote.stdout.trim()
      const mergeRef = merge.stdout.trim()
      if (remoteName !== '' && mergeRef.startsWith('refs/heads/')) {
        const branchName = mergeRef.slice('refs/heads/'.length)
        const upstreamRef =
          remoteName === '.'
            ? `refs/heads/${branchName}`
            : `refs/remotes/${remoteName}/${branchName}`
        upstream = {
          name: `${remoteName}/${branchName}`,
          gone: (await this.resolveRef(upstreamRef)) === null,
        }
      }
    }
    return { head: head.stdout.trim(), upstream }
  }

  async inspectWorktreeState(path: string): Promise<IssueWorktreeState> {
    const result = await runCaptured(
      'git',
      [
        'status',
        '--porcelain=v1',
        '-z',
        '--ignored=matching',
        '--untracked-files=all',
        '--ignore-submodules=none',
      ],
      path,
    )
    return parseWorktreeStatus(result.stdout)
  }

  async pathExists(path: string): Promise<boolean> {
    try {
      await lstat(path)
      return true
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return false
      throw new Error('The issue worktree path could not be inspected.', {
        cause: error,
      })
    }
  }

  async resolveRef(reference: string): Promise<string | null> {
    const result = await this.#git(
      ['rev-parse', '--verify', '--quiet', `${reference}^{commit}`],
      [0, 1],
    )
    return result.exitCode === 0 ? result.stdout.trim() : null
  }

  async removeWorktree(path: string): Promise<void> {
    await this.#git(['worktree', 'remove', path])
  }

  async deleteBranch(branch: string, expectedHead: string): Promise<void> {
    await this.#git(['update-ref', '-d', `refs/heads/${branch}`, expectedHead])
  }

  async createWorktree(branch: string, path: string, startRef: string): Promise<void> {
    await this.#git(['worktree', 'add', '-b', branch, path, startRef])
  }

  prepareDependencies(
    path: string,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<DependencyPreparationResult> {
    if (options.signal?.aborted === true) {
      return Promise.resolve({ ready: false, failure: 'aborted' })
    }
    return new Promise((resolveResult) => {
      let settled = false
      let forcedFailure: DependencyPreparationFailure | null = null
      let classificationOutput = ''
      const child = spawn(npmExecutable(), ['ci'], {
        cwd: path,
        env: dependencyEnvironment(this.#environment),
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const appendClassification = (chunk: Uint8Array): void => {
        classificationOutput = `${classificationOutput}${Buffer.from(chunk).toString('utf8')}`
        if (classificationOutput.length > MAX_CLASSIFICATION_BYTES) {
          classificationOutput = classificationOutput.slice(-MAX_CLASSIFICATION_BYTES)
        }
      }
      child.stdout?.on('data', (chunk: Buffer) => {
        appendClassification(chunk)
        this.#output?.stdout(chunk)
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        appendClassification(chunk)
        this.#output?.stderr(chunk)
      })

      let escalation: NodeJS.Timeout | undefined
      const stop = (failure: DependencyPreparationFailure): void => {
        if (settled || forcedFailure !== null) return
        forcedFailure = failure
        child.kill('SIGTERM')
        escalation = setTimeout(() => child.kill('SIGKILL'), 5_000)
        escalation.unref()
      }
      const timeout = setTimeout(() => stop('timeout'), options.timeoutMs)
      timeout.unref()
      const abort = (): void => stop('aborted')
      options.signal?.addEventListener('abort', abort, { once: true })

      child.once('error', () => {
        finish({ ready: false, failure: forcedFailure ?? 'spawn' })
      })
      child.once('close', (code) => {
        if (forcedFailure !== null) {
          finish({ ready: false, failure: forcedFailure })
        } else if (code === 0) {
          finish({ ready: true })
        } else {
          finish({ ready: false, failure: classifyNpmFailure(classificationOutput) })
        }
      })

      function finish(result: DependencyPreparationResult): void {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (escalation !== undefined) clearTimeout(escalation)
        options.signal?.removeEventListener('abort', abort)
        resolveResult(result)
      }
    })
  }

  #git(args: string[], allowedExitCodes: number[] = [0]): Promise<CapturedCommand> {
    return runCaptured('git', args, this.#primaryRoot, allowedExitCodes)
  }
}

function runCaptured(
  command: string,
  args: string[],
  cwd: string,
  allowedExitCodes: number[] = [0],
): Promise<CapturedCommand> {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    let stdoutBytes = 0
    let overflow = false
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > MAX_CAPTURE_BYTES) {
        overflow = true
        child.kill('SIGTERM')
      } else {
        stdout.push(chunk)
      }
    })
    child.stderr?.resume()
    child.once('error', () =>
      rejectCommand(new Error(`${command} could not be started.`)),
    )
    child.once('close', (code) => {
      const exitCode = code ?? 1
      if (overflow) {
        rejectCommand(new Error(`${command} output exceeded its bounded capture.`))
      } else if (!allowedExitCodes.includes(exitCode)) {
        rejectCommand(new Error(`${command} failed with exit code ${exitCode}.`))
      } else {
        resolveCommand({
          exitCode,
          stdout: Buffer.concat(stdout).toString('utf8'),
        })
      }
    })
  })
}

export function parseWorktreeList(output: string): IssueWorktreeSnapshot[] {
  const worktrees: IssueWorktreeSnapshot[] = []
  let current: Partial<IssueWorktreeSnapshot> = {}
  const finish = (): void => {
    if (current.path !== undefined && current.head !== undefined) {
      worktrees.push({
        path: current.path,
        head: current.head,
        branch: current.branch ?? null,
        locked: current.locked ?? false,
        prunable: current.prunable ?? false,
      })
    }
    current = {}
  }
  for (const field of output.split('\0')) {
    if (field === '') {
      finish()
    } else if (field.startsWith('worktree ')) {
      current.path = field.slice('worktree '.length)
    } else if (field.startsWith('HEAD ')) {
      current.head = field.slice('HEAD '.length)
    } else if (field.startsWith('branch refs/heads/')) {
      current.branch = field.slice('branch refs/heads/'.length)
    } else if (field === 'detached') {
      current.branch = null
    } else if (field === 'locked' || field.startsWith('locked ')) {
      current.locked = true
    } else if (field === 'prunable' || field.startsWith('prunable ')) {
      current.prunable = true
    }
  }
  finish()
  return worktrees
}

export function parseWorktreeStatus(output: string): IssueWorktreeState {
  let trackedChanges = false
  let untrackedPaths = false
  const ignoredPaths: string[] = []
  for (const entry of output.split('\0')) {
    if (entry === '') continue
    const status = entry.slice(0, 2)
    const path = entry.slice(3)
    if (status === '!!') ignoredPaths.push(path)
    else if (status === '??') untrackedPaths = true
    else trackedChanges = true
  }
  return { trackedChanges, untrackedPaths, ignoredPaths }
}

function dependencyEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) =>
        !/(?:AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY|API_KEY)/i.test(
          name,
        ),
    ),
  )
}

function classifyNpmFailure(output: string): DependencyPreparationFailure {
  if (
    /\b(?:ENETUNREACH|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET)\b|network|offline/i.test(
      output,
    )
  ) {
    return 'network'
  }
  if (/electron-rebuild|node-gyp|gyp ERR|native rebuild|Rebuild Failed/i.test(output)) {
    return 'native-rebuild'
  }
  if (/install-electron|postinstall|install script|installer/i.test(output)) {
    return 'installer'
  }
  return 'npm-ci'
}

function npmExecutable(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
