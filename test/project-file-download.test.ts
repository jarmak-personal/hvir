import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalHost, type ProjectHost } from '../src/main/project-host'
import {
  ProjectFileOperationCoordinator,
  PROJECT_FILE_COPY_LIMITS,
} from '../src/main/project-file-operations'
import { acquireDownloadDestination } from '../src/main/project-file-operations/download-destination-grant'
import { createElectronDownloadDirectoryPicker } from '../src/main/project-file-operations/electron-download-picker'
import {
  asHostId,
  hostPath,
  localPath,
  type HostPath,
  type HostConnectionState,
  type ProjectFileOperationProgress,
  type ProjectFileOperationResult,
} from '../src/shared'

const owner = { id: 17, generation: 3 }
const remoteId = asHostId('ssh:download-fixture')
let directory: string
let local: LocalHost
let coordinator: ProjectFileOperationCoordinator | undefined

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'hvir-download-'))
  local = new LocalHost()
  await mkdir(join(directory, 'remote'))
  await mkdir(join(directory, 'destination'))
  await writeFile(join(directory, 'remote', 'file.txt'), 'remote bytes')
})
afterEach(async () => {
  await coordinator?.dispose()
  coordinator = undefined
  await local.dispose()
  await rm(directory, { recursive: true, force: true })
})

function fixture(options: { readonly maxEntries?: number } = {}) {
  let current = true
  let open = true
  let connection: HostConnectionState = 'connected'
  const revokers = new Set<() => void>()
  const connectionListeners = new Set<(state: HostConnectionState) => void>()
  const remotePath = (relative: string) =>
    hostPath(remoteId, join(directory, 'remote', relative))
  const translate = (path: HostPath) => {
    if (path.hostId !== remoteId) throw new Error('wrong remote host')
    return localPath(path.path)
  }
  const remote = {
    hostId: remoteId,
    get connectionState() {
      return connection
    },
    realpath: async (path: HostPath) =>
      hostPath(remoteId, (await local.realpath(translate(path))).path),
    stat: (path: HostPath) => local.stat(translate(path)),
    readdir: (path: HostPath) => local.readdir(translate(path)),
    fileTransfer: {
      readFileChunks: (path: HostPath, opts: { readonly signal?: AbortSignal }) =>
        local.fileTransfer.readFileChunks(translate(path), opts),
    },
    onConnectionState(listener: (state: HostConnectionState) => void) {
      connectionListeners.add(listener)
      return () => {
        connectionListeners.delete(listener)
      }
    },
  } as unknown as ProjectHost
  const root = remotePath('')
  const picker = {
    pick: vi
      .fn<() => Promise<string | undefined>>()
      .mockResolvedValue(join(directory, 'destination')),
  }
  coordinator = new ProjectFileOperationCoordinator({
    localHost: local,
    downloadPicker: picker,
    resolveWorkspace: () =>
      open ? { projectId: 'p', workspaceId: 'w', root, host: remote } : undefined,
    resources: {
      isRendererCurrent: () => current,
      registerOperation(_owner, _root, _id, revoke) {
        revokers.add(revoke)
        return {
          release: () => {
            revokers.delete(revoke)
          },
        }
      },
    },
    ...(options.maxEntries === undefined
      ? {}
      : {
          copyLimits: { ...PROJECT_FILE_COPY_LIMITS, maxEntries: options.maxEntries },
        }),
    createStagingId: () => 'owned-download-stage',
  })
  const events: ProjectFileOperationProgress[] = []
  let settle: (result: ProjectFileOperationResult) => void
  const result = new Promise<ProjectFileOperationResult>((resolve) => {
    settle = resolve
  })
  return {
    root,
    remote,
    remotePath,
    picker,
    result,
    events,
    start: (name = 'file.txt') =>
      coordinator!.download({
        owner,
        workspaceRoot: root,
        source: remotePath(name),
        publish(event) {
          events.push(event)
          if (event.result) settle(event.result)
        },
      }),
    revoke() {
      current = false
      for (const revoke of revokers) revoke()
    },
    close() {
      open = false
      for (const revoke of revokers) revoke()
    },
    disconnect() {
      connection = 'disconnected'
      for (const listener of connectionListeners) listener(connection)
    },
  }
}

async function item(f: ReturnType<typeof fixture>) {
  const result = await f.result
  if (result.outcome !== 'completed') throw new Error('download did not settle')
  return result.items[0]!
}

describe('SSH downloads through the project-file coordinator', () => {
  it('downloads immediately after one folder choice, preserving bytes, source, mode, and mtime', async () => {
    const f = fixture()
    await chmod(join(directory, 'remote', 'file.txt'), 0o751)
    await utimes(join(directory, 'remote', 'file.txt'), 1700000000, 1700000000)
    expect(await f.start()).toMatchObject({ outcome: 'started' })
    expect(await item(f)).toMatchObject({
      status: 'completed',
      effect: 'copied-file',
      sourceDisposition: { outcome: 'retained' },
    })
    expect(f.picker.pick).toHaveBeenCalledTimes(1)
    expect(await readFile(join(directory, 'destination', 'file.txt'), 'utf8')).toBe(
      'remote bytes',
    )
    expect(await readFile(join(directory, 'remote', 'file.txt'), 'utf8')).toBe(
      'remote bytes',
    )
    const metadata = await stat(join(directory, 'destination', 'file.txt'))
    expect(metadata.mode & 0o777).toBe(0o755)
    expect(metadata.mtimeMs).toBe(1700000000000)
    expect(await readdir(join(directory, 'destination'))).toEqual(['file.txt'])
    expect(f.events.some((event) => event.phase === 'downloading')).toBe(true)
  })

  it('copies a bounded directory tree and preserves directory metadata', async () => {
    const f = fixture()
    await mkdir(join(directory, 'remote', 'tree', 'nested'), { recursive: true })
    await writeFile(
      join(directory, 'remote', 'tree', 'nested', 'data'),
      new Uint8Array([0, 255, 3]),
    )
    await utimes(join(directory, 'remote', 'tree'), 1700000123, 1700000123)
    await f.start('tree')
    expect(await item(f)).toMatchObject({
      status: 'completed',
      effect: 'copied-directory',
    })
    expect(
      await readFile(join(directory, 'destination', 'tree', 'nested', 'data')),
    ).toEqual(Buffer.from([0, 255, 3]))
    expect((await stat(join(directory, 'destination', 'tree'))).mtimeMs).toBe(
      1700000123000,
    )
    expect(await readFile(join(directory, 'remote', 'tree', 'nested', 'data'))).toEqual(
      Buffer.from([0, 255, 3]),
    )
  })

  it('leaves existing entries unchanged and reports a conflict', async () => {
    const f = fixture()
    await writeFile(join(directory, 'destination', 'file.txt'), 'existing')
    await f.start()
    expect(await item(f)).toMatchObject({ status: 'conflicted', effect: 'none' })
    expect(await readFile(join(directory, 'destination', 'file.txt'), 'utf8')).toBe(
      'existing',
    )
  })

  it('does nothing when the native picker is cancelled and releases capacity', async () => {
    const f = fixture()
    f.picker.pick.mockResolvedValueOnce(undefined)
    expect(await f.start()).toEqual({ outcome: 'cancelled' })
    expect(await readdir(join(directory, 'destination'))).toEqual([])
    expect(await f.start()).toMatchObject({ outcome: 'started' })
    expect(await item(f)).toMatchObject({ status: 'completed' })
  })

  it.each(['revoke', 'close', 'disconnect'] as const)(
    'rejects late picker completion after %s',
    async (retire) => {
      const f = fixture()
      f.picker.pick.mockImplementationOnce(() => {
        f[retire]()
        return Promise.resolve(join(directory, 'destination'))
      })
      await expect(f.start()).rejects.toThrow()
      expect(await readdir(join(directory, 'destination'))).toEqual([])
    },
  )

  it.each(['cancel', 'close', 'disconnect'] as const)(
    'prevents staging publication after %s during streaming',
    async (retire) => {
      const f = fixture()
      const read = f.remote.fileTransfer!.readFileChunks.bind(f.remote.fileTransfer)
      f.remote.fileTransfer!.readFileChunks = async function* (path, opts) {
        for await (const chunk of read(path, opts)) {
          yield chunk
          if (retire === 'cancel')
            coordinator!.cancel(owner, f.events[0]!.operationId, f.events[0]!.generation)
          else f[retire]()
        }
      }
      await f.start()
      expect(await item(f)).toMatchObject({ status: 'cancelled', effect: 'none' })
      expect(await readdir(join(directory, 'destination'))).toEqual([])
      expect(await readFile(join(directory, 'remote', 'file.txt'), 'utf8')).toBe(
        'remote bytes',
      )
    },
  )

  it('aborts in-flight work on renderer revocation and cleans local staging without publishing a result to it', async () => {
    const f = fixture()
    let entered!: () => void
    const streaming = new Promise<void>((resolve) => {
      entered = resolve
    })
    const read = f.remote.fileTransfer!.readFileChunks.bind(f.remote.fileTransfer)
    f.remote.fileTransfer!.readFileChunks = async function* (path, opts) {
      for await (const chunk of read(path, opts)) {
        yield chunk
        f.revoke()
        entered()
      }
    }
    await f.start()
    await streaming
    await coordinator!.dispose()
    expect(await readdir(join(directory, 'destination'))).toEqual([])
    expect(f.events.some((event) => event.phase === 'completed')).toBe(false)
  })

  it('skips trees exceeding the entry limit without publication', async () => {
    const f = fixture({ maxEntries: 1 })
    await mkdir(join(directory, 'remote', 'tree'))
    await writeFile(join(directory, 'remote', 'tree', 'file.txt'), 'remote bytes')
    await f.start('tree')
    const skipped = await item(f)
    expect(skipped).toMatchObject({
      status: 'skipped',
      effect: 'none',
    })
    expect(skipped.reason).toContain('entry limit')
    expect(await readdir(join(directory, 'destination'))).toEqual([])
  })

  it('rejects nested source symlinks without reading or publishing their targets', async () => {
    const f = fixture()
    await mkdir(join(directory, 'remote', 'tree'))
    await symlink(
      join(directory, 'remote', 'file.txt'),
      join(directory, 'remote', 'tree', 'link'),
    )
    await f.start('tree')
    const skipped = await item(f)
    expect(skipped.status).toBe('skipped')
    expect(skipped.reason).toContain('Symbolic links')
    expect(await readdir(join(directory, 'destination'))).toEqual([])
  })

  it('rejects names outside the existing transfer name policy before the picker', async () => {
    const f = fixture()
    await writeFile(join(directory, 'remote', 'back\\slash'), 'unsupported name')
    await expect(f.start('back\\slash')).rejects.toThrow('source name is unsupported')
    expect(f.picker.pick).not.toHaveBeenCalled()
  })

  it('rejects local, outside-workspace, workspace-root, and symlink source requests before the picker', async () => {
    const f = fixture()
    for (const source of [
      localPath('/tmp/source'),
      hostPath(remoteId, '/outside'),
      f.root,
    ]) {
      await expect(
        coordinator!.download({
          owner,
          workspaceRoot: f.root,
          source,
          publish: () => undefined,
        }),
      ).rejects.toThrow()
    }
    await symlink(
      join(directory, 'remote', 'file.txt'),
      join(directory, 'remote', 'link'),
    )
    await expect(f.start('link')).rejects.toThrow('Only regular files')
    expect(f.picker.pick).not.toHaveBeenCalled()
  })
})

describe('operation-scoped destination authority', () => {
  async function grant() {
    return acquireDownloadDestination({
      host: local,
      selectedPath: join(directory, 'destination'),
      name: 'file.txt',
      stagingId: 'exact',
      assertOperationCurrent: () => undefined,
    })
  }
  it('rejects sibling paths, another host, and unowned staging names', async () => {
    const g = await grant()
    for (const path of [
      localPath(join(directory, 'outside')),
      hostPath(remoteId, g.directory.path),
      localPath(join(g.directory.path, '.hvir-import-other')),
    ]) {
      await expect(g.destination.stat(path)).rejects.toThrow()
    }
  })
  it('revokes reads and writes while retaining only cleanup parent proof', async () => {
    const g = await grant()
    g.revoke()
    await expect(g.revalidate()).rejects.toThrow('revoked')
    await expect(
      g.destination.createDirectoryExclusive(g.stagingPath, { mode: 0o755 }),
    ).rejects.toThrow('revoked')
    await expect(g.proveCleanupParent()).resolves.toEqual(g.directory)
  })
  it('rejects a selected directory replaced by a symlink, including for cleanup', async () => {
    const g = await grant()
    await rename(join(directory, 'destination'), join(directory, 'original'))
    await symlink(join(directory, 'remote'), join(directory, 'destination'))
    await expect(g.revalidate()).rejects.toThrow('changed')
    await expect(g.proveCleanupParent()).rejects.toThrow('changed')
    expect(await readFile(join(directory, 'remote', 'file.txt'), 'utf8')).toBe(
      'remote bytes',
    )
  })
  it('rejects a symlink inside its staging tree', async () => {
    const g = await grant()
    await mkdir(g.stagingPath.path)
    await symlink(join(directory, 'remote'), join(g.stagingPath.path, 'link'))
    await expect(
      g.destination.createDirectoryExclusive(
        localPath(join(g.stagingPath.path, 'link', 'escape')),
        { mode: 0o755 },
      ),
    ).rejects.toThrow()
    expect(await readdir(join(directory, 'remote'))).toEqual(['file.txt'])
  })
})

describe('native download picker adapter', () => {
  it('asks for exactly one directory and treats that selection as approval', async () => {
    const showOpenDialog = vi
      .fn()
      .mockResolvedValue({ canceled: false, filePaths: ['/chosen'] })
    const picker = createElectronDownloadDirectoryPicker({ showOpenDialog })
    expect(await picker.pick()).toBe('/chosen')
    expect(showOpenDialog).toHaveBeenCalledOnce()
    expect(showOpenDialog).toHaveBeenCalledWith({
      title: 'Download to Folder',
      buttonLabel: 'Download Here',
      properties: ['openDirectory'],
    })
  })
})
