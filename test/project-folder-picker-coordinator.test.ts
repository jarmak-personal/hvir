import { describe, expect, it, vi } from 'vitest'

import { ProjectFolderPickerCoordinator } from '../src/main/project-folder-picker'
import {
  ProjectPathExistsError,
  type Disposer,
  type ExclusiveCreateOptions,
  type ProjectHost,
} from '../src/main/project-host'
import { RendererResourceScopes } from '../src/main/renderer-resource-scopes'
import {
  asHostId,
  hostPath,
  type BrowseHostResponse,
  type HostConnectionState,
  type HostPath,
} from '../src/shared'

describe('ProjectFolderPickerCoordinator', () => {
  it.each([
    ['local host', 'local'],
    ['SSH host', 'ssh-dev'],
  ])('creates one empty directory exclusively through the %s', async (_label, hostId) => {
    const fixture = pickerFixture(hostId)
    const lease = await fixture.coordinator.start(fixture.owner, hostId)
    await fixture.coordinator.browse(fixture.owner, lease.pickerId, '/projects')

    await expect(
      fixture.coordinator.createDirectory(
        fixture.owner,
        lease.pickerId,
        path(hostId, '/projects'),
        'new-project',
      ),
    ).resolves.toEqual(path(hostId, '/projects/new-project'))
    expect(fixture.host.created).toEqual(['/projects/new-project'])

    await fixture.coordinator.browse(fixture.owner, lease.pickerId, '/projects')
    await expect(
      fixture.coordinator.createDirectory(
        fixture.owner,
        lease.pickerId,
        path(hostId, '/projects'),
        'new-project',
      ),
    ).rejects.toThrow('The destination already exists')
    expect(fixture.host.created).toEqual(['/projects/new-project'])
  })

  it.each(['', '.', '..', 'a/b', 'a\\b', `a\0b`])(
    'rejects invalid one-segment name %j before touching the host',
    async (name) => {
      const fixture = pickerFixture('local')
      const lease = await fixture.coordinator.start(fixture.owner, 'local')

      await expect(
        fixture.coordinator.createDirectory(
          fixture.owner,
          lease.pickerId,
          path('local', '/projects'),
          name,
        ),
      ).rejects.toThrow('Invalid directory name')
      expect(fixture.host.createDirectoryExclusive).not.toHaveBeenCalled()
    },
  )

  it('binds creation to the exact canonical parent selected through the picker', async () => {
    const fixture = pickerFixture('local')
    const lease = await fixture.coordinator.start(fixture.owner, 'local')

    await expect(
      fixture.coordinator.createDirectory(
        fixture.owner,
        lease.pickerId,
        path('ssh-dev', '/projects'),
        'wrong-host',
      ),
    ).rejects.toThrow('Invalid destination folder')
    await expect(
      fixture.coordinator.createDirectory(
        fixture.owner,
        lease.pickerId,
        path('local', '/projects'),
        'before-selection',
      ),
    ).rejects.toThrow('Select the destination folder again')

    fixture.host.aliases.set('/alias', '/projects')
    await expect(
      fixture.coordinator.browse(fixture.owner, lease.pickerId, '/alias'),
    ).resolves.toMatchObject({ path: path('local', '/projects') })
    await expect(
      fixture.coordinator.createDirectory(
        fixture.owner,
        lease.pickerId,
        path('local', '/alias'),
        'through-alias',
      ),
    ).rejects.toThrow('Select the destination folder again')
    await expect(
      fixture.coordinator.createDirectory(
        fixture.owner,
        lease.pickerId,
        path('local', '/projects'),
        'canonical-selection',
      ),
    ).resolves.toEqual(path('local', '/projects/canonical-selection'))
    expect(fixture.host.created).toEqual(['/projects/canonical-selection'])
  })

  it('aborts and rolls back an in-flight create when picker authority is revoked', async () => {
    const fixture = pickerFixture('local')
    const lease = await fixture.coordinator.start(fixture.owner, 'local')
    await fixture.coordinator.browse(fixture.owner, lease.pickerId, '/projects')
    let started!: () => void
    const createStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    let createSignal: AbortSignal | undefined
    fixture.host.createDirectoryExclusive.mockImplementationOnce(
      async (destination, options) => {
        createSignal = options.signal
        options.signal?.throwIfAborted()
        fixture.host.entries.add(destination.path)
        fixture.host.created.push(destination.path)
        started()
        try {
          await aborted(options.signal)
        } catch (reason) {
          fixture.host.entries.delete(destination.path)
          fixture.host.created.splice(fixture.host.created.indexOf(destination.path), 1)
          throw reason
        }
      },
    )

    const create = fixture.coordinator.createDirectory(
      fixture.owner,
      lease.pickerId,
      path('local', '/projects'),
      'revoked',
    )
    await createStarted
    await expect(
      fixture.coordinator.browse(fixture.owner, lease.pickerId, '/projects'),
    ).rejects.toThrow('already being created')
    await fixture.coordinator.close(fixture.owner, lease.pickerId)

    await expect(create).rejects.toThrow('no longer active')
    expect(createSignal?.aborted).toBe(true)
    expect(fixture.host.entries.has('/projects/revoked')).toBe(false)
    expect(fixture.host.created).toEqual([])
  })

  it('revokes authority on picker replacement, close, host change, and renderer change', async () => {
    const fixture = pickerFixture('ssh-dev')
    const first = await fixture.coordinator.start(fixture.owner, 'ssh-dev')
    const second = await fixture.coordinator.start(fixture.owner, 'ssh-dev')
    await expect(
      fixture.coordinator.browse(fixture.owner, first.pickerId, '/projects'),
    ).rejects.toThrow('no longer active')

    await fixture.coordinator.close(fixture.owner, second.pickerId)
    await expect(
      fixture.coordinator.browse(fixture.owner, second.pickerId, '/projects'),
    ).rejects.toThrow('no longer active')

    const disconnected = await fixture.coordinator.start(fixture.owner, 'ssh-dev')
    fixture.host.setConnectionState('disconnected')
    await expect(
      fixture.coordinator.browse(fixture.owner, disconnected.pickerId, '/projects'),
    ).rejects.toThrow('no longer active')

    fixture.host.setConnectionState('connected')
    const replaced = await fixture.coordinator.start(fixture.owner, 'ssh-dev')
    fixture.projects.current = new FakeHost('ssh-dev')
    await expect(
      fixture.coordinator.createDirectory(
        fixture.owner,
        replaced.pickerId,
        path('ssh-dev', '/projects'),
        'stale',
      ),
    ).rejects.toThrow('no longer active')

    fixture.projects.current = fixture.host
    const renderer = await fixture.coordinator.start(fixture.owner, 'ssh-dev')
    await fixture.resources.rolloverOwner(fixture.owner.id).cleanup
    await expect(
      fixture.coordinator.browse(fixture.owner, renderer.pickerId, '/projects'),
    ).rejects.toThrow('revoked')
  })

  it('rejects a late browse after the picker closes', async () => {
    const fixture = pickerFixture('local')
    let resolveBrowse!: (response: BrowseHostResponse) => void
    fixture.projects.browse = vi.fn(
      () =>
        new Promise<BrowseHostResponse>((resolve) => {
          resolveBrowse = resolve
        }),
    )
    const lease = await fixture.coordinator.start(fixture.owner, 'local')
    const browse = fixture.coordinator.browse(fixture.owner, lease.pickerId, '/projects')
    await fixture.coordinator.close(fixture.owner, lease.pickerId)
    resolveBrowse({ path: path('local', '/projects'), directories: [] })

    await expect(browse).rejects.toThrow('no longer active')
  })

  it('surfaces missing, inaccessible, and create failures without changing entries', async () => {
    const fixture = pickerFixture('ssh-dev')
    const lease = await fixture.coordinator.start(fixture.owner, 'ssh-dev')
    await fixture.coordinator.browse(fixture.owner, lease.pickerId, '/projects')
    fixture.projects.browse = vi.fn(() =>
      Promise.reject(new Error('Cannot access folder')),
    )
    await expect(
      fixture.coordinator.browse(fixture.owner, lease.pickerId, '/private'),
    ).rejects.toThrow('Cannot access folder')
    await expect(
      fixture.coordinator.createDirectory(
        fixture.owner,
        lease.pickerId,
        path('ssh-dev', '/projects'),
        'after-failed-selection',
      ),
    ).rejects.toThrow('Select the destination folder again')
    expect(fixture.host.createDirectoryExclusive).not.toHaveBeenCalled()

    fixture.projects.browse = vi.fn((requestedHostId, requestedPath) =>
      fixture.host.browse(requestedHostId, requestedPath),
    )
    await fixture.coordinator.browse(fixture.owner, lease.pickerId, '/projects')
    fixture.host.createDirectoryExclusive.mockRejectedValueOnce(
      new Error('SSH connection lost'),
    )
    await expect(
      fixture.coordinator.createDirectory(
        fixture.owner,
        lease.pickerId,
        path('ssh-dev', '/projects'),
        'failed',
      ),
    ).rejects.toThrow('SSH connection lost')
    expect(fixture.host.entries.has('/projects/failed')).toBe(false)
  })
})

function pickerFixture(hostId: string) {
  const resources = new RendererResourceScopes()
  const owner = resources.activateOwner(7)
  const host = new FakeHost(hostId)
  const projects = {
    current: host,
    browse: vi.fn((requestedHostId: string, requestedPath: string) =>
      host.browse(requestedHostId, requestedPath),
    ),
    hostById(requestedHostId: string): ProjectHost | undefined {
      return this.current.hostId === requestedHostId
        ? (this.current as unknown as ProjectHost)
        : undefined
    },
    browseHost(requestedHostId: string, requestedPath: string) {
      return this.browse(requestedHostId, requestedPath)
    },
  }
  return {
    resources,
    owner,
    host,
    projects,
    coordinator: new ProjectFolderPickerCoordinator(projects, resources),
  }
}

class FakeHost {
  readonly aliases = new Map<string, string>()
  readonly entries = new Set(['/projects'])
  readonly created: string[] = []
  readonly listeners = new Set<(state: HostConnectionState) => void>()
  connectionState: HostConnectionState = 'connected'
  readonly hostId
  readonly createDirectoryExclusive = vi.fn(
    (destination: HostPath, options: ExclusiveCreateOptions): Promise<void> => {
      options.signal?.throwIfAborted()
      if (this.entries.has(destination.path)) throw new ProjectPathExistsError()
      this.entries.add(destination.path)
      this.created.push(destination.path)
      options.onCreated?.()
      try {
        options.signal?.throwIfAborted()
      } catch (reason) {
        this.entries.delete(destination.path)
        this.created.splice(this.created.indexOf(destination.path), 1)
        throw reason
      }
      return Promise.resolve()
    },
  )

  constructor(hostId: string) {
    this.hostId = asHostId(hostId)
  }

  onConnectionState(listener: (state: HostConnectionState) => void): Disposer {
    this.listeners.add(listener)
    listener(this.connectionState)
    return () => {
      this.listeners.delete(listener)
    }
  }

  setConnectionState(state: HostConnectionState): void {
    this.connectionState = state
    for (const listener of this.listeners) listener(state)
  }

  realpath(candidate: HostPath): Promise<HostPath> {
    const resolved = this.aliases.get(candidate.path) ?? candidate.path
    if (!this.entries.has(resolved)) return Promise.reject(new Error('Folder not found'))
    return Promise.resolve(path(this.hostId, resolved))
  }

  stat(_candidate: HostPath) {
    return Promise.resolve({ type: 'dir' as const, size: 0, mtimeMs: 0, mode: 0o755 })
  }

  browse(requestedHostId: string, requestedPath: string): Promise<BrowseHostResponse> {
    const resolved = this.aliases.get(requestedPath) ?? requestedPath
    if (requestedHostId !== this.hostId || !this.entries.has(resolved)) {
      return Promise.reject(new Error('Folder not found'))
    }
    return Promise.resolve({ path: path(this.hostId, resolved), directories: [] })
  }
}

function aborted(signal: AbortSignal | undefined): Promise<never> {
  if (!signal) return Promise.reject(new Error('Missing abort signal'))
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(abortReason(signal)), {
      once: true,
    })
  })
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Create was aborted')
}

function path(hostId: string, value: string): HostPath {
  return hostPath(asHostId(hostId), value)
}
