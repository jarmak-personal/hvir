import { describe, expect, it, vi } from 'vitest'

import { FilenameSearchCoordinator } from '../src/main/filename-search/filename-search-coordinator'
import type { ProjectHost } from '../src/main/project-host'
import {
  localPath,
  type DirEntry,
  type HostConnectionState,
  type HostPath,
} from '../src/shared'

const owner = { id: 7, generation: 2 }

describe('FilenameSearchCoordinator', () => {
  it('rejects stale query completion while sharing one bounded workspace scan', async () => {
    let release!: (entries: DirEntry[]) => void
    const entries = new Promise<DirEntry[]>((resolve) => {
      release = resolve
    })
    const host = fakeHost(() => entries)
    const search = coordinator()
    const first = search.search(input(host, 'alpha', 1))
    const second = search.search(input(host, 'beta', 2))
    release([
      { name: 'alpha.ts', type: 'file' },
      { name: 'beta.ts', type: 'file' },
    ])

    await expect(first).rejects.toThrow('superseded')
    await expect(second).resolves.toMatchObject({
      results: [{ name: 'beta.ts' }],
    })
    expect(host.readDirectory).toHaveBeenCalledOnce()
  })

  it('cancels owned work on revocation and host disconnect', async () => {
    const pending = new Promise<DirEntry[]>(() => undefined)
    const firstHost = fakeHost(() => pending)
    const firstCoordinator = coordinator()
    const revoked = firstCoordinator.search(input(firstHost, 'file'))
    firstCoordinator.revoke(owner)
    await expect(revoked).rejects.toThrow('superseded')

    const secondHost = fakeHost(() => pending)
    const secondCoordinator = coordinator()
    const disconnected = secondCoordinator.search(input(secondHost, 'file'))
    secondHost.disconnect()
    await expect(disconnected).rejects.toThrow('Reconnect')
  })

  it('rejects a request cancelled while root authority is still resolving', async () => {
    let resolveRoot!: (root: HostPath) => void
    const canonicalRoot = new Promise<HostPath>((resolve) => {
      resolveRoot = resolve
    })
    const host = fakeHost(() => Promise.resolve([]))
    const search = coordinator()
    const pending = search.search({ ...input(host, 'file', 5), canonicalRoot })
    search.cancel(owner, 5)
    resolveRoot(localPath('/project'))

    await expect(pending).rejects.toThrow('superseded')
    expect(host.readDirectory).not.toHaveBeenCalled()
  })

  it('does not retain cancellation state for an owner without a search', async () => {
    const host = fakeHost(() => Promise.resolve([{ name: 'file.ts', type: 'file' }]))
    const search = coordinator()
    search.cancel(owner, 5)

    await expect(search.search(input(host, 'file', 5))).resolves.toMatchObject({
      results: [{ name: 'file.ts' }],
    })
  })

  it('reports disconnected hosts as unavailable and invalidates on refresh', async () => {
    const host = fakeHost(() => Promise.resolve([{ name: 'file.ts', type: 'file' }]))
    const search = coordinator()
    await search.search(input(host, 'file', 1))
    await search.search(input(host, 'file', 2))
    expect(host.readDirectory).toHaveBeenCalledOnce()
    await search.search({ ...input(host, 'file', 3), refreshVersion: 2 })
    expect(host.readDirectory).toHaveBeenCalledTimes(2)
    host.disconnect()
    await expect(search.search(input(host, 'file', 4))).rejects.toThrow('Reconnect')
  })
})

function coordinator(): FilenameSearchCoordinator {
  return new FilenameSearchCoordinator({
    ignoredPaths: () => Promise.resolve(new Set()),
  })
}

function input(host: ProjectHost, query: string, requestId = 1) {
  const root = localPath('/project')
  return {
    owner,
    host,
    root,
    canonicalRoot: root,
    query,
    includeIgnored: false,
    gitIgnoreAvailable: false,
    refreshVersion: 1,
    requestId,
  }
}

function fakeHost(read: () => Promise<DirEntry[]>): ProjectHost & {
  readDirectory: ReturnType<typeof vi.fn<() => Promise<DirEntry[]>>>
  disconnect(): void
} {
  let connectionState: HostConnectionState = 'connected'
  const listeners = new Set<(state: HostConnectionState) => void>()
  const readDirectory = vi.fn(read)
  return {
    hostId: localPath('/').hostId,
    get connectionState() {
      return connectionState
    },
    watchTier: 'native',
    readdir: readDirectory,
    readDirectory,
    realpath: (path: HostPath) => Promise.resolve(path),
    stat: () => Promise.resolve({ type: 'file', size: 0, mtimeMs: 0, mode: 0 }),
    onConnectionState: (listener: (state: HostConnectionState) => void) => {
      listeners.add(listener)
      listener(connectionState)
      return () => listeners.delete(listener)
    },
    disconnect() {
      connectionState = 'disconnected'
      for (const listener of listeners) listener(connectionState)
    },
  } as unknown as ProjectHost & {
    readDirectory: ReturnType<typeof vi.fn<() => Promise<DirEntry[]>>>
    disconnect(): void
  }
}
