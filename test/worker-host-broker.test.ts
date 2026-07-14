import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { dispatchWorkerHostCall } from '../src/main/git/worker-host-broker'
import { GitEngine } from '../src/main/git/git-engine'
import { LocalHost, type ProjectHost } from '../src/main/project-host'
import { localPath, type WorkerHostCall } from '../src/shared'

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

  it.each([
    ['config alias execution', ['-c', 'alias.x=!touch /tmp/hvir-owned', 'x']],
    ['second working directory', ['status', '-C', '/tmp', '--porcelain=v2']],
    ['git directory override', ['--git-dir=/tmp/repo', 'status']],
    ['work tree override', ['--work-tree', '/tmp', 'status']],
    ['helper subcommand', ['credential', 'fill']],
    ['external diff option', ['diff', '--ext-diff', 'HEAD']],
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
    } as unknown as ProjectHost
    const engine = new GitEngine(proxy, localPath(rootPath))

    await expect(engine.worktrees(localPath(rootPath))).resolves.toEqual(
      expect.objectContaining({ repository: true }),
    )
    await expect(engine.changedFileCount(localPath(rootPath))).resolves.toBe(1)
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
    expect(changes.workingTree).toHaveLength(1)
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
