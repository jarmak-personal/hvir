import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  canonicalProjectWatchInterests,
  ProjectWatchController,
} from '../src/main/project-watch'
import type { ProjectHost, WatchOptions } from '../src/main/project-host'
import { localPath, type Disposer, type WatchEvent } from '../src/shared'

afterEach(() => {
  vi.useRealTimers()
})

describe('ProjectWatchController', () => {
  it('replaces one shallow content backend as visible interests change', async () => {
    vi.useFakeTimers()
    const watches: Array<{
      readonly path: string
      readonly receive: (event: WatchEvent) => void
      readonly options: WatchOptions
      readonly stop: ReturnType<typeof vi.fn<Disposer>>
    }> = []
    const host = fakeHost({
      watch: (path, receive, options = {}) => {
        const stop = vi.fn<Disposer>(() => undefined)
        watches.push({ path: path.path, receive, options, stop })
        return stop
      },
    })
    const emit = vi.fn()
    const refreshGit = vi.fn()
    const controller = new ProjectWatchController(
      { host, root: localPath('/project'), projectId: 'project' },
      { emit, refreshGit, repositoryEnabled: () => false },
    )

    expect(watches[0]).toMatchObject({
      path: '/project',
      options: { recursive: false, additionalPaths: [] },
    })
    controller.updateInterests([localPath('/project/src')])
    await vi.advanceTimersByTimeAsync(50)

    expect(watches[0]?.stop).toHaveBeenCalledOnce()
    expect(watches.at(-1)?.options.additionalPaths).toEqual([localPath('/project/src')])
    watches.at(-1)?.receive({
      type: 'change',
      path: localPath('/project/src/file.ts'),
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(emit).toHaveBeenCalledWith({
      type: 'change',
      path: localPath('/project/src/file.ts'),
    })
    expect(refreshGit).not.toHaveBeenCalled()

    watches.at(-1)?.receive({ type: 'addDir', path: localPath('/project/.git') })
    expect(refreshGit).toHaveBeenCalledOnce()
    await controller.dispose()
    expect(watches.at(-1)?.stop).toHaveBeenCalledOnce()
  })

  it('keeps the Git metadata backend alive while content interests restart', async () => {
    vi.useFakeTimers()
    const stops: ReturnType<typeof vi.fn<Disposer>>[] = []
    const watch = vi.fn<ProjectHost['watch']>((_path, _receive, _options = {}) => {
      const stop = vi.fn<Disposer>(() => undefined)
      stops.push(stop)
      return stop
    })
    const host = fakeHost({
      watch,
      exec: () =>
        Promise.resolve({
          code: 0,
          signal: null,
          stdout: '/project/.git\n',
          stderr: '',
        }),
    })
    const controller = new ProjectWatchController(
      { host, root: localPath('/project'), projectId: 'project' },
      {
        emit: () => undefined,
        refreshGit: () => undefined,
        repositoryEnabled: () => true,
      },
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(watch).toHaveBeenCalledTimes(2)

    controller.updateInterests([localPath('/project/src')])
    await vi.advanceTimersByTimeAsync(50)

    expect(watch).toHaveBeenCalledTimes(3)
    expect(stops[0]).toHaveBeenCalledOnce()
    expect(stops[1]).not.toHaveBeenCalled()
    await controller.dispose()
    expect(stops[1]).toHaveBeenCalledOnce()
    expect(stops[2]).toHaveBeenCalledOnce()
  })

  it('retries Git discovery when git init races the startup probe', async () => {
    let finishProbe:
      | ((result: { code: number; signal: null; stdout: string; stderr: string }) => void)
      | undefined
    const firstProbe = new Promise<{
      code: number
      signal: null
      stdout: string
      stderr: string
    }>((resolve) => {
      finishProbe = resolve
    })
    const receivers: Array<(event: WatchEvent) => void> = []
    const exec = vi
      .fn<ProjectHost['exec']>()
      .mockReturnValueOnce(firstProbe)
      .mockResolvedValue({
        code: 0,
        signal: null,
        stdout: '/project/.git\n',
        stderr: '',
      })
    const host = fakeHost({
      exec,
      watch: (_path, receive) => {
        receivers.push(receive)
        return () => undefined
      },
    })
    const controller = new ProjectWatchController(
      { host, root: localPath('/project'), projectId: 'project' },
      {
        emit: () => undefined,
        refreshGit: () => undefined,
        repositoryEnabled: () => false,
      },
    )

    receivers[0]?.({ type: 'addDir', path: localPath('/project/.git') })
    finishProbe?.({ code: 1, signal: null, stdout: '', stderr: '' })
    await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(receivers).toHaveLength(2))

    await controller.dispose()
  })
})

describe('canonicalProjectWatchInterests', () => {
  it('deduplicates, caps, and rejects canonical escapes', async () => {
    const host = fakeHost()
    const realpath = vi.spyOn(host, 'realpath')
    const cache = new Map()
    await expect(
      canonicalProjectWatchInterests(
        host,
        localPath('/project'),
        [localPath('/project/a'), localPath('/project/a'), localPath('/project/b')],
        1,
        cache,
      ),
    ).resolves.toEqual({ paths: [localPath('/project/a')], limited: true })
    await canonicalProjectWatchInterests(
      host,
      localPath('/project'),
      [localPath('/project/a')],
      1,
      cache,
    )
    expect(realpath).toHaveBeenCalledTimes(2)

    const escaping = fakeHost({
      realpath: (path) =>
        Promise.resolve(path.path.endsWith('/link') ? localPath('/outside') : path),
    })
    await expect(
      canonicalProjectWatchInterests(
        escaping,
        localPath('/project'),
        [localPath('/project/link')],
        128,
      ),
    ).rejects.toThrow('Canonical watch interest escapes')
    await expect(
      canonicalProjectWatchInterests(
        host,
        localPath('/project'),
        [localPath('/sibling')],
        128,
      ),
    ).rejects.toThrow('escapes the active workspace')
  })
})

function fakeHost(overrides: Partial<ProjectHost> = {}): ProjectHost {
  return {
    hostId: localPath('/').hostId,
    connectionState: 'connected',
    watchTier: 'native',
    connect: () => Promise.resolve(),
    dispose: () => Promise.resolve(),
    onConnectionState: () => () => undefined,
    defaultShell: () => Promise.resolve('/bin/sh'),
    exec: () => Promise.resolve({ code: 1, signal: null, stdout: '', stderr: '' }),
    realpath: (path) => Promise.resolve(path),
    stat: () => Promise.resolve({ type: 'dir', size: 0, mtimeMs: 0, mode: 0o040755 }),
    watch: () => () => undefined,
    ...overrides,
  } as ProjectHost
}
