import { afterEach, expect, it, vi } from 'vitest'
import { RendererResourceScopes } from '../src/main/renderer-resource-scopes'
import { ExtensionConnectorConnectionOwner } from '../src/main/extensions/connector-connection'
import { connectorFixture } from './fixtures/extension-connector'
import { sourceFixture } from './fixtures/extension-source'
import { localPath } from '../src/shared/host-path'

const stops: (() => void)[] = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  vi.useRealTimers()
})
async function fixture() {
  const base = connectorFixture()
  const manifest = {
    ...base.activation.revision.manifest,
    connectors: [
      {
        ...base.activation.revision.manifest.connectors![0]!,
        setup: { executable: 'tool' },
      },
    ],
    access: [
      {
        id: 'project',
        description: 'Project instructions',
        context: 'workspace' as const,
        mode: 'read-only' as const,
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
  const connection = new ExtensionConnectorConnectionOwner(
    scopes,
    () => true,
    native.authority,
    native.approvals,
    { folders: ['/installed'], choose: () => Promise.resolve(undefined) },
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
  return { native, source, connection, renderer, start, proposal, decide, sourceGrant }
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
    expect(result.connections[0]?.outcome).toBe(
      ending === 'decline' ? 'connected' : 'unavailable',
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
it('refuses invalid source declarations without granting native permission', async () => {
  const f = await fixture()
  const operation = f.connection.request(
    f.native.activation,
    f.renderer,
    () => {},
    f.native.controller.signal,
    () => true,
    'tool',
    false,
    { ...f.source.caller.context()!, observeCurrent: () => () => {} },
    'unknown',
  )
  expect(await operation).toMatchObject({
    connections: [{ outcome: 'unavailable' }],
    source: { outcome: 'unavailable' },
  })
  expect(f.connection.snapshot(f.renderer)).toEqual([])
  expect(f.native.write).not.toHaveBeenCalled()
})

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
  expect(result.readiness).toEqual({ program: false, source: false })
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
