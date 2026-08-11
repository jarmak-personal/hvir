import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { dispatchWorkerHostCall } from '../src/main/git/worker-host-broker'
import { GIT_FETCH_ARGS, GIT_PULL_ARGS, GitEngine } from '../src/main/git/git-engine'
import { LocalHost, type ProjectHost } from '../src/main/project-host'
import { DIFF_INPUT_BYTE_LIMIT, localPath, type WorkerHostCall } from '../src/shared'

type ExecHostCall = Extract<WorkerHostCall, { readonly operation: 'exec' }>

const cleanups: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true })))
})

describe('Git worker host broker', () => {
  it('pins execution to git and the active project root', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'hvir-broker-'))
    cleanups.push(rootPath)
    const host = new LocalHost()
    const realpath = vi.spyOn(host, 'realpath')
    const exec = vi.spyOn(host, 'exec').mockResolvedValue({
      code: 0,
      signal: null,
      stdout: '',
      stderr: '',
    })
    const call = hostCall(rootPath)

    await dispatchWorkerHostCall(call, { host, root: localPath(rootPath) })
    await dispatchWorkerHostCall(call, { host, root: localPath(rootPath) })

    const lastCall = exec.mock.calls.at(-1)
    expect(lastCall?.[0]).toBe('git')
    expect(lastCall?.[1]).toEqual(['-c', 'core.fsmonitor=false', ...call.args])
    expect(lastCall?.[2]?.cwd).toEqual(localPath(rootPath))
    expect(lastCall?.[2]?.env).toEqual({ GIT_OPTIONAL_LOCKS: '0' })
    expect(lastCall?.[2]?.maxBuffer).toBe(10 * 1024 * 1024)
    expect(lastCall?.[2]?.signal).toBeInstanceOf(AbortSignal)
    expect(realpath).toHaveBeenCalledOnce()
  })

  it('permits index refresh only for the bounded workspace activity status', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'hvir-broker-index-refresh-'))
    cleanups.push(rootPath)
    const host = new LocalHost()
    const exec = vi.spyOn(host, 'exec').mockResolvedValue({
      code: 0,
      signal: null,
      stdout: '',
      stderr: '',
    })
    const project = { host, root: localPath(rootPath) }
    const activityCall: ExecHostCall = {
      ...hostCall(rootPath),
      args: [
        '-C',
        rootPath,
        'status',
        '--porcelain=v2',
        '-z',
        '--untracked-files=all',
        '--',
        '.',
      ],
      allowTruncatedOutput: true,
      maxStdoutNulRecords: 4_002,
      allowIndexRefresh: true,
    }

    await dispatchWorkerHostCall(activityCall, project)

    expect(exec.mock.calls[0]?.[2]?.env).toBeUndefined()
    await expect(
      dispatchWorkerHostCall(
        {
          ...hostCall(rootPath),
          args: ['-C', rootPath, 'rev-parse', '--show-toplevel'],
          allowIndexRefresh: true,
        },
        project,
      ),
    ).rejects.toThrow('unsupported index refresh authority')
  })

  it('rejects arbitrary commands and paths outside the active root', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'hvir-broker-'))
    const outside = await mkdtemp(join(tmpdir(), 'hvir-broker-outside-'))
    cleanups.push(rootPath, outside)
    await writeFile(join(outside, 'secret.txt'), 'secret')
    const host = new LocalHost()
    const project = { host, root: localPath(rootPath) }

    await expect(
      dispatchWorkerHostCall({ ...hostCall(rootPath), command: 'sh' }, project),
    ).rejects.toThrow('only git')
    await expect(
      dispatchWorkerHostCall(
        {
          kind: 'host-call',
          callId: 2,
          hostId: 'local',
          operation: 'readTextFile',
          path: localPath(join(outside, 'secret.txt')),
        },
        project,
      ),
    ).rejects.toThrow('escapes the active project')
  })

  it('routes only bounded text-prefix reads inside the active project', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'hvir-broker-prefix-'))
    cleanups.push(rootPath)
    const host = new LocalHost()
    const path = localPath(join(rootPath, 'file.txt'))
    await writeFile(path.path, 'abcde')
    const project = { host, root: localPath(rootPath) }
    const call: WorkerHostCall = {
      kind: 'host-call',
      callId: 2,
      hostId: host.hostId,
      operation: 'readTextFilePrefix',
      path,
      maxBytes: 4,
    }

    await expect(dispatchWorkerHostCall(call, project)).resolves.toMatchObject({
      content: 'abcd',
      complete: false,
    })
    await expect(
      dispatchWorkerHostCall({ ...call, maxBytes: 0 }, project),
    ).rejects.toThrow('Invalid text prefix byte limit')
    await expect(
      dispatchWorkerHostCall({ ...call, maxBytes: DIFF_INPUT_BYTE_LIMIT + 1 }, project),
    ).rejects.toThrow('Invalid text prefix byte limit')
  })

  it('routes only confined entry metadata', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'hvir-broker-stat-'))
    const outside = await mkdtemp(join(tmpdir(), 'hvir-broker-stat-outside-'))
    cleanups.push(rootPath, outside)
    const path = localPath(join(rootPath, 'file.txt'))
    await writeFile(path.path, 'content')
    const host = new LocalHost()
    const project = { host, root: localPath(rootPath) }
    const call: WorkerHostCall = {
      kind: 'host-call',
      callId: 2,
      hostId: host.hostId,
      operation: 'stat',
      path,
    }

    await expect(dispatchWorkerHostCall(call, project)).resolves.toMatchObject({
      type: 'file',
      size: 7,
    })
    await expect(
      dispatchWorkerHostCall(
        { ...call, path: localPath(join(outside, 'file.txt')) },
        project,
      ),
    ).rejects.toThrow('escapes the active project')
  })

  it('permits truncation only for status and bounded blob reads', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'hvir-broker-show-'))
    cleanups.push(rootPath)
    const host = new LocalHost()
    const exec = vi.spyOn(host, 'exec').mockResolvedValue({
      code: 0,
      signal: null,
      stdout: 'prefix',
      stderr: '',
      outputTruncated: true,
    })
    const project = { host, root: localPath(rootPath) }
    const show: ExecHostCall = {
      ...hostCall(rootPath),
      args: ['-C', rootPath, 'show', 'HEAD:file.txt'],
      maxBuffer: 1024,
      allowTruncatedOutput: true,
    }

    await dispatchWorkerHostCall(show, project)

    expect(exec.mock.calls[0]?.[2]).toMatchObject({
      maxBuffer: 1024,
      allowTruncatedOutput: true,
    })
    await expect(
      dispatchWorkerHostCall(
        {
          ...show,
          args: ['-C', rootPath, 'show-ref', '--verify', '--quiet', 'refs/heads/main'],
        },
        project,
      ),
    ).rejects.toThrow('unsupported output truncation')
    await expect(
      dispatchWorkerHostCall(
        {
          ...show,
          args: [
            '-C',
            rootPath,
            'show',
            '--no-renames',
            '--no-ext-diff',
            '--no-textconv',
            '--diff-merges=first-parent',
            '--format=%H%x1f%h%x1f%P%x1f%an%x1f%aI%x1f%D%x1f%B%x1e',
            '--numstat',
            '-z',
            '0123456789012345678901234567890123456789',
            '--',
            '.',
          ],
        },
        project,
      ),
    ).rejects.toThrow('unsupported output truncation')
  })

  it('requires one-shot authorization for the exact worktree prune grammar', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'hvir-broker-prune-'))
    cleanups.push(rootPath)
    const host = new LocalHost()
    const exec = vi.spyOn(host, 'exec').mockResolvedValue({
      code: 0,
      signal: null,
      stdout: '',
      stderr: '',
    })
    const project = { host, root: localPath(rootPath) }
    const call: ExecHostCall = {
      ...hostCall(rootPath),
      args: ['-C', rootPath, 'worktree', 'prune', '--expire', 'now', '--verbose'],
    }

    await expect(dispatchWorkerHostCall(call, project)).rejects.toThrow(
      'unauthorized worktree prune',
    )
    expect(exec).not.toHaveBeenCalled()

    await dispatchWorkerHostCall(call, project, { allowWorktreePrune: true })
    expect(exec).toHaveBeenCalledOnce()
    expect(exec.mock.calls[0]?.[2]?.env).toBeUndefined()

    await expect(
      dispatchWorkerHostCall(
        { ...call, args: ['-C', rootPath, 'worktree', 'prune', '--verbose'] },
        project,
        { allowWorktreePrune: true },
      ),
    ).rejects.toThrow('forbidden git invocation')
  })

  it('authorizes only one exact branch switch target', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'hvir-broker-switch-'))
    cleanups.push(rootPath)
    const host = new LocalHost()
    const exec = vi.spyOn(host, 'exec').mockResolvedValue({
      code: 0,
      signal: null,
      stdout: '',
      stderr: '',
    })
    const project = { host, root: localPath(rootPath) }
    const call: ExecHostCall = {
      ...hostCall(rootPath),
      args: ['-C', rootPath, 'switch', '--no-guess', 'feature/one'],
    }

    await expect(dispatchWorkerHostCall(call, project)).rejects.toThrow(
      'unauthorized branch switch',
    )
    await expect(
      dispatchWorkerHostCall(call, project, { allowBranchSwitch: 'feature/two' }),
    ).rejects.toThrow('unauthorized branch switch')
    expect(exec).not.toHaveBeenCalled()

    await dispatchWorkerHostCall(call, project, {
      allowBranchSwitch: 'feature/one',
    })
    expect(exec).toHaveBeenCalledOnce()
    expect(exec.mock.calls[0]?.[2]?.env).toBeUndefined()

    await expect(
      dispatchWorkerHostCall(
        { ...call, args: ['-C', rootPath, 'switch', '-C', 'feature/one'] },
        project,
        { allowBranchSwitch: 'feature/one' },
      ),
    ).rejects.toThrow('forbidden git invocation')
  })

  it('authorizes only exact non-interactive fetch and fast-forward pull grammars', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'hvir-broker-sync-'))
    cleanups.push(rootPath)
    const host = new LocalHost()
    const exec = vi.spyOn(host, 'exec').mockResolvedValue({
      code: 0,
      signal: null,
      stdout: '',
      stderr: '',
    })
    const project = { host, root: localPath(rootPath) }
    const fetchCall: ExecHostCall = {
      ...hostCall(rootPath),
      args: ['-C', rootPath, ...GIT_FETCH_ARGS],
    }
    const pullCall: ExecHostCall = {
      ...hostCall(rootPath),
      args: ['-C', rootPath, ...GIT_PULL_ARGS],
    }

    await expect(dispatchWorkerHostCall(fetchCall, project)).rejects.toThrow(
      'unauthorized fetch',
    )
    await dispatchWorkerHostCall(fetchCall, project, { allowFetch: true })
    expect(exec.mock.calls.at(-1)?.[2]?.env).toEqual({
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'Never',
    })

    await expect(dispatchWorkerHostCall(pullCall, project)).rejects.toThrow(
      'unauthorized pull',
    )
    await dispatchWorkerHostCall(pullCall, project, { allowPull: true })
    expect(exec.mock.calls.at(-1)?.[2]?.env).toEqual({
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'Never',
    })

    await expect(
      dispatchWorkerHostCall(
        { ...pullCall, args: [...pullCall.args, '--rebase'] },
        project,
        { allowPull: true },
      ),
    ).rejects.toThrow('forbidden git invocation')
  })

  it.each([
    ['config alias execution', ['-c', 'alias.x=!touch /tmp/hvir-owned', 'x']],
    ['second working directory', ['status', '-C', '/tmp', '--porcelain=v2']],
    ['git directory override', ['--git-dir=/tmp/repo', 'status']],
    ['work tree override', ['--work-tree', '/tmp', 'status']],
    ['helper subcommand', ['credential', 'fill']],
    ['external diff option', ['diff', '--ext-diff', 'HEAD']],
    [
      'per-file no-index stats',
      [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-index',
        '--numstat',
        '-z',
        '--',
        '/dev/null',
        'untracked.txt',
      ],
    ],
    [
      'feature upstream discovery',
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    ],
  ])('rejects %s', async (_label, command) => {
    const rootPath = await mkdtemp(join(tmpdir(), 'hvir-broker-'))
    cleanups.push(rootPath)
    const host = new LocalHost()
    const exec = vi.spyOn(host, 'exec')
    const project = { host, root: localPath(rootPath) }

    await expect(
      dispatchWorkerHostCall(
        { ...hostCall(rootPath), args: ['-C', rootPath, ...command] },
        project,
      ),
    ).rejects.toThrow('forbidden git invocation')
    expect(exec).not.toHaveBeenCalled()
  })

  it('accepts every read-only command emitted by GitEngine', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'hvir-broker-engine-'))
    cleanups.push(rootPath)
    git(rootPath, ['init', '-b', 'main'])
    git(rootPath, ['config', 'user.email', 'hvir@example.test'])
    git(rootPath, ['config', 'user.name', 'hvir test'])
    await writeFile(join(rootPath, 'file.txt'), 'base\n')
    await writeFile(join(rootPath, '.gitignore'), 'ignored.txt\n')
    git(rootPath, ['add', 'file.txt', '.gitignore'])
    git(rootPath, ['commit', '-m', 'base'])
    await writeFile(join(rootPath, 'file.txt'), 'changed\n')
    await writeFile(join(rootPath, 'untracked.txt'), 'new\n')
    await writeFile(join(rootPath, 'ignored.txt'), 'ignored\n')

    const actual = new LocalHost()
    const project = { host: actual, root: localPath(rootPath) }
    let callId = 0
    const proxy = {
      hostId: actual.hostId,
      exec: (command: string, args: readonly string[], opts = {}) =>
        dispatchWorkerHostCall(
          {
            kind: 'host-call',
            callId: ++callId,
            hostId: actual.hostId,
            operation: 'exec',
            command,
            args,
            ...(opts as { maxBuffer?: number }),
          },
          project,
        ),
      readTextFile: (path: ReturnType<typeof localPath>) =>
        dispatchWorkerHostCall(
          {
            kind: 'host-call',
            callId: ++callId,
            hostId: actual.hostId,
            operation: 'readTextFile',
            path,
          },
          project,
        ),
      readTextFilePrefix: (path: ReturnType<typeof localPath>, maxBytes: number) =>
        dispatchWorkerHostCall(
          {
            kind: 'host-call',
            callId: ++callId,
            hostId: actual.hostId,
            operation: 'readTextFilePrefix',
            path,
            maxBytes,
          },
          project,
        ),
      stat: (path: ReturnType<typeof localPath>) =>
        dispatchWorkerHostCall(
          {
            kind: 'host-call',
            callId: ++callId,
            hostId: actual.hostId,
            operation: 'stat',
            path,
          },
          project,
        ),
    } as unknown as ProjectHost
    const engine = new GitEngine(proxy, localPath(rootPath))

    await expect(engine.worktrees(localPath(rootPath))).resolves.toEqual(
      expect.objectContaining({ repository: true }),
    )
    await expect(engine.workspaceActivity(localPath(rootPath))).resolves.toMatchObject({
      changedFiles: 2,
    })
    await expect(engine.branches(localPath(rootPath))).resolves.toEqual(
      expect.objectContaining({ current: 'main' }),
    )
    const changes = await engine.changes(localPath(rootPath))
    const history = await engine.history(localPath(rootPath), 1)
    const graphHistory = await engine.history(
      localPath(rootPath),
      1,
      undefined,
      undefined,
      true,
    )
    const commit = history.commits[0]
    expect(changes.workingTree).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: localPath(join(rootPath, 'file.txt')) }),
        expect.objectContaining({
          path: localPath(join(rootPath, 'untracked.txt')),
          additions: 1,
        }),
      ]),
    )
    expect(commit).toBeDefined()
    expect(graphHistory.commits).toHaveLength(1)
    await expect(
      engine.ignoredEntries(localPath(rootPath), localPath(rootPath), ['ignored.txt']),
    ).resolves.toEqual({ ignoredNames: ['ignored.txt'] })
    await expect(
      engine.commitDetail(localPath(rootPath), commit!.hash),
    ).resolves.toBeDefined()
    await expect(
      engine.diffInputs(localPath(join(rootPath, 'file.txt')), 'branch-point'),
    ).resolves.toBeDefined()
    await expect(
      engine.blame(localPath(join(rootPath, 'file.txt'))),
    ).resolves.toHaveLength(1)
    await actual.dispose()
  })

  it('persists clean-filter stat refreshes instead of filtering the same file again', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'hvir-broker-filter-'))
    cleanups.push(rootPath)
    git(rootPath, ['init', '-b', 'main'])
    git(rootPath, ['config', 'user.email', 'hvir@example.test'])
    git(rootPath, ['config', 'user.name', 'hvir test'])
    const filterScript = join(rootPath, '.git', 'count-clean.cjs')
    const counter = join(rootPath, '.git', 'clean-count')
    const asset = join(rootPath, 'payload.asset')
    await writeFile(
      filterScript,
      "const fs = require('node:fs')\nfs.appendFileSync(process.argv[2], 'x')\nprocess.stdin.pipe(process.stdout)\n",
    )
    await writeFile(counter, '')
    await writeFile(join(rootPath, '.gitattributes'), '*.asset filter=count-clean\n')
    await writeFile(asset, 'unchanged payload\n')
    git(rootPath, [
      'config',
      'filter.count-clean.clean',
      `${JSON.stringify(process.execPath)} ${JSON.stringify(filterScript)} ${JSON.stringify(counter)}`,
    ])
    git(rootPath, ['config', 'filter.count-clean.required', 'true'])
    git(rootPath, ['add', '.gitattributes', 'payload.asset'])
    git(rootPath, ['commit', '-m', 'filtered asset'])
    await writeFile(counter, '')
    const stablePast = new Date(Date.now() - 60_000)
    await utimes(asset, stablePast, stablePast)

    const actual = new LocalHost()
    const project = { host: actual, root: localPath(rootPath) }
    let callId = 0
    const proxy = {
      hostId: actual.hostId,
      exec: (command: string, args: readonly string[], opts = {}) =>
        dispatchWorkerHostCall(
          {
            kind: 'host-call',
            callId: ++callId,
            hostId: actual.hostId,
            operation: 'exec',
            command,
            args,
            ...opts,
          },
          project,
        ),
      readTextFile: (path: ReturnType<typeof localPath>) =>
        dispatchWorkerHostCall(
          {
            kind: 'host-call',
            callId: ++callId,
            hostId: actual.hostId,
            operation: 'readTextFile',
            path,
          },
          project,
        ),
    } as unknown as ProjectHost
    const engine = new GitEngine(proxy, localPath(rootPath))

    await expect(engine.workspaceActivity(localPath(rootPath))).resolves.toMatchObject({
      changedFiles: 0,
    })
    const afterFirst = (await readFile(counter, 'utf8')).length
    expect(afterFirst).toBeGreaterThan(0)
    await expect(engine.workspaceActivity(localPath(rootPath))).resolves.toMatchObject({
      changedFiles: 0,
    })

    expect((await readFile(counter, 'utf8')).length).toBe(afterFirst)
    await actual.dispose()
  })

  it('rejects unsafe check-ignore input paths', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'hvir-broker-'))
    cleanups.push(rootPath)
    const host = new LocalHost()
    const project = { host, root: localPath(rootPath) }

    await expect(
      dispatchWorkerHostCall(
        {
          ...hostCall(rootPath),
          args: ['-C', rootPath, 'check-ignore', '-z', '--stdin'],
          input: '../outside\0',
        },
        project,
      ),
    ).rejects.toThrow('unsupported execution options')
  })

  it('accepts only object-id frontiers on log stdin', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'hvir-broker-'))
    cleanups.push(rootPath)
    const host = new LocalHost()
    const project = { host, root: localPath(rootPath) }
    const call: ExecHostCall = {
      ...hostCall(rootPath),
      args: [
        '-C',
        rootPath,
        'log',
        '--topo-order',
        '--parents',
        '--boundary',
        '-n50',
        '--format=%m%x1f%H%x1f%h%x1f%P%x1f%an%x1f%aI%x1f%s%x1f%D%x1e',
        '--stdin',
        '--',
        '.',
      ],
      input: '--all\n',
    }
    await expect(dispatchWorkerHostCall(call, project)).rejects.toThrow(
      'unsupported execution options',
    )
  })

  it('aborts the host operation when the broker timeout expires', async () => {
    vi.useFakeTimers()
    const rootPath = await mkdtemp(join(tmpdir(), 'hvir-broker-timeout-'))
    cleanups.push(rootPath)
    const host = new LocalHost()
    let signal: AbortSignal | undefined
    vi.spyOn(host, 'realpath').mockResolvedValue(localPath(rootPath))
    const exec = vi.spyOn(host, 'exec').mockImplementation((_command, _args, options) => {
      signal = options?.signal
      return new Promise(() => undefined)
    })
    const pending = dispatchWorkerHostCall(hostCall(rootPath), {
      host,
      root: localPath(rootPath),
    })
    const rejected = expect(pending).rejects.toThrow('git host operation timed out')

    await vi.waitFor(() => expect(exec).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(120_001)

    expect(signal?.aborted).toBe(true)
    await rejected
  })
})

function hostCall(root: string): ExecHostCall {
  return {
    kind: 'host-call',
    callId: 1,
    hostId: 'local',
    operation: 'exec',
    command: 'git',
    args: [
      '-C',
      root,
      'status',
      '--porcelain=v2',
      '-z',
      '--untracked-files=all',
      '--',
      '.',
    ],
  }
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' })
}
