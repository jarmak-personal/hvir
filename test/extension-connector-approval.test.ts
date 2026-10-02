import { afterEach, describe, expect, it } from 'vitest'
import { connectorFixture } from './fixtures/extension-connector'
import { localPath } from '../src/shared/host-path'
import { ExtensionConnectorApprovalOwner } from '../src/main/extensions/connector-approval'

const fixtures: ReturnType<typeof connectorFixture>[] = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.dispose()
})
function fixture(context: 'application' | 'workspace' = 'application') {
  const value = connectorFixture(context)
  fixtures.push(value)
  return value
}
describe('native connector approval', () => {
  it('cannot accept a prepared native decision after its trusted renderer origin ends', async () => {
    const f = fixture()
    await f.approvals.start()
    let current = true
    const prepared = await f.approvals.prepare(
      {
        installationId: 'installation',
        connector: 'tool',
        host: 'local',
        executable: '/installed/tool',
        configuration: { args: [], env: {} },
      },
      () => {
        if (!current) throw new Error('Renderer ended')
      },
    )
    current = false
    await expect(f.approvals.approve(prepared.token)).rejects.toThrow('Renderer ended')
    expect(f.approvals.get(f.activation, 'tool')).toBeUndefined()
    expect(f.host.exec).not.toHaveBeenCalled()
  })
  it('executes nothing during discovery, inspection or explicit approval and persists the complete binding', async () => {
    const f = fixture(),
      approval = await f.approve()
    expect(f.host.exec).not.toHaveBeenCalled()
    expect(f.state()).toEqual([approval])
    expect(f.approvals.status(f.activation)).toEqual([
      {
        connector: 'tool',
        availability: 'supported',
        host: 'local',
        executable: '/installed/tool',
      },
    ])
  })
  it('refuses forged hosts, remote application contexts and undeclared environment without executing probes', async () => {
    const f = fixture()
    await f.approvals.start()
    const selection = {
      installationId: 'installation',
      connector: 'tool',
      executable: '/installed/tool',
      configuration: { args: [], env: {} },
      host: 'forged',
    }
    await expect(f.approvals.prepare(selection, () => undefined)).rejects.toThrow(
      'configured host',
    )
    await expect(
      f.approvals.prepare(
        {
          ...selection,
          host: 'local',
          configuration: { args: [], env: { UNDECLARED: 'secret' } },
        },
        () => undefined,
      ),
    ).rejects.toThrow('undeclared')
    expect(f.host.exec).not.toHaveBeenCalled()
  })
  it('pins the canonical symlink target through the explicit decision', async () => {
    const f = fixture()
    await f.approvals.start()
    f.host.realpath.mockResolvedValueOnce(localPath('/versions/a'))
    const prepared = await f.approvals.prepare(
      {
        installationId: 'installation',
        connector: 'tool',
        host: 'local',
        executable: '/installed/link',
        configuration: { args: [], env: {} },
      },
      () => undefined,
    )
    expect(prepared.approval.canonicalExecutable).toBe('/versions/a')
    f.host.realpath.mockResolvedValueOnce(localPath('/versions/b'))
    await expect(f.approvals.approve(prepared.token)).rejects.toThrow('target changed')
    expect(f.approvals.get(f.activation, 'tool')).toBeUndefined()
  })
  it('reuses unchanged persisted approval on a new activation, but changed declarations cannot consume it', async () => {
    const f = fixture()
    await f.approve()
    const restored = new ExtensionConnectorApprovalOwner(
      f.hosts,
      f.authority,
      () => undefined,
    )
    await restored.start()
    const next = { ...f.activation, generation: 'next' }
    f.active.set('installation', next)
    expect(restored.get(next, 'tool')).toBeDefined()
    const changed = {
      ...next,
      revision: {
        ...next.revision,
        manifest: {
          ...next.revision.manifest,
          connectors: [{ ...next.revision.manifest.connectors![0]!, timeoutMs: 1000 }],
        },
      },
    }
    f.active.set('installation', changed)
    expect(restored.get(changed, 'tool')).toBeUndefined()
    restored.dispose()
  })
  it('revokes before saving and keeps access revoked when persistence fails', async () => {
    const f = fixture()
    await f.approve()
    f.write.mockRejectedValueOnce(new Error('write failed'))
    await expect(f.approvals.revoke('installation', 'tool')).rejects.toThrow(
      'write failed',
    )
    expect(f.approvals.get(f.activation, 'tool')).toBeUndefined()
    expect(f.approvals.status(f.activation)[0]!.availability).toBe('unavailable')
  })
  it('fails closed on malformed saved authority without disabling the activation', async () => {
    const f = fixture()
    f.setState([{ connector: 'tool' }])
    await f.approvals.start()
    expect(f.approvals.status(f.activation)[0]!.availability).toBe('unavailable')
    expect(f.active.get('installation')).toBe(f.activation)
    await expect(
      f.approvals.prepare(
        {
          installationId: 'installation',
          connector: 'tool',
          host: 'local',
          executable: '/installed/tool',
          configuration: { args: [], env: {} },
        },
        () => undefined,
      ),
    ).rejects.toThrow('cannot be read safely')
    expect(f.host.exec).not.toHaveBeenCalled()
  })
})
