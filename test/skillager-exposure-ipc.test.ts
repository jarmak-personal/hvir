import { describe, expect, it, vi } from 'vitest'
import { registerSkillagerIpc } from '../src/main/ipc/features/skillager'
import type { IpcRegistrar } from '../src/main/ipc/authority-router'
import { hostPathEquals, localPath, type HostPath } from '../src/shared/host-path'
import { request } from './fixtures/skillager-exposure-fixture'

function fixture() {
  const owner = { id: 7, generation: 3 },
    previewExposure = vi.fn(),
    applyExposure = vi.fn()
  const workspaceRoot = vi.fn((path: HostPath) => {
    if (
      ![request.workspaceRoot, request.destination.root].some((root) =>
        hostPathEquals(path, root),
      )
    )
      throw new Error('Unregistered workspace')
    return path
  })
  const handlers = new Map<
    string,
    (request: unknown, context: { owner: () => typeof owner }) => unknown
  >()
  const ipc = {
    authority: {
      workspaceRoot,
      reconstructHostPath: (path: HostPath) => ({ hostId: path.hostId, path: path.path }),
    },
    handle: (
      channel: string,
      handler: (request: unknown, context: { owner: () => typeof owner }) => unknown,
    ) => handlers.set(channel, handler),
  } as unknown as IpcRegistrar
  registerSkillagerIpc(ipc, {
    skillager: { previewExposure, applyExposure },
  } as unknown as Parameters<typeof registerSkillagerIpc>[1])
  return {
    owner,
    previewExposure,
    applyExposure,
    workspaceRoot,
    invoke: (channel: string, value: unknown) =>
      handlers.get(channel)!(value, { owner: () => owner }),
  }
}
describe('workspace skill IPC authority', () => {
  it('independently qualifies origin and selected destination and retains renderer ownership', () => {
    const f = fixture()
    f.invoke('skillager:preview-exposure', {
      ...request,
      command: 'untrusted',
      confirmationToken: 'forged',
    })
    expect(f.workspaceRoot.mock.calls.map(([root]) => root)).toEqual([
      request.workspaceRoot,
      request.destination.root,
    ])
    expect(f.previewExposure).toHaveBeenCalledWith(f.owner, {
      ...request,
      exposure: undefined,
    })
  })
  it('refuses an unregistered destination and malformed mode before the application port', () => {
    const f = fixture()
    expect(() =>
      f.invoke('skillager:preview-exposure', {
        ...request,
        destination: { ...request.destination, root: localPath('/unregistered') },
      }),
    ).toThrow('Unregistered')
    expect(() =>
      f.invoke('skillager:preview-exposure', { ...request, mode: 'router' }),
    ).toThrow()
    expect(f.previewExposure).not.toHaveBeenCalled()
  })
  it('apply supplies only the main-owned preview handle; renderer overrides never reach apply', () => {
    const f = fixture()
    f.invoke('skillager:apply-exposure', {
      previewId: 'retained',
      destination: { root: localPath('/different') },
      confirmationToken: 'forged',
      command: 'arbitrary',
    })
    expect(f.applyExposure).toHaveBeenCalledWith(f.owner, 'retained')
  })
})
