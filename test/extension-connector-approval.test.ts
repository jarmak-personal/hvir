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
  it.each(['absent', 'saved'] as const)(
    'binds the exact %s approval at consent and refuses a different saved binding before replacement',
    async (before) => {
      const f = fixture()
      if (before === 'saved') await f.approve('/installed/old', { args: [], env: {} })
      const expected = f.approvals.get(f.activation, 'tool')
      const prepared = await f.approvals.prepare(
        {
          installationId: 'installation',
          connector: 'tool',
          host: 'local',
          executable: '/installed/replacement',
          configuration: { args: [], env: {} },
        },
        () => undefined,
        { approval: expected },
      )
      const newer = await f.approve('/installed/newer', { args: [], env: {} })
      const writes = f.write.mock.calls.length
      await expect(f.approvals.approve(prepared.token)).rejects.toThrow(
        'Saved connector access changed',
      )
      expect(f.approvals.get(f.activation, 'tool')).toBe(newer)
      expect(f.write).toHaveBeenCalledTimes(writes)
      expect(f.state()).toEqual([newer])
      expect(f.host.exec).not.toHaveBeenCalled()
    },
  )
  it('refuses replacement whose expected saved binding changes during canonical preparation', async () => {
    const f = fixture()
    const prior = await f.approve('/installed/old', { args: [], env: {} })
    let resume!: () => void, entered!: () => void
    const blocked = new Promise<void>((resolve) => {
      resume = resolve
    })
    const reached = new Promise<void>((resolve) => {
      entered = resolve
    })
    f.host.realpath.mockImplementationOnce(async (path) => {
      entered()
      await blocked
      return path
    })
    const preparation = f.approvals.prepare(
      {
        installationId: 'installation',
        connector: 'tool',
        host: 'local',
        executable: '/installed/replacement',
        configuration: { args: [], env: {} },
      },
      () => undefined,
      { approval: prior },
    )
    const rejected = expect(preparation).rejects.toThrow('Saved connector access changed')
    await reached
    const newer = await f.approve('/installed/newer', { args: [], env: {} })
    resume()
    await rejected
    expect(f.approvals.get(f.activation, 'tool')).toBe(newer)
    expect(f.state()).toEqual([newer])
  })
  it('keeps a prior-bound replacement revoked during its submitted save from restoring authority', async () => {
    const f = fixture()
    const prior = await f.approve('/installed/old', { args: [], env: {} })
    const prepared = await f.approvals.prepare(
      {
        installationId: 'installation',
        connector: 'tool',
        host: 'local',
        executable: '/installed/replacement',
        configuration: { args: [], env: {} },
      },
      () => undefined,
      { approval: prior },
    )
    let resume!: () => void, entered!: () => void
    const blocked = new Promise<void>((resolve) => {
      resume = resolve
    })
    const reached = new Promise<void>((resolve) => {
      entered = resolve
    })
    const write = f.write.getMockImplementation()!
    f.write.mockImplementationOnce(async (value, current) => {
      entered()
      await blocked
      await write(value, current)
    })
    const saving = f.approvals.approve(prepared.token)
    const rejected = expect(saving).rejects.toThrow()
    await reached
    const revoking = f.approvals.revoke('installation', 'tool')
    expect(f.approvals.get(f.activation, 'tool')).toBeUndefined()
    resume()
    await rejected
    await revoking
    expect(f.state()).toEqual([])
    expect(f.approvals.get(f.activation, 'tool')).toBeUndefined()
  })
  it.each(['writable', 'canonical'] as const)(
    'cannot publish a prepared decision revoked during %s inspection',
    async (boundary) => {
      const f = fixture()
      await f.approvals.start()
      let resume!: () => void
      const blocked = new Promise<void>((resolve) => {
        resume = resolve
      })
      let entered!: () => void
      const reached = new Promise<void>((resolve) => {
        entered = resolve
      })
      if (boundary === 'writable')
        f.authority.assertWritable.mockImplementationOnce(async () => {
          entered()
          await blocked
        })
      else
        f.host.realpath.mockImplementationOnce(async (path) => {
          entered()
          await blocked
          return path
        })
      const preparing = f.approvals.prepare(
        {
          installationId: 'installation',
          connector: 'tool',
          host: 'local',
          executable: '/installed/tool',
          configuration: { args: [], env: {} },
        },
        () => undefined,
      )
      const rejected = expect(preparing).rejects.toThrow()
      await reached
      const revoking = f.approvals.revoke('installation', 'tool')
      resume()
      await rejected
      await revoking
      expect(f.approvals.get(f.activation, 'tool')).toBeUndefined()
      expect(f.state()).toEqual([])
      expect(f.host.exec).not.toHaveBeenCalled()
    },
  )
  it.each(['writable', 'canonical', 'save'] as const)(
    'cannot restore a captured decision revoked during %s',
    async (boundary) => {
      const f = fixture()
      await f.approvals.start()
      const prepared = await f.approvals.prepare(
        {
          installationId: 'installation',
          connector: 'tool',
          host: 'local',
          executable: '/installed/tool',
          configuration: { args: [], env: {} },
        },
        () => undefined,
      )
      let resume!: () => void
      const blocked = new Promise<void>((resolve) => {
        resume = resolve
      })
      let entered!: () => void
      const reached = new Promise<void>((resolve) => {
        entered = resolve
      })
      if (boundary === 'writable')
        f.authority.assertWritable.mockImplementationOnce(async () => {
          entered()
          await blocked
        })
      else if (boundary === 'canonical')
        f.host.realpath.mockImplementationOnce(async (path) => {
          entered()
          await blocked
          return path
        })
      else
        f.write.mockImplementationOnce(async (_value, current) => {
          entered()
          await blocked
          current()
        })
      const approving = f.approvals.approve(prepared.token)
      const rejected = expect(approving).rejects.toThrow()
      await reached
      const revoking = f.approvals.revoke('installation', 'tool')
      expect(f.approvals.get(f.activation, 'tool')).toBeUndefined()
      resume()
      await rejected
      await revoking
      expect(f.approvals.get(f.activation, 'tool')).toBeUndefined()
      expect(f.state()).toEqual([])
      expect(f.host.exec).not.toHaveBeenCalled()
    },
  )
  it('does not restore another revoked connector from an in-flight approval snapshot', async () => {
    const f = fixture()
    await f.approve()
    Object.assign(f.activation.revision.manifest, {
      connectors: [
        ...f.activation.revision.manifest.connectors!,
        { ...f.activation.revision.manifest.connectors![0]!, id: 'other' },
      ],
    })
    const prepared = await f.approvals.prepare(
      {
        installationId: 'installation',
        connector: 'other',
        host: 'local',
        executable: '/installed/other',
        configuration: { args: [], env: {} },
      },
      () => undefined,
    )
    let resume!: () => void
    const blocked = new Promise<void>((resolve) => {
      resume = resolve
    })
    let entered!: () => void
    const reached = new Promise<void>((resolve) => {
      entered = resolve
    })
    f.write.mockImplementationOnce(async (value, current) => {
      entered()
      await blocked
      current()
      f.setState(value)
    })
    const approving = f.approvals.approve(prepared.token)
    await reached
    const revoking = f.approvals.revoke('installation', 'tool')
    resume()
    await approving
    expect(f.approvals.get(f.activation, 'tool')).toBeUndefined()
    expect(await f.execution.execute(f.caller, f.input)).toMatchObject({
      outcome: 'not-started',
      reason: 'unapproved',
    })
    await revoking
    expect(f.state()).toEqual([prepared.approval])
    expect(f.host.exec).not.toHaveBeenCalled()
  })
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
    expect(f.approvals.forget('installation')).toBeUndefined()
    expect(f.write).not.toHaveBeenCalled()
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
