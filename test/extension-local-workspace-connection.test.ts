import { describe, expect, it, vi } from 'vitest'
import { fixture as guestFixture } from './fixtures/extension-guest'
import { connectorFixture } from './fixtures/extension-connector'
import { exampleManifest } from './fixtures/extension-package'
import { ExtensionConnectorConnectionOwner } from '../src/main/extensions/connector-connection'
import { DEFAULT_EXTENSION_PRESENTATION } from '../src/main/extensions/guest-owner'
import { asHostId, hostPath, localPath } from '../src/shared/host-path'
import type { ExtensionGuestPorts } from '../src/main/extensions/guest-capability-ports'

async function fixture(remote = false) {
  const request = vi.fn<ExtensionGuestPorts['connections']['request']>((...args) =>
    connection.request(...args),
  )
  const data = guestFixture(
    {},
    {
      optionalCapabilities: ['connector.connect'],
      views: [
        { ...exampleManifest().views[0]!, placement: 'workspace', navigation: 'left' },
      ],
      connectors: [
        {
          id: 'tool',
          description: 'Read project observations',
          context: 'workspace',
          timeoutMs: 1000,
          outputBytes: 1000,
          environment: [],
          setup: { executable: 'tool' },
        },
      ],
    },
    undefined,
    { connections: { request, revalidate: () => connection.revalidate() } },
  )
  if (remote) {
    const state = data.context.sources.projectState()
    const root = hostPath(asHostId('ssh-server'), '/project')
    vi.spyOn(data.context.sources, 'projectState').mockReturnValue({
      ...state,
      root,
      projects: state.projects.map((project) => ({
        ...project,
        registeredRoot: root,
        workspaces: project.workspaces.map((workspace) => ({ ...workspace, root })),
      })),
    })
  }
  const activation = [...data.active.values()][0]!
  const native = connectorFixture(
    'application',
    undefined,
    undefined,
    activation.revision,
  )
  native.active.set(activation.installationId, activation)
  const connection = new ExtensionConnectorConnectionOwner(
    data.scopes,
    () => true,
    native.authority,
    native.approvals,
    { folders: ['/installed'], choose: vi.fn(() => Promise.resolve(undefined)) },
    () => undefined,
  )
  const view = await data.owner.open(
    data.renderer,
    'installation',
    'reference',
    undefined,
    {
      context: { surface: 'left', workspaceId: 'workspace' },
    },
  )
  data.owner.claim(data.renderer, view.partition, view.url, view.id)
  data.owner.bind(data.renderer, view.partition, 10)
  data.owner.presentation(
    data.renderer,
    view.id,
    DEFAULT_EXTENSION_PRESENTATION,
    true,
    true,
  )
  data.owner.receive(10, { kind: 'hello', contract: '1.0' })
  return {
    ...data,
    native,
    connection,
    request,
    view,
    connect: (id = 'connect', input: unknown = { connector: 'tool' }) =>
      data.owner.receive(10, {
        kind: 'request',
        id,
        capability: 'connector.connect',
        input,
      }),
    result: (id = 'connect') =>
      data.sent.find(
        (entry) => entry.message.kind === 'result' && entry.message.id === id,
      )?.message,
    stop: async () => {
      connection.dispose()
      native.dispose()
      await data.owner.dispose()
    },
  }
}

describe('main-admitted local project connection', () => {
  it('connects through a visible left project view and reuses its own unchanged native approval', async () => {
    const data = await fixture()
    try {
      data.connect()
      await vi.waitFor(() =>
        expect(data.connection.snapshot(data.renderer)).toHaveLength(1),
      )
      const proposal = data.connection.snapshot(data.renderer)[0]!
      expect(proposal.programs).toEqual([
        expect.objectContaining({
          connector: 'tool',
          context: 'workspace',
          host: 'local',
          canonicalExecutable: '/installed/tool',
          configuration: { args: [], env: {} },
        }),
      ])
      data.connection.decide(data.renderer, proposal.id, true)
      await vi.waitFor(() =>
        expect(data.result()).toMatchObject({
          ok: true,
          value: { connections: [{ connector: 'tool', outcome: 'connected' }] },
        }),
      )
      expect(data.request.mock.calls[0]?.[7]?.root).toEqual(localPath('/project'))
      expect(data.native.host.exec).not.toHaveBeenCalled()
      expect(data.native.host.connect).toHaveBeenCalledTimes(1)
      data.connect('reuse')
      await vi.waitFor(() =>
        expect(data.result('reuse')).toMatchObject({
          ok: true,
          value: { connections: [{ connector: 'tool', outcome: 'connected' }] },
        }),
      )
      expect(data.native.write).toHaveBeenCalledTimes(1)
      expect(data.context.listeners[0]).toHaveLength(0)
      expect(data.connection.snapshot(data.renderer)).toEqual([])
    } finally {
      await data.stop()
    }
  })
  it('requires new local consent instead of reusing a current SSH approval with identical executable paths', async () => {
    const data = await fixture()
    try {
      const hosts = data.native.hosts
      const local = hosts.hostById(asHostId('local'))!
      const remoteId = asHostId('ssh-server')
      const remote = { ...local, hostId: remoteId }
      vi.spyOn(hosts, 'listHosts').mockReturnValue([
        ...hosts.listHosts(),
        {
          hostId: remoteId,
          label: 'Server',
          kind: 'ssh',
          connectionState: 'connected',
          watchTier: 'polling',
        },
      ])
      vi.spyOn(hosts, 'hostById').mockImplementation((id) =>
        id === remoteId ? remote : id === local.hostId ? local : undefined,
      )
      vi.spyOn(hosts, 'materializeHost').mockImplementation((id) =>
        Promise.resolve(id === remoteId ? remote : local),
      )
      const activation = [...data.native.active.values()][0]!
      const prepared = await data.native.approvals.prepare(
        {
          installationId: activation.installationId,
          connector: 'tool',
          host: remoteId,
          executable: '/installed/tool',
          configuration: { args: [], env: {} },
        },
        () => undefined,
      )
      await data.native.approvals.approve(prepared.token)
      expect(data.native.approvals.current(activation, prepared.approval)).toBe(true)
      expect(prepared.approval.canonicalExecutable).toBe('/installed/tool')
      data.connect()
      await vi.waitFor(() =>
        expect(data.connection.snapshot(data.renderer)).toHaveLength(1),
      )
      const proposal = data.connection.snapshot(data.renderer)[0]!
      expect(proposal.programs[0]).toMatchObject({
        host: 'local',
        canonicalExecutable: '/installed/tool',
      })
      expect(data.result()).toBeUndefined()
      data.connection.decide(data.renderer, proposal.id, true)
      await vi.waitFor(() =>
        expect(data.result()).toMatchObject({
          ok: true,
          value: { connections: [{ outcome: 'connected' }] },
        }),
      )
      expect(data.native.approvals.get(activation, 'tool')?.host).toBe('local')
      expect(data.native.write).toHaveBeenCalledTimes(2)
      expect(data.native.host.exec).not.toHaveBeenCalled()
    } finally {
      await data.stop()
    }
  })
  it('withdraws a pending request on a same-turn switch away and back, disposing its observer', async () => {
    const data = await fixture()
    const update = vi.fn(() => data.owner.updateContext())
    const dispose = data.context.contexts.observe(update)
    const state = data.context.sources.projectState()
    let current = state
    vi.spyOn(data.context.sources, 'projectState').mockImplementation(() => current)
    const baseline = data.context.listeners[0]!.length
    try {
      data.connect()
      await vi.waitFor(() =>
        expect(data.connection.snapshot(data.renderer)).toHaveLength(1),
      )
      const proposal = data.connection.snapshot(data.renderer)[0]!
      current = { ...state, activeProjectId: 'other-project' }
      for (const changed of [...data.context.listeners[0]!]) changed()
      current = state
      for (const changed of [...data.context.listeners[0]!]) changed()
      await Promise.resolve()
      expect(update).not.toHaveBeenCalled()
      expect(data.connection.snapshot(data.renderer)).toEqual([])
      expect(() => data.connection.decide(data.renderer, proposal.id, true)).toThrow(
        'ended',
      )
      await vi.waitFor(() => expect(data.context.listeners[0]).toHaveLength(baseline))
      expect(data.native.write).not.toHaveBeenCalled()
    } finally {
      dispose()
      await data.stop()
    }
  })
  it('rechecks the project when the pending request subscribes and cleans up an admission race', async () => {
    const data = await fixture()
    const state = data.context.sources.projectState()
    let current = state
    vi.spyOn(data.context.sources, 'projectState').mockImplementation(() => current)
    const subscribe = data.context.sources.observeProjects
    vi.spyOn(data.context.sources, 'observeProjects').mockImplementation((changed) => {
      const dispose = subscribe(changed)
      current = { ...state, activeProjectId: 'other-project' }
      return dispose
    })
    try {
      data.connect()
      await vi.waitFor(() =>
        expect(data.result()).toMatchObject({
          ok: true,
          value: { connections: [{ outcome: 'unavailable' }] },
        }),
      )
      expect(data.connection.snapshot(data.renderer)).toEqual([])
      expect(data.context.listeners[0]).toHaveLength(0)
      expect(data.native.host.realpath).not.toHaveBeenCalled()
      expect(data.native.write).not.toHaveBeenCalled()
    } finally {
      await data.stop()
    }
  })
  it.each(['host', 'root', 'workspace'])(
    'refuses a guest-supplied replacement %s rather than retargeting discovery',
    async (key) => {
      const data = await fixture()
      try {
        data.connect('forged', {
          connector: 'tool',
          [key]: key === 'root' ? localPath('/other') : 'other',
        })
        await vi.waitFor(() => expect(data.result('forged')).toMatchObject({ ok: false }))
        expect(data.request).not.toHaveBeenCalled()
        expect(data.native.host.realpath).not.toHaveBeenCalled()
        expect(data.native.host.connect).not.toHaveBeenCalled()
      } finally {
        await data.stop()
      }
    },
  )
  it('refuses an admitted SSH project without discovering, authenticating or running a replacement', async () => {
    const data = await fixture(true)
    try {
      data.connect()
      await vi.waitFor(() => expect(data.result()).toMatchObject({ ok: false }))
      expect(data.request).not.toHaveBeenCalled()
      expect(data.native.host.realpath).not.toHaveBeenCalled()
      expect(data.native.host.connect).not.toHaveBeenCalled()
      expect(data.native.host.exec).not.toHaveBeenCalled()
    } finally {
      await data.stop()
    }
  })
  it.each([
    'registration',
    'registered-root',
    'owning-project-transfer',
    'project-switch',
    'worktree-switch',
    'root',
    'host',
    'closed',
    'disconnect',
    'hide',
    'close',
    'cancel',
    'dispose',
    'renderer',
    'activation',
  ] as const)('retires consent on %s and rejects its late response', async (ending) => {
    const data = await fixture()
    try {
      data.connect()
      await vi.waitFor(() =>
        expect(data.connection.snapshot(data.renderer)).toHaveLength(1),
      )
      const proposal = data.connection.snapshot(data.renderer)[0]!
      if (
        [
          'registered-root',
          'project-switch',
          'worktree-switch',
          'owning-project-transfer',
        ].includes(ending)
      ) {
        const state = data.context.sources.projectState()
        const project = state.projects[0]!,
          workspace = project.workspaces[0]!
        const nextRoot = localPath('/other')
        const other = { ...workspace, id: 'other-workspace', root: nextRoot }
        vi.spyOn(data.context.sources, 'projectState').mockReturnValue({
          ...state,
          activeProjectId:
            ending === 'project-switch' ? 'other-project' : state.activeProjectId,
          activeWorkspaceId:
            ending === 'registered-root' || ending === 'owning-project-transfer'
              ? state.activeWorkspaceId
              : other.id,
          projects:
            ending === 'project-switch' || ending === 'owning-project-transfer'
              ? [
                  ending === 'owning-project-transfer'
                    ? { ...project, workspaces: [] }
                    : project,
                  {
                    ...project,
                    id: 'other-project',
                    registeredRoot: nextRoot,
                    activeWorkspaceId: other.id,
                    workspaces:
                      ending === 'owning-project-transfer' ? [workspace] : [other],
                  },
                ]
              : [
                  {
                    ...project,
                    registeredRoot:
                      ending === 'registered-root' ? nextRoot : project.registeredRoot,
                    activeWorkspaceId:
                      ending === 'worktree-switch' ? other.id : project.activeWorkspaceId,
                    workspaces:
                      ending === 'worktree-switch'
                        ? [workspace, other]
                        : project.workspaces,
                  },
                ],
        })
        data.owner.updateContext()
      } else if (['registration', 'root', 'host'].includes(ending)) {
        const state = data.context.sources.projectState()
        const root =
          ending === 'host'
            ? hostPath(asHostId('ssh-server'), '/project')
            : localPath('/other')
        vi.spyOn(data.context.sources, 'projectState').mockReturnValue({
          ...state,
          projects:
            ending === 'registration'
              ? []
              : state.projects.map((project) => ({
                  ...project,
                  workspaces: project.workspaces.map((workspace) => ({
                    ...workspace,
                    root,
                  })),
                })),
        })
        data.owner.updateContext()
      } else if (ending === 'closed' || ending === 'disconnect') {
        data.context.change(ending === 'closed' ? 'close' : 'disconnect')
        data.owner.updateContext()
      } else if (ending === 'hide') {
        data.owner.presentation(
          data.renderer,
          data.view.id,
          DEFAULT_EXTENSION_PRESENTATION,
          false,
          false,
        )
      } else if (ending === 'close') await data.owner.close(data.renderer, data.view.id)
      else if (ending === 'cancel')
        data.owner.receive(10, { kind: 'cancel', id: 'connect' })
      else if (ending === 'dispose') data.connection.dispose()
      else if (ending === 'renderer') {
        await data.scopes.revokeOwner(data.renderer.id)
        data.scopes.activateOwner(data.renderer.id)
      } else {
        data.active.clear()
        data.connection.revalidate()
      }
      data.connection.revalidate()
      expect(data.connection.snapshot(data.renderer)).toEqual([])
      expect(() => data.connection.decide(data.renderer, proposal.id, true)).toThrow(
        'ended',
      )
      await vi.waitFor(() => expect(data.context.listeners[0]).toHaveLength(0))
      expect(data.native.write).not.toHaveBeenCalled()
      expect(
        data.native.approvals.get([...data.native.active.values()][0]!, 'tool'),
      ).toBeUndefined()
    } finally {
      await data.stop()
    }
  })
})
