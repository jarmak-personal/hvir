import { describe, expect, it, vi } from 'vitest'
import { registerFilesystemIpc } from '../src/main/ipc/features/filesystem'
import { registerPreviewIpc } from '../src/main/ipc/features/preview'
import { IpcAuthority, type IpcRegistrar } from '../src/main/ipc/authority-router'
import type { IpcDeps } from '../src/main/ipc/deps'
import type { ProjectHost } from '../src/main/project-host'
import { localPath, type HostPath, type ProjectState } from '../src/shared'

function fixture() {
  const root = localPath('/repo')
  const host = {
    hostId: root.hostId,
    connectionState: 'connected',
    realpath: vi.fn((path: HostPath) => Promise.resolve(path)),
    stat: vi.fn(() => Promise.resolve({ type: 'file', size: 5, mtimeMs: 1 })),
    readFile: vi.fn(() => Promise.resolve(Buffer.from('# Plan'))),
    writeFile: vi.fn(),
  }
  const owner = vi.fn(() => ({ id: 1, generation: 1 }))
  const createPreview = vi.fn(() => ({ id: 'preview', url: 'preview-url' }))
  const registerResource = vi.fn()
  const deps = {
    getProject: () => ({ root, host: host as unknown as ProjectHost }),
    getProjectState: () => ({ projects: [] }) as unknown as ProjectState,
    getRegisteredWorkspaceRoot: () => root,
    rendererResources: { assertCurrent: vi.fn(), register: registerResource },
    htmlPreviews: {
      create: createPreview,
      release: vi.fn(),
    },
  } as unknown as IpcDeps
  const handlers = new Map<
    string,
    (request: unknown, context: unknown) => Promise<unknown>
  >()
  const ipc = {
    authority: new IpcAuthority(deps),
    handle: (
      channel: string,
      handler: (request: unknown, context: unknown) => Promise<unknown>,
    ) => handlers.set(channel, handler),
    handleSend: vi.fn(),
  } as unknown as IpcRegistrar
  registerFilesystemIpc(ipc, deps)
  registerPreviewIpc(ipc, deps)
  return {
    root,
    owner,
    host,
    deps,
    createPreview,
    registerResource,
    invoke: (channel: string, request: unknown) =>
      handlers.get(channel)!(request, { owner }),
  }
}

describe('outside-project document IPC', () => {
  it('reads bounded text and images without creating polling interests', async () => {
    const f = fixture()
    expect(
      await f.invoke('fs:read', {
        path: localPath('/scratch/plan.md'),
        workspaceRoot: f.root,
      }),
    ).toMatchObject({ ok: true, value: { content: '# Plan' } })
    expect(f.host.readFile).toHaveBeenLastCalledWith(localPath('/scratch/plan.md'), {
      pollingInterest: false,
    })
    expect(
      await f.invoke('fs:read-asset', {
        path: localPath('/scratch/image.png'),
        documentPath: localPath('/scratch/plan.md'),
        workspaceRoot: f.root,
      }),
    ).toMatchObject({ ok: true })
    expect(f.host.readFile).toHaveBeenLastCalledWith(localPath('/scratch/image.png'), {
      pollingInterest: false,
    })
  })

  it('returns clear missing/unreadable, non-file, and size failures', async () => {
    const f = fixture()
    const request = { path: localPath('/scratch/plan.md'), workspaceRoot: f.root }
    f.host.stat.mockRejectedValueOnce(new Error('Permission denied'))
    expect(await f.invoke('fs:read', request)).toMatchObject({
      ok: false,
      error: 'Permission denied',
    })
    for (const type of ['dir', 'other']) {
      f.host.stat.mockResolvedValueOnce({ type, size: 0, mtimeMs: 1 })
      expect(await f.invoke('fs:read', request)).toMatchObject({ ok: false })
    }
    f.host.stat.mockResolvedValueOnce({
      type: 'file',
      size: 65 * 1024 * 1024,
      mtimeMs: 1,
    })
    expect(await f.invoke('fs:read', request)).toMatchObject({ ok: false })
    expect(f.host.readFile).not.toHaveBeenCalled()
    f.host.readFile.mockRejectedValueOnce(new Error('File disappeared'))
    expect(await f.invoke('fs:read', request)).toMatchObject({ ok: false })
  })

  it('preserves project-only writes and directory authority', async () => {
    const f = fixture()
    const request = {
      path: localPath('/scratch/plan.md'),
      workspaceRoot: f.root,
      content: 'changed',
    }
    for (const channel of ['fs:write', 'fs:readdir', 'fs:resolve-entry']) {
      expect(await f.invoke(channel, request)).toMatchObject({ ok: false })
    }
    expect(f.host.writeFile).not.toHaveBeenCalled()
  })

  it('owns outside-project HTML previews under the originating workspace', async () => {
    const f = fixture()
    await f.invoke('html-preview:create', {
      path: localPath('/scratch/plan.html'),
      workspaceRoot: f.root,
      content: '<h1>Plan</h1>',
    })
    expect(f.createPreview).toHaveBeenCalledWith(
      '<h1>Plan</h1>',
      { id: 1, generation: 1 },
      f.root,
    )
    expect(f.registerResource).toHaveBeenCalledWith(
      { id: 1, generation: 1 },
      { lifetime: 'workspace', type: 'html-preview', root: f.root, id: 'preview' },
      expect.any(Function),
    )
  })

  it('rejects late read completion after host disconnect', async () => {
    const f = fixture()
    f.host.readFile.mockImplementationOnce(() => {
      f.host.connectionState = 'disconnected'
      return Promise.resolve(Buffer.from('# Late'))
    })
    expect(
      await f.invoke('fs:read', {
        path: localPath('/scratch/plan.md'),
        workspaceRoot: f.root,
      }),
    ).toMatchObject({ ok: false })
  })
})

it('rejects late content after renderer revocation', async () => {
  const f = fixture()
  f.host.readFile.mockImplementationOnce(() => {
    f.owner.mockImplementation(() => {
      throw new Error('Renderer revoked')
    })
    return Promise.resolve(Buffer.from('late'))
  })
  expect(
    await f.invoke('fs:read', {
      path: localPath('/scratch/code.ts'),
      workspaceRoot: f.root,
    }),
  ).toMatchObject({ ok: false, error: 'Renderer revoked' })
})
it('returns canonical external classification for an in-project symlink', async () => {
  const f = fixture()
  f.host.realpath.mockImplementation((path) =>
    Promise.resolve(path.path === '/repo/link.ts' ? localPath('/sibling/main.ts') : path),
  )
  expect(
    await f.invoke('fs:read', {
      path: localPath('/repo/link.ts'),
      workspaceRoot: f.root,
    }),
  ).toMatchObject({
    ok: true,
    value: { resolvedPath: localPath('/sibling/main.ts'), externalWorkspaceRoot: f.root },
  })
  expect(f.host.readFile).toHaveBeenCalledWith(localPath('/sibling/main.ts'), {
    pollingInterest: false,
  })
})

it('keeps the existing binary fallback for external files', async () => {
  const f = fixture()
  f.host.readFile.mockResolvedValueOnce(Buffer.from([0, 1, 2]))
  expect(
    await f.invoke('fs:read', {
      path: localPath('/scratch/data.bin'),
      workspaceRoot: f.root,
    }),
  ).toMatchObject({
    ok: true,
    value: { binary: true, content: '', externalWorkspaceRoot: f.root },
  })
})
