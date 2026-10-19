import { afterEach, expect, it, vi } from 'vitest'
import { RendererResourceScopes } from '../src/main/renderer-resource-scopes'
import { ExtensionConnectorConnectionOwner } from '../src/main/extensions/connector-connection'
import { connectorFixture } from './fixtures/extension-connector'
import { sourceFixture } from './fixtures/extension-source'
import type { ExtensionSourceDeclaration } from '../src/shared/extensions/source-access'
import { localPath } from '../src/shared/host-path'

const stops: (() => void)[] = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  vi.useRealTimers()
})
async function fixture(
  access: Partial<ExtensionSourceDeclaration> = {},
  additional = false,
) {
  const base = connectorFixture()
  const manifest = {
    ...base.activation.revision.manifest,
    connectors: [
      {
        ...base.activation.revision.manifest.connectors![0]!,
        setup: { executable: 'tool' },
      },
      ...(additional
        ? [
            {
              ...base.activation.revision.manifest.connectors![0]!,
              id: 'second',
              setup: { executable: 'tool' },
            },
          ]
        : []),
    ],
    access: [
      {
        id: 'project',
        description: 'Project instructions',
        context: 'workspace' as const,
        mode: 'read-only' as const,
        ...access,
      },
    ],
  }
  base.dispose()
  const native = connectorFixture('application', undefined, undefined, {
    ...base.activation.revision,
    manifest,
  })
  const source = sourceFixture('workspace', undefined, undefined, manifest)
  source.active.set('installation', native.activation)
  await source.approvals.start()
  const scopes = new RendererResourceScopes(),
    renderer = scopes.activateOwner(1)
  const choose = vi.fn<() => Promise<string | undefined>>(() =>
    Promise.resolve(undefined),
  )
  const connection = new ExtensionConnectorConnectionOwner(
    scopes,
    () => true,
    native.authority,
    native.approvals,
    { folders: ['/installed'], choose },
    () => {},
    source.approvals,
  )
  source.revoked.mockImplementation((_id, _source, _binding, cancelRequests) => {
    if (cancelRequests) connection.revalidate()
  })
  const context = { ...source.caller.context()!, observeCurrent: () => () => {} }
  const sourceGrant = async () => {
    const prepared = await source.approvals.prepareWorkspaceRead(
      native.activation,
      'project',
      context,
      () => {},
      native.controller.signal,
    )
    try {
      await prepared.approve()
    } finally {
      prepared.cancel()
    }
  }
  const start = () =>
    connection.request(
      native.activation,
      renderer,
      () => {},
      native.controller.signal,
      () => true,
      'tool',
      false,
      context,
      'project',
    )
  const proposal = async () => {
    await vi.waitFor(() => expect(connection.snapshot(renderer)).toHaveLength(1))
    return connection.snapshot(renderer)[0]!
  }
  const decide = async (accepted = true) =>
    connection.decide(renderer, (await proposal()).id, accepted)
  stops.push(() => {
    connection.dispose()
    native.dispose()
    source.dispose()
  })
  return {
    native,
    source,
    connection,
    renderer,
    start,
    proposal,
    decide,
    sourceGrant,
    choose,
    context,
  }
}
it('prepares exact independent scopes for one decision, then saves source and program independently', async () => {
  const f = await fixture(),
    operation = f.start(),
    proposal = await f.proposal()
  expect(proposal.source).toEqual({
    source: 'project',
    workspace: 'Workspace',
    root: localPath('/library'),
  })
  expect(proposal.programs[0]?.canonicalExecutable).toBe('/installed/tool')
  expect(f.source.state()).toEqual([])
  expect(f.native.state()).toEqual([])
  await f.decide()
  expect(await operation).toEqual({
    connections: [{ connector: 'tool', outcome: 'connected' }],
    source: { source: 'project', outcome: 'granted' },
    readiness: { program: true, source: true },
  })
  expect(f.native.state()).toHaveLength(1)
  expect(f.source.state()).toHaveLength(1)
  expect(f.native.host.exec).not.toHaveBeenCalled()
})
it.each(['program', 'source', 'both'])(
  'reuses valid %s access and requests only missing scope',
  async (saved) => {
    const f = await fixture()
    if (saved !== 'source') await f.native.approve()
    if (saved !== 'program') await f.sourceGrant()
    const nativeWrites = f.native.write.mock.calls.length,
      sourceWrites = f.source.authority.saveSourceGrants.mock.calls.length
    const operation = f.start()
    if (saved !== 'both') {
      const proposal = await f.proposal()
      expect(proposal.programs).toHaveLength(saved === 'program' ? 0 : 1)
      expect(!!proposal.source).toBe(saved === 'program')
      await f.decide()
    }
    expect(await operation).toMatchObject({
      connections: [{ outcome: 'connected' }],
      source: { outcome: 'granted' },
    })
    expect(f.native.write).toHaveBeenCalledTimes(
      nativeWrites + (saved === 'source' ? 1 : 0),
    )
    expect(f.source.authority.saveSourceGrants).toHaveBeenCalledTimes(
      sourceWrites + (saved === 'program' ? 1 : 0),
    )
    expect(f.connection.snapshot(f.renderer)).toEqual([])
  },
)
it.each(['decline', 'cancel', 'source-revoke', 'native-revoke', 'target-change'])(
  'settles source-only consent truthfully on %s',
  async (ending) => {
    const f = await fixture()
    await f.native.approve()
    const operation = f.start(),
      proposal = await f.proposal()
    if (ending === 'decline') f.connection.decide(f.renderer, proposal.id, false)
    else if (ending === 'cancel') f.native.controller.abort()
    else if (ending === 'source-revoke') {
      await f.source.approvals.revoke('installation', 'project')
      f.connection.revalidate()
    } else if (ending === 'native-revoke') {
      await f.native.approvals.revoke('installation', 'tool', 'local')
      f.connection.revalidate()
    } else {
      f.native.host.realpath.mockResolvedValue(localPath('/changed/tool'))
      f.connection.decide(f.renderer, proposal.id, true)
    }
    const result = await operation
    expect(result.source?.outcome).toBe(ending === 'decline' ? 'declined' : 'unavailable')
    expect(result.connections[0]?.outcome).toBe('connected')
    expect(result.readiness).toEqual(
      ending === 'decline'
        ? { program: true, source: false }
        : ending === 'target-change'
          ? { program: false, source: false }
          : { program: null, source: null },
    )
    expect(f.source.authority.saveSourceGrants).toHaveBeenCalledTimes(
      ending === 'source-revoke' ? 1 : 0,
    )
    expect(f.connection.snapshot(f.renderer)).toEqual([])
  },
)
it('retains a successful source write when subsequent program persistence fails', async () => {
  const f = await fixture()
  f.native.write.mockRejectedValue(new Error('Native persistence failed'))
  const operation = f.start()
  await f.decide()
  expect(await operation).toMatchObject({
    connections: [{ outcome: 'interrupted-uncertain' }],
    source: { outcome: 'granted' },
  })
  expect(f.source.state()).toHaveLength(1)
})
it('keeps the source handle current through the program writer and rejects withdrawal between writes', async () => {
  const f = await fixture()
  const write = f.source.authority.saveSourceGrants.getMockImplementation()!
  f.source.authority.saveSourceGrants.mockImplementation(async (...args) => {
    await write(...args)
    f.native.controller.abort()
  })
  const operation = f.start()
  await f.decide()
  expect(await operation).toMatchObject({
    connections: [{ outcome: 'unavailable' }],
    source: { outcome: 'interrupted-uncertain' },
  })
  expect(f.source.state()).toHaveLength(1)
  expect(f.native.write).not.toHaveBeenCalled()
})
it.each([
  ['unknown', {}],
  ['project', { context: 'application' }],
  ['project', { mode: 'managed-delivery' }],
] as const)(
  'refuses invalid source %s %j at admission before discovery or picker',
  async (source, access) => {
    const f = await fixture(access)
    const prepare = vi.spyOn(f.native.approvals, 'prepare')
    await expect(
      f.connection.request(
        f.native.activation,
        f.renderer,
        () => {},
        f.native.controller.signal,
        () => true,
        'tool',
        false,
        { ...f.source.caller.context()!, observeCurrent: () => () => {} },
        source,
      ),
    ).rejects.toThrow('declared workspace read-only source')
    expect(f.native.host.realpath).not.toHaveBeenCalled()
    expect(f.native.host.stat).not.toHaveBeenCalled()
    expect(f.choose).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
    expect(f.connection.snapshot(f.renderer)).toEqual([])
    expect(f.native.write).not.toHaveBeenCalled()
  },
)

it('reports a completed source save with withdrawn readiness if it is revoked during the native save', async () => {
  const f = await fixture(),
    write = f.native.write.getMockImplementation()!
  f.native.write.mockImplementation(async (...args) => {
    await write(...args)
    await f.source.approvals.revoke('installation', 'project')
  })
  const operation = f.start()
  await f.decide()
  const result = await operation
  expect(result.source?.outcome).toBe('granted')
  expect(result.readiness).toEqual({ program: null, source: null })
  expect(f.native.state()).toHaveLength(1)
  expect(f.source.state()).toEqual([])
})
it('reports a completed program write without current readiness after its target changes', async () => {
  const f = await fixture(),
    write = f.native.write.getMockImplementation()!
  f.native.write.mockImplementation(async (...args) => {
    await write(...args)
    f.native.host.realpath.mockResolvedValue(localPath('/changed/tool'))
  })
  const operation = f.start()
  await f.decide()
  const result = await operation
  expect(result.connections[0]?.outcome).toBe('connected')
  expect(result.readiness).toEqual({ program: false, source: true })
  expect(f.native.state()).toHaveLength(1)
  expect(f.source.state()).toHaveLength(1)
})
it('a cancelled program picker does not follow up with a source decision', async () => {
  const f = await fixture()
  f.native.host.stat.mockRejectedValue(
    Object.assign(new Error('Missing'), { code: 'ENOENT' }),
  )
  expect(await f.start()).toMatchObject({
    connections: [{ outcome: 'unavailable' }],
    source: { outcome: 'unavailable' },
    readiness: { program: false, source: false },
  })
  expect(f.connection.snapshot(f.renderer)).toEqual([])
  expect(f.source.authority.saveSourceGrants).not.toHaveBeenCalled()
})

function held<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
it('expires combined source-only consent without losing the reused fact or starting late metadata', async () => {
  const f = await fixture()
  await f.native.approve()
  vi.useFakeTimers()
  const operation = f.start(),
    proposal = await f.proposal()
  const metadata = f.native.host.realpath.mock.calls.length
  await vi.advanceTimersByTimeAsync(60_000)
  expect(await operation).toMatchObject({
    connections: [{ outcome: 'connected' }],
    source: { outcome: 'unavailable' },
    readiness: { program: null, source: null },
  })
  expect(f.native.host.realpath).toHaveBeenCalledTimes(metadata)
  expect(() => f.connection.decide(f.renderer, proposal.id, true)).toThrow('ended')
  expect(f.native.state()).toHaveLength(1)
  expect(f.source.state()).toEqual([])
  expect(vi.getTimerCount()).toBe(0)
})
it.each(['program', 'source'] as const)(
  'retires a late %s preparation after combined cancellation',
  async (scope) => {
    const f = await fixture(),
      entered = held<() => Promise<void>>(),
      release = held<void>()
    if (scope === 'program') {
      const prepare = f.native.approvals.prepare.bind(f.native.approvals)
      vi.spyOn(f.native.approvals, 'prepare').mockImplementation(async (...args) => {
        const value = await prepare(...args)
        entered.resolve(() => f.native.approvals.approve(value.token))
        await release.promise
        return value
      })
    } else {
      const prepare = f.source.approvals.prepareWorkspaceRead.bind(f.source.approvals)
      vi.spyOn(f.source.approvals, 'prepareWorkspaceRead').mockImplementation(
        async (...args) => {
          const value = await prepare(...args)
          entered.resolve(value.approve)
          await release.promise
          return value
        },
      )
    }
    const operation = f.start(),
      approveLate = await entered.promise
    f.native.controller.abort()
    expect((await operation).readiness).toEqual({ program: null, source: null })
    release.resolve()
    await Promise.resolve()
    await expect(approveLate()).rejects.toThrow()
    expect(f.connection.snapshot(f.renderer)).toEqual([])
    expect(f.native.write).not.toHaveBeenCalled()
    expect(f.source.authority.saveSourceGrants).not.toHaveBeenCalled()
  },
)
it.each(['program', 'source'] as const)(
  'awaits physical %s persistence after cancellation and reports uncertainty',
  async (scope) => {
    const f = await fixture(),
      entered = held<void>(),
      release = held<void>()
    const writer =
      scope === 'program' ? f.native.write : f.source.authority.saveSourceGrants
    const write = writer.getMockImplementation()!
    writer.mockImplementation(async (...args) => {
      await write(...args)
      entered.resolve()
      await release.promise
    })
    let settled = false
    const operation = f.start().then((value) => {
      settled = true
      return value
    })
    await f.decide()
    await entered.promise
    f.native.controller.abort()
    await Promise.resolve()
    expect(settled).toBe(false)
    release.resolve()
    const result = await operation
    expect(result.readiness).toEqual({ program: null, source: null })
    expect(result.source?.outcome).toBe(
      scope === 'source' ? 'interrupted-uncertain' : 'granted',
    )
    expect(result.connections[0]?.outcome).toBe(
      scope === 'program' ? 'interrupted-uncertain' : 'unavailable',
    )
    expect(f.source.state()).toHaveLength(1)
    expect(f.native.state()).toHaveLength(scope === 'program' ? 1 : 0)
    expect(f.connection.snapshot(f.renderer)).toEqual([])
  },
)
it('rejects a registered source identity change during its write before program persistence', async () => {
  const f = await fixture(),
    write = f.source.authority.saveSourceGrants.getMockImplementation()!
  f.source.authority.saveSourceGrants.mockImplementation(async (...args) => {
    await write(...args)
    f.source.workspaces[0] = {
      ...f.source.workspaces[0]!,
      root: localPath('/replacement'),
    }
    f.connection.revalidate()
  })
  const operation = f.start()
  await f.decide()
  expect(await operation).toMatchObject({
    source: { outcome: 'interrupted-uncertain' },
    connections: [{ outcome: 'unavailable' }],
  })
  expect(f.source.state()).toHaveLength(1)
  expect(f.native.write).not.toHaveBeenCalled()
  expect(f.connection.snapshot(f.renderer)).toEqual([])
})

it('pins the currently trusted executable through source-only consent instead of the saved baseline', async () => {
  const f = await fixture(),
    prior = await f.native.approve()
  const trust = await f.native.approvals.prepare(
    prior,
    () => {},
    { approval: prior },
    true,
  )
  await f.native.approvals.approve(trust.token)
  f.native.host.realpath.mockResolvedValue(localPath('/updated/tool'))
  const operation = f.start(),
    proposal = await f.proposal()
  expect(proposal.programs).toEqual([])
  await f.decide()
  expect(await operation).toMatchObject({
    connections: [{ outcome: 'connected' }],
    readiness: { program: true, source: true },
  })
  expect(
    f.native.approvals.get(f.native.activation, 'tool', 'local')?.canonicalExecutable,
  ).toBe(prior.canonicalExecutable)
})

it('waits for fresh selected presentation after picker return before preparing combined consent', async () => {
  const f = await fixture(),
    entered = held<void>(),
    selected = held<string | undefined>(),
    waiting = held<void>()
  f.native.host.stat.mockImplementation((path) =>
    path.path.startsWith('/installed')
      ? Promise.reject(Object.assign(new Error('Absent'), { code: 'ENOENT' }))
      : Promise.resolve({ type: 'file', mode: 0o755, size: 3, mtimeMs: 0 }),
  )
  f.choose.mockImplementation(() => {
    entered.resolve()
    return selected.promise
  })
  const prepare = vi.spyOn(f.native.approvals, 'prepare')
  let visible = true,
    returned = false
  const operation = f.connection.request(
    f.native.activation,
    f.renderer,
    (passive) => {
      if (!passive && !visible) throw new Error('Ordinary view not visible')
      if (passive && returned && !visible) waiting.resolve()
      return visible
    },
    f.native.controller.signal,
    () => true,
    'tool',
    false,
    f.context,
    'project',
  )
  await entered.promise
  visible = false
  returned = true
  selected.resolve('/selected/tool')
  await waiting.promise
  expect(prepare).not.toHaveBeenCalled()
  expect(f.connection.snapshot(f.renderer)).toEqual([])
  expect(f.native.write).not.toHaveBeenCalled()
  visible = true
  f.connection.revalidate()
  await f.decide()
  expect((await operation).readiness).toEqual({ program: true, source: true })
  expect(prepare).toHaveBeenCalledOnce()
})
it.each([false, true])(
  'preserves a reused native grant on cancelled multi-program consent (automatic=%s)',
  async (automatic) => {
    const f = await fixture({}, true)
    await f.native.approve()
    const operation = f.connection.request(
      f.native.activation,
      f.renderer,
      () => {},
      f.native.controller.signal,
      () => true,
      undefined,
      automatic,
    )
    await f.proposal()
    const metadata = f.native.host.realpath.mock.calls.length
    f.native.controller.abort()
    expect((await operation).connections).toEqual([
      { connector: 'tool', outcome: 'connected' },
      expect.objectContaining({ connector: 'second', outcome: 'unavailable' }),
    ])
    expect(f.native.host.realpath).toHaveBeenCalledTimes(metadata)
    expect(f.native.state()).toHaveLength(1)
  },
)
