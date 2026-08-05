import { describe, expect, it, vi } from 'vitest'

import {
  ProjectFileOperationCoordinator,
  type ExternalFileGrantRegistry,
  type ProjectFileOperationResourcePort,
  type ProjectFileWorkspaceAuthority,
} from '../src/main/project-file-operations'
import {
  ProjectPathExistsError,
  type ExclusiveCreateOptions,
  type ProjectHost,
} from '../src/main/project-host'
import {
  isProjectFileEntryName,
  localPath,
  type HostConnectionState,
  type HostPath,
  type Stat,
} from '../src/shared'

const owner = { id: 7, generation: 3 }
const workspaceRoot = localPath('/workspace')
const canonicalRoot = localPath('/canonical')
const destinationDirectory = localPath('/workspace/src')

describe('project file create policy', () => {
  it.each(['', '.', '..', 'a/b', 'a\\b', `a\0b`])(
    'rejects invalid single-entry name %j',
    (name) => expect(isProjectFileEntryName(name)).toBe(false),
  )

  it.each([' file ', '.env', 'a..b'])(
    'retains an exact valid single-entry name %j',
    (name) => expect(isProjectFileEntryName(name)).toBe(true),
  )
})

describe('ProjectFileOperationCoordinator', () => {
  it('creates one exclusive empty file with an immutable lexical destination', async () => {
    const fixture = createFixture()

    const result = await fixture.coordinator.create({
      owner,
      workspaceRoot,
      destinationDirectory,
      name: 'new.txt',
      kind: 'file',
    })

    expect(result).toMatchObject({
      outcome: 'completed',
      operationId: 'operation-1',
      generation: 1,
      items: [
        {
          destination: localPath('/workspace/src/new.txt'),
          status: 'completed',
          effect: 'created-file',
        },
      ],
    })
    expect(fixture.host.createdFiles).toEqual([
      { path: localPath('/canonical/src/new.txt'), mode: 0o644 },
    ])
    expect(fixture.resources.active.size).toBe(0)
  })

  it('creates one exclusive empty directory with the approved mode', async () => {
    const fixture = createFixture()

    const result = await fixture.coordinator.create({
      owner,
      workspaceRoot,
      destinationDirectory,
      name: 'new-dir',
      kind: 'directory',
    })

    expect(result).toMatchObject({
      items: [{ status: 'completed', effect: 'created-directory' }],
    })
    expect(fixture.host.createdDirectories).toEqual([
      { path: localPath('/canonical/src/new-dir'), mode: 0o755 },
    ])
  })

  it('reports an existing destination as a conflict without changing it', async () => {
    const fixture = createFixture()
    fixture.host.entries.set('/canonical/src/existing.txt', fileStat(4))

    const result = await fixture.coordinator.create({
      owner,
      workspaceRoot,
      destinationDirectory,
      name: 'existing.txt',
      kind: 'file',
    })

    expect(result).toMatchObject({
      items: [{ status: 'conflicted', effect: 'none' }],
    })
    expect(fixture.host.createdFiles).toEqual([])
    expect(fixture.host.entries.get('/canonical/src/existing.txt')).toEqual(fileStat(4))
  })

  it('closes the race with an exclusive-create collision', async () => {
    const fixture = createFixture()
    fixture.host.createFailure = new ProjectPathExistsError()

    const result = await fixture.coordinator.create({
      owner,
      workspaceRoot,
      destinationDirectory,
      name: 'raced.txt',
      kind: 'file',
    })

    expect(result).toMatchObject({
      items: [{ status: 'conflicted', effect: 'none' }],
    })
  })

  it('never traverses a symbolic-link destination parent', async () => {
    const fixture = createFixture()
    fixture.host.entries.set('/canonical/linked', symlinkStat())

    const result = await fixture.coordinator.create({
      owner,
      workspaceRoot,
      destinationDirectory: localPath('/workspace/linked'),
      name: 'escaped.txt',
      kind: 'file',
    })

    expect(result).toMatchObject({
      items: [{ status: 'failed', effect: 'none' }],
    })
    expect(fixture.host.createdFiles).toEqual([])
  })

  it('cancels before the effect when renderer ownership is revoked during validation', async () => {
    const gate = deferred<void>()
    const fixture = createFixture()
    fixture.host.statGate = { path: '/canonical/src', ...gate }
    const result = fixture.coordinator.create({
      owner,
      workspaceRoot,
      destinationDirectory,
      name: 'late.txt',
      kind: 'file',
    })
    await gate.started

    fixture.resources.revokeAll()
    gate.resolve()

    await expect(result).resolves.toMatchObject({
      items: [{ status: 'cancelled', effect: 'none' }],
    })
    expect(fixture.host.createdFiles).toEqual([])
  })

  it('fails closed when the snapshotted workspace authority is replaced', async () => {
    const gate = deferred<void>()
    const fixture = createFixture()
    fixture.host.statGate = { path: '/canonical/src', ...gate }
    const result = fixture.coordinator.create({
      owner,
      workspaceRoot,
      destinationDirectory,
      name: 'retired.txt',
      kind: 'file',
    })
    await gate.started

    fixture.authority = {
      ...fixture.authority!,
      workspaceId: 'replacement-workspace',
    }
    gate.resolve()

    await expect(result).resolves.toMatchObject({
      items: [{ status: 'cancelled', effect: 'none' }],
    })
    expect(fixture.host.createdFiles).toEqual([])
  })

  it('aborts a late host primitive and removes its unpublished effect on disconnect', async () => {
    const gate = deferred<void>()
    const fixture = createFixture()
    fixture.host.createGate = gate
    const result = fixture.coordinator.create({
      owner,
      workspaceRoot,
      destinationDirectory,
      name: 'disconnected.txt',
      kind: 'file',
    })
    await gate.started

    fixture.host.setConnectionState('disconnected')
    gate.resolve()

    await expect(result).resolves.toMatchObject({
      items: [{ status: 'cancelled', effect: 'none' }],
    })
    expect(fixture.host.createdFiles).toEqual([])
  })

  it('aborts an operation at its owned deadline before publication', async () => {
    vi.useFakeTimers()
    try {
      const gate = deferred<void>()
      const fixture = createFixture({ deadlineMs: 50 })
      fixture.host.createGate = gate
      const result = fixture.coordinator.create({
        owner,
        workspaceRoot,
        destinationDirectory,
        name: 'deadline.txt',
        kind: 'file',
      })
      await gate.started

      await vi.advanceTimersByTimeAsync(50)
      gate.resolve()

      await expect(result).resolves.toMatchObject({
        items: [
          {
            status: 'cancelled',
            effect: 'none',
            reason: 'The project file operation reached its deadline',
          },
        ],
      })
      expect(fixture.host.createdFiles).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns visible busy without queueing a second workspace operation', async () => {
    const gate = deferred<void>()
    const fixture = createFixture()
    fixture.host.createGate = gate
    const first = fixture.coordinator.create({
      owner,
      workspaceRoot,
      destinationDirectory,
      name: 'first.txt',
      kind: 'file',
    })
    await gate.started

    await expect(
      fixture.coordinator.create({
        owner,
        workspaceRoot,
        destinationDirectory,
        name: 'second.txt',
        kind: 'file',
      }),
    ).resolves.toMatchObject({
      outcome: 'busy',
      reason: 'Another file operation is already active for this workspace',
      items: [],
    })
    gate.resolve()
    await expect(first).resolves.toMatchObject({
      items: [{ status: 'completed' }],
    })
  })

  it('reports the distinct application-wide limit across workspaces', async () => {
    const resources = new FakeResources()
    const roots = ['/one', '/two', '/three'].map((path) => localPath(path))
    const hosts = roots.map(
      (root, index) => new FakeProjectHost(root, localPath(`/canonical-${index + 1}`)),
    )
    const gates = [deferred<void>(), deferred<void>()]
    hosts[0]!.createGate = gates[0]
    hosts[1]!.createGate = gates[1]
    let nextOperationId = 0
    const coordinator = new ProjectFileOperationCoordinator({
      resolveWorkspace: (root) => {
        const index = roots.findIndex((candidate) => candidate.path === root.path)
        return index < 0
          ? undefined
          : {
              projectId: `project-${index + 1}`,
              workspaceId: `workspace-${index + 1}`,
              root: roots[index]!,
              host: hosts[index]! as unknown as ProjectHost,
            }
      },
      resources,
      createOperationId: () => `operation-${(nextOperationId += 1)}`,
    })
    const first = coordinator.create({
      owner,
      workspaceRoot: roots[0]!,
      destinationDirectory: localPath('/one/src'),
      name: 'first.txt',
      kind: 'file',
    })
    const second = coordinator.create({
      owner,
      workspaceRoot: roots[1]!,
      destinationDirectory: localPath('/two/src'),
      name: 'second.txt',
      kind: 'file',
    })
    await Promise.all(gates.map((gate) => gate.started))

    await expect(
      coordinator.create({
        owner,
        workspaceRoot: roots[2]!,
        destinationDirectory: localPath('/three/src'),
        name: 'third.txt',
        kind: 'file',
      }),
    ).resolves.toMatchObject({
      outcome: 'busy',
      reason: 'The application-wide file operation limit is currently in use',
      items: [],
    })
    gates.forEach((gate) => gate.resolve())
    await Promise.all([first, second])
  })

  it('returns the start identity before a fast batch can publish progress', async () => {
    const fixture = createCopyFixture()
    const events: unknown[] = []

    const started = await fixture.coordinator.copyExternal({
      owner,
      workspaceRoot,
      destinationDirectory,
      grantId: 'grant-1',
      grantGeneration: 1,
      publish: (event) => events.push(event),
    })

    expect(started).toMatchObject({ outcome: 'started', operationId: 'operation-1' })
    expect(events).toEqual([])
    await nextTurn()
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: 'completed', operationId: 'operation-1' }),
      ]),
    )
  })

  it('suppresses progress and final events after renderer generation revocation', async () => {
    const fixture = createCopyFixture()
    const publish = vi.fn()
    await fixture.coordinator.copyExternal({
      owner,
      workspaceRoot,
      destinationDirectory,
      grantId: 'grant-1',
      grantGeneration: 1,
      publish,
    })

    fixture.resources.current = false
    await nextTurn()

    expect(publish).not.toHaveBeenCalled()
  })

  it('awaits a delayed launch when disposed before the next turn', async () => {
    const fixture = createCopyFixture()
    await fixture.coordinator.copyExternal({
      owner,
      workspaceRoot,
      destinationDirectory,
      grantId: 'grant-1',
      grantGeneration: 1,
      publish: () => undefined,
    })

    await fixture.coordinator.dispose()

    expect(fixture.resources.active.size).toBe(0)
    expect(fixture.external.revoked).toBe(true)
  })
})

function createCopyFixture() {
  const host = new FakeProjectHost()
  const resources = new FakeResources()
  const external = {
    revoked: false,
    consume: () => ({
      grantId: 'grant-1',
      generation: 1,
      owner,
      items: [
        {
          itemId: 'external:0',
          name: 'unsupported',
          type: 'unsupported' as const,
          reason: 'unsupported for test',
        },
      ],
      source: () => {
        throw new Error('unsupported item has no source')
      },
      assertCurrent: () => undefined,
      revoke: () => {
        external.revoked = true
      },
    }),
    dispose: () => undefined,
  }
  const coordinator = new ProjectFileOperationCoordinator({
    resolveWorkspace: (root) =>
      root.path === workspaceRoot.path
        ? {
            projectId: 'project-1',
            workspaceId: 'workspace-1',
            root: workspaceRoot,
            host: host as unknown as ProjectHost,
          }
        : undefined,
    resources,
    externalFiles: external as unknown as ExternalFileGrantRegistry,
    createOperationId: () => 'operation-1',
  })
  return { coordinator, external, resources }
}

function createFixture(options: { readonly deadlineMs?: number } = {}) {
  const host = new FakeProjectHost()
  const resources = new FakeResources()
  let authority: ProjectFileWorkspaceAuthority | undefined = {
    projectId: 'project-1',
    workspaceId: 'workspace-1',
    root: workspaceRoot,
    host: host as unknown as ProjectHost,
  }
  const coordinator = new ProjectFileOperationCoordinator({
    resolveWorkspace: (root) =>
      authority && root.path === workspaceRoot.path ? authority : undefined,
    resources,
    createOperationId: () => 'operation-1',
    ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
  })
  return {
    coordinator,
    host,
    resources,
    get authority() {
      return authority
    },
    set authority(value: ProjectFileWorkspaceAuthority | undefined) {
      authority = value
    },
  }
}

class FakeResources implements ProjectFileOperationResourcePort {
  current = true
  readonly active = new Set<() => void>()

  isRendererCurrent(): boolean {
    return this.current
  }

  registerOperation(
    _owner: typeof owner,
    _root: HostPath,
    _operationId: string,
    revoke: () => void,
  ) {
    this.active.add(revoke)
    return { release: () => this.active.delete(revoke) }
  }

  revokeAll(): void {
    this.current = false
    for (const revoke of this.active) revoke()
    this.active.clear()
  }
}

class FakeProjectHost {
  readonly hostId: HostPath['hostId']
  private state: HostConnectionState = 'connected'
  private readonly listeners = new Set<(state: HostConnectionState) => void>()
  readonly entries: Map<string, Stat>
  readonly createdFiles: Array<{ path: HostPath; mode: number }> = []
  readonly createdDirectories: Array<{ path: HostPath; mode: number }> = []
  createFailure?: Error
  createGate?: ReturnType<typeof deferred<void>>
  statGate?: ReturnType<typeof deferred<void>> & { readonly path: string }

  constructor(
    private readonly root = workspaceRoot,
    private readonly canonical = canonicalRoot,
  ) {
    this.hostId = root.hostId
    this.entries = new Map([
      [canonical.path, directoryStat()],
      [`${canonical.path}/src`, directoryStat()],
    ])
  }

  get connectionState(): HostConnectionState {
    return this.state
  }

  onConnectionState(callback: (state: HostConnectionState) => void) {
    this.listeners.add(callback)
    callback(this.state)
    return () => this.listeners.delete(callback)
  }

  setConnectionState(state: HostConnectionState): void {
    this.state = state
    for (const listener of this.listeners) listener(state)
  }

  realpath(path: HostPath): Promise<HostPath> {
    return Promise.resolve(path.path === this.root.path ? this.canonical : path)
  }

  async stat(path: HostPath): Promise<Stat> {
    if (this.statGate?.path === path.path) {
      this.statGate.start()
      await this.statGate.promise
      this.statGate = undefined
    }
    const stat = this.entries.get(path.path)
    if (!stat) throw Object.assign(new Error('no such file'), { code: 'ENOENT' })
    return stat
  }

  async createFileExclusive(
    path: HostPath,
    options: ExclusiveCreateOptions,
  ): Promise<void> {
    this.createGate?.start()
    if (this.createGate) await this.createGate.promise
    options.signal?.throwIfAborted()
    if (this.createFailure) throw this.createFailure
    this.createdFiles.push({ path, mode: options.mode })
    this.entries.set(path.path, fileStat(0))
  }

  createDirectoryExclusive(
    path: HostPath,
    options: ExclusiveCreateOptions,
  ): Promise<void> {
    options.signal?.throwIfAborted()
    if (this.createFailure) throw this.createFailure
    this.createdDirectories.push({ path, mode: options.mode })
    this.entries.set(path.path, directoryStat())
    return Promise.resolve()
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let signalStarted!: () => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  const started = new Promise<void>((done) => {
    signalStarted = done
  })
  return { promise, resolve, started, start: signalStarted }
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function directoryStat(): Stat {
  return { type: 'dir', size: 0, mtimeMs: 1, mode: 0o040755 }
}

function fileStat(size: number): Stat {
  return { type: 'file', size, mtimeMs: 1, mode: 0o100644 }
}

function symlinkStat(): Stat {
  return { type: 'symlink', size: 0, mtimeMs: 1, mode: 0o120777 }
}
