import { describe, expect, it, vi } from 'vitest'

import {
  IpcAuthority,
  type IpcRegistrar,
  type IpcInvokeHandler,
  type IpcInvokeContext,
} from '../src/main/ipc/authority-router'
import { registerTerminalIpc } from '../src/main/ipc/features/terminal'
import { hostPathEquals, type ProjectState } from '../src/shared'
import { terminalNamingFixture } from './terminal-session-naming-fixture'

async function fixture(remote = false) {
  const f = await terminalNamingFixture(remote)
  let revision = 2
  let current = true
  let registered = true
  const getProjectState = (): ProjectState => ({
    revision,
    root: f.root,
    connectionState: remote ? 'disconnected' : 'connected',
    watchTier: 'native',
    activeProjectId: 'project',
    activeWorkspaceId: 'workspace',
    projects: [
      {
        id: 'project',
        registeredRoot: f.root,
        displayName: 'Project',
        connectionState: remote ? 'disconnected' : 'connected',
        watchTier: 'native',
        activeWorkspaceId: 'workspace',
        workspaces: [
          {
            id: 'workspace',
            root: f.root,
            name: 'Workspace',
            main: true,
            closed: false,
            missing: false,
            repository: true,
            changedFiles: 0,
          },
        ],
      },
    ],
  })
  const authority = new IpcAuthority({
    getProjectState,
    getProject: () => {
      throw new Error('Active host must not be acquired')
    },
    getRegisteredWorkspaceRoot: (root) =>
      registered && hostPathEquals(root, f.root) ? f.root : undefined,
  })
  let rename!: IpcInvokeHandler<'terminal:rename'>
  const ipc = {
    authority,
    handle: (channel: string, handler: unknown) => {
      if (channel === 'terminal:rename') rename = handler as typeof rename
    },
    handleSend: vi.fn(),
  } as unknown as IpcRegistrar
  const emit = vi.fn()
  const assertCurrent = vi.fn(() => {
    if (!current) throw new Error('Renderer revoked')
  })
  const deps = {
    getProjectState,
    terminalSessions: f.registry,
    rendererResources: { assertCurrent },
    emit,
  } as unknown as Parameters<typeof registerTerminalIpc>[1]
  registerTerminalIpc(ipc, deps)
  const context = {
    owner: () => {
      assertCurrent()
      return { id: 7, generation: 3 }
    },
  } as IpcInvokeContext
  const request = {
    id: f.spawn.id,
    expectedNameRevision: 0,
    customName: 'My work',
  }
  return {
    ...f,
    request,
    rename: (req = request) => rename(req, context),
    emit,
    revoke: () => {
      current = false
    },
    publishActivity: () => {
      revision++
    },
    unregister: () => {
      registered = false
    },
  }
}

describe.each([false, true])('rename IPC (disconnected SSH: %s)', (remote) => {
  it('uses only retained metadata, qualifies the exact target, and publishes after persistence', async () => {
    const f = await fixture(remote)
    expect(await f.rename()).toEqual({
      ok: true,
      value: { id: f.spawn.id, root: f.root, customName: 'My work', nameRevision: 1 },
    })
    expect(f.emit).toHaveBeenCalledWith(
      'terminal:name-changed',
      expect.objectContaining({ id: f.spawn.id, nameRevision: 1 }),
    )
    expect((await f.reload()).get(f.spawn.id)?.customName).toBe('My work')
    expect(await f.rename()).toMatchObject({ ok: false })
    expect(f.emit).toHaveBeenCalledOnce()
  })
})

it('rejects malformed names, invalid IDs, stale naming decisions, and missing targets without publication', async () => {
  const f = await fixture()
  for (const request of [
    { ...f.request, id: 'invalid id' },
    { ...f.request, id: 'another-terminal' },
    { ...f.request, customName: 'a\ncommand' },
    { ...f.request, customName: 'x'.repeat(513) },
    { ...f.request, expectedNameRevision: -1 },
    { ...f.request, expectedNameRevision: Number.MAX_SAFE_INTEGER },
    { ...f.request, expectedNameRevision: 1 },
  ])
    expect(await f.rename(request)).toMatchObject({ ok: false })
  expect(f.emit).not.toHaveBeenCalled()
  expect(f.registry.get(f.spawn.id)?.customName).toBeUndefined()
})

it('reports a failed write without publishing a successful rename', async () => {
  const f = await fixture()
  f.writeFile.mockRejectedValueOnce(new Error('Disk unavailable'))
  expect(await f.rename()).toMatchObject({ ok: false })
  expect(f.emit).not.toHaveBeenCalled()
  expect((await f.reload()).get(f.spawn.id)?.customName).toBeUndefined()
})

it.each(['renderer', 'workspace'])(
  'rejects a late reply after %s revocation while keeping the committed name consistent',
  async (failure) => {
    const f = await fixture()
    const write = f.writeFile.getMockImplementation()!
    f.writeFile
      .mockImplementationOnce((file, data) => {
        if (failure === 'renderer') f.revoke()
        else f.unregister()
        return write(file, data)
      })
      .mockRejectedValueOnce(new Error('An undo write must never be attempted'))
    expect(await f.rename()).toMatchObject({ ok: false })
    expect(f.writeFile).toHaveBeenCalledTimes(2) // spawn + the one committed rename
    expect(f.emit).toHaveBeenCalledWith(
      'terminal:name-changed',
      expect.objectContaining({ customName: 'My work' }),
    )
    expect(f.registry.get(f.spawn.id)?.customName).toBe('My work')
    expect((await f.reload()).get(f.spawn.id)?.customName).toBe('My work')
  },
)

it('rejects authority revoked while the rename is queued before disk dispatch', async () => {
  const f = await fixture()
  let release!: () => void
  f.writeFile.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      }),
  )
  const layout = f.registry.updateLayout(f.root, [
    { id: f.spawn.id, title: 'Automatic', position: 0, active: false },
  ])
  await vi.waitFor(() => expect(f.writeFile).toHaveBeenCalledTimes(2))
  const renaming = f.rename()
  f.revoke()
  release()
  await layout
  expect(await renaming).toMatchObject({ ok: false })
  expect(f.emit).not.toHaveBeenCalled()
  expect((await f.reload()).get(f.spawn.id)?.customName).toBeUndefined()
})

it.each([false, true])(
  'ignores unrelated activity and connection-state publications (SSH: %s)',
  async (remote) => {
    const f = await fixture(remote)
    f.publishActivity()
    f.writeFile.mockImplementationOnce(() => {
      f.publishActivity()
      return Promise.resolve()
    })
    expect(await f.rename()).toMatchObject({ ok: true, value: { customName: 'My work' } })
    expect(f.registry.get(f.spawn.id)?.customName).toBe('My work')
  },
)
