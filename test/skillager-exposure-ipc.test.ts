import { describe, expect, it, vi } from 'vitest'
import { registerSkillagerIpc } from '../src/main/ipc/features/skillager'
import type { IpcRegistrar } from '../src/main/ipc/authority-router'
import { hostPathEquals, localPath, type HostPath } from '../src/shared/host-path'
import { request } from './fixtures/skillager-exposure-fixture'
import { planRequest } from './fixtures/skillager-plan-fixture'

function fixture() {
  const owner = { id: 7, generation: 3 },
    previewExposure = vi.fn(),
    exposureLineage = vi.fn(),
    applyExposure = vi.fn(),
    review = vi.fn(),
    initializeLibrary = vi.fn(),
    chooseLibraryFolder = vi.fn(),
    reconcileLibrary = vi.fn(),
    syncStatus = vi.fn(),
    syncApproved = vi.fn(),
    cancelSync = vi.fn()
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
    skillager: {
      librarySync: { observe: syncStatus, apply: syncApproved, cancel: cancelSync },
      previewExposure,
      exposureLineage,
      applyExposure,
      review,
      initializeLibrary,
      chooseLibraryFolder,
      reconcileLibrary,
    },
  } as unknown as Parameters<typeof registerSkillagerIpc>[1])
  return {
    owner,
    syncStatus,
    syncApproved,
    cancelSync,
    previewExposure,
    exposureLineage,
    applyExposure,
    review,
    initializeLibrary,
    chooseLibraryFolder,
    reconcileLibrary,
    workspaceRoot,
    invoke: (channel: string, value: unknown) =>
      handlers.get(channel)!(value, { owner: () => owner }),
  }
}
describe('workspace skill IPC authority', () => {
  it('native preparation has a named read-only request and separately qualifies its exact current destination', () => {
    const f = fixture(),
      selected = {
        ...request,
        destination: { ...request.destination, root: request.workspaceRoot },
      }
    f.invoke('skillager:exposure-lineage', {
      ...selected,
      executable: '/forged',
      library: '/foreign',
      plan: { action: 'remove-native' },
    })
    expect(f.exposureLineage).toHaveBeenCalledWith(f.owner, {
      connectionId: request.connectionId,
      requestId: request.requestId,
      agent: request.agent,
      workspaceRoot: request.workspaceRoot,
      destination: selected.destination,
    })
    expect(f.syncStatus).not.toHaveBeenCalled()
    expect(f.previewExposure).not.toHaveBeenCalled()
  })
  it('reconstructs aggregate public selectors and ignores command/force fields outside the closed request', () => {
    const f = fixture(),
      selected = {
        ...planRequest,
        workspaceRoot: request.workspaceRoot,
        destination: { ...request.destination, root: request.workspaceRoot },
      }
    f.invoke('skillager:preview-exposure', {
      ...selected,
      command: 'remove everything',
      force: true,
    })
    expect(f.previewExposure).toHaveBeenCalledWith(f.owner, selected)
    expect(() =>
      f.invoke('skillager:preview-exposure', {
        ...selected,
        plan: { ...selected.plan, name: 'x'.repeat(65537) },
      }),
    ).toThrow()
  })
  it('sync binds the registered workspace and main observation ID, ignoring renderer target overrides', () => {
    const f = fixture()
    const base = {
      connectionId: 'connection',
      requestId: 1,
      agent: 'codex',
      workspaceRoot: request.workspaceRoot,
    }
    f.invoke('skillager:sync-status', {
      ...base,
      catalog: '/private',
      executable: '/forged',
    })
    expect(f.syncStatus).toHaveBeenCalledWith(f.owner, base)
    f.invoke('skillager:sync-approved', {
      ...base,
      requestId: 2,
      observationId: 'main-observation',
      expectedLibrary: '/elsewhere',
      approved: true,
    })
    expect(f.syncApproved).toHaveBeenCalledWith(f.owner, {
      ...base,
      requestId: 2,
      observationId: 'main-observation',
    })
    expect(() =>
      f.invoke('skillager:sync-approved', {
        ...base,
        workspaceRoot: localPath('/unregistered'),
        observationId: 'main',
      }),
    ).toThrow('Unregistered')
    expect(f.syncApproved).toHaveBeenCalledTimes(1)
    f.invoke('skillager:cancel-sync', { requestId: 2 })
    expect(f.cancelSync).toHaveBeenCalledWith(f.owner, 2)
  })
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

it('reconstructs and qualifies nested update paths before forwarding the review', () => {
  const f = fixture()
  const target = localPath('/other/.agents/skills/lib-demo')
  const exposure = {
    agent: request.agent,
    id: 'lib-demo',
    skillId: request.skillId,
    target,
    mode: 'native',
    status: 'source_update',
  }
  const update = { ...request, action: 'update', exposure }
  f.invoke('skillager:review', {
    ...request,
    workspaceRoot: { ...request.workspaceRoot, command: 'forged' },
    update: {
      ...update,
      command: 'forged',
      confirmationToken: 'forged',
      destination: {
        ...request.destination,
        root: { ...request.destination.root, command: 'forged' },
      },
      exposure: {
        ...exposure,
        target: { ...target, command: 'forged' },
        sourceHash: 'forged',
      },
    },
  })
  expect(f.workspaceRoot.mock.calls.map(([root]) => root)).toEqual([
    request.workspaceRoot,
    request.workspaceRoot,
    request.destination.root,
  ])
  expect(f.review).toHaveBeenCalledWith(f.owner, {
    connectionId: request.connectionId,
    requestId: request.requestId,
    workspaceRoot: request.workspaceRoot,
    agent: request.agent,
    skillId: request.skillId,
    update: { ...update, reviewId: undefined },
  })
  expect(() =>
    f.invoke('skillager:review', {
      ...request,
      update: {
        ...update,
        destination: { ...request.destination, root: localPath('/unregistered') },
      },
    }),
  ).toThrow('Unregistered')
  expect(f.review).toHaveBeenCalledTimes(1)
})

it('library setup IPC forwards only retained identities and the explicit boolean, without workspace authority', () => {
  const f = fixture()
  f.invoke('skillager:initialize-library', {
    selectionId: 'retained',
    gitHistory: false,
    root: localPath('/arbitrary'),
    command: 'shell injection',
    catalog: '/other',
  })
  expect(f.initializeLibrary).toHaveBeenCalledWith(f.owner, 'retained', false)
  f.invoke('skillager:choose-library-folder', {
    probeId: 'probe',
    root: localPath('/ungranted'),
  })
  expect(f.chooseLibraryFolder).toHaveBeenCalledWith(f.owner, 'probe')
  f.invoke('skillager:reconcile-library', { probeId: 'probe' })
  expect(f.reconcileLibrary).toHaveBeenCalledWith(f.owner, 'probe')
  expect(f.workspaceRoot).not.toHaveBeenCalled()
  for (const gitHistory of [undefined, 'false', 0, null])
    expect(() =>
      f.invoke('skillager:initialize-library', { selectionId: 'retained', gitHistory }),
    ).toThrow()
  expect(() =>
    f.invoke('skillager:initialize-library', { selectionId: '', gitHistory: true }),
  ).toThrow()
  expect(f.initializeLibrary).toHaveBeenCalledOnce()
})
