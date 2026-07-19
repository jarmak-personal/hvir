import { describe, expect, it, vi } from 'vitest'

import {
  GitSyncCoordinator,
  type GitSyncObserver,
} from '../src/renderer/src/git/git-sync-coordinator'

describe('Git sync coordinator', () => {
  it('excludes overlapping automatic and manual fetches', async () => {
    const pending = deferred<void>()
    const coordinator = new GitSyncCoordinator(() => 42)
    const observer = observers()
    const request = vi.fn(() => pending.promise)

    expect(coordinator.run('fetch', request, observer)).toBe(true)
    expect(coordinator.run('fetch', request, observer)).toBe(false)
    expect(request).toHaveBeenCalledTimes(1)
    expect(observer.started).toHaveBeenCalledTimes(1)

    pending.resolve()
    await settled()
    expect(observer.succeeded).toHaveBeenCalledWith('fetch', 1, 42)
    expect(coordinator.running()).toBe(false)
  })

  it('drops a completion from the previous workspace generation', async () => {
    const pending = deferred<void>()
    const coordinator = new GitSyncCoordinator()
    const observer = observers()
    coordinator.run('pull', () => pending.promise, observer)

    coordinator.reset()
    pending.resolve()
    await settled()
    expect(observer.succeeded).not.toHaveBeenCalled()
    expect(observer.failed).not.toHaveBeenCalled()
  })

  it('releases mutation failures so an explicit retry can succeed', async () => {
    const coordinator = new GitSyncCoordinator(() => 99)
    const observer = observers()
    coordinator.run(
      'fetch',
      () => Promise.reject(new Error('mutation authorization denied')),
      observer,
    )
    await settled()
    expect(observer.failed).toHaveBeenCalledWith(
      'fetch',
      1,
      'mutation authorization denied',
    )
    expect(coordinator.running()).toBe(false)

    expect(coordinator.run('fetch', () => Promise.resolve(), observer)).toBe(true)
    await settled()
    expect(observer.succeeded).toHaveBeenCalledWith('fetch', 2, 99)
  })
})

function observers() {
  return {
    started: vi.fn<GitSyncObserver['started']>(),
    succeeded: vi.fn<GitSyncObserver['succeeded']>(),
    failed: vi.fn<GitSyncObserver['failed']>(),
  } satisfies GitSyncObserver
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function settled(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}
