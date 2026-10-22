import { describe, expect, it } from 'vitest'
import { connectorFixture } from './fixtures/extension-connector'
import { sourceFixture } from './fixtures/extension-source'
import { localPath } from '../src/shared/host-path'
import type { ExtensionSourceGrant } from '../src/shared/extensions/source-access'

describe('setup uses each permission owner admission', () => {
  it('projects the complete native store and applies the same replacement and global byte bound', async () => {
    const f = connectorFixture()
    try {
      const approval = await f.approve()
      const existing = Array.from({ length: 256 }, (_, i) => ({
        ...approval,
        installationId: `installation-${i}`,
      }))
      f.setState(existing)
      await f.approvals.start()
      expect(
        f.approvals.project([{ ...approval, installationId: 'installation-0' }]).records,
      ).toBe(256)
      expect(() => f.approvals.project([approval])).toThrow(/bound/)
      f.setState(
        Array.from({ length: 32 }, (_, i) => ({
          ...approval,
          installationId: `other-${i}`,
          configuration: { args: ['x'.repeat(7800)], env: {} },
        })),
      )
      await f.approvals.start()
      expect(() =>
        f.approvals.project([
          { ...approval, configuration: { args: ['x'.repeat(7800)], env: {} } },
        ]),
      ).toThrow(/bound/)
      expect(f.write).toHaveBeenCalledTimes(1)
    } finally {
      f.dispose()
    }
  })
  it('captures obsolete native declarations rather than treating their saved binding as absent', async () => {
    const f = connectorFixture()
    try {
      const approval = await f.approve()
      const next = {
        ...f.activation,
        revision: {
          ...f.activation.revision,
          manifest: {
            ...f.activation.revision.manifest,
            connectors: [{ ...approval.declaration, description: 'New declaration' }],
          },
        },
      }
      f.active.set('installation', next)
      expect(f.approvals.get(next, 'tool', 'local')).toBeUndefined()
      const prior = f.approvals.capturePrior(approval)
      expect(prior.approval).toBe(approval)
      const prepared = await f.approvals.prepare(approval, () => {}, prior)
      f.approvals.cancelPrepared(prepared.token)
      expect(f.write).toHaveBeenCalledTimes(1)
    } finally {
      f.dispose()
    }
  })
  it('refuses a changed source prior while leaving ordinary prepare callers unchanged', async () => {
    const f = sourceFixture()
    try {
      await f.grant()
      const selection = { installationId: 'installation', source: 'source', root: f.root }
      const prior = f.approvals.capturePrior(selection)
      const reviewed = await f.approvals.prepare(selection, () => {}, prior)
      const manual = await f.approvals.prepare(selection, () => {})
      await f.approvals.approve(manual.token)
      await expect(f.approvals.approve(reviewed.token)).rejects.toThrow(/changed/)
      await expect(f.approvals.prepare(selection, () => {}, prior)).rejects.toThrow(
        /changed/,
      )
      expect(f.approvals.status(f.activation)[0]?.granted).toBe(true)
    } finally {
      f.dispose()
    }
  })
  it('keeps unrelated workspace grants outside exact source CAS and projects retained/replaced declarations', async () => {
    const f = sourceFixture('workspace')
    try {
      await f.grant()
      f.workspaces.push({
        id: 'second',
        name: 'Second',
        host: f.root.hostId,
        root: localPath('/second'),
      })
      f.host.stat.mockResolvedValue({ type: 'dir', mode: 0o755, size: 0, mtimeMs: 0 })
      const first = {
        installationId: 'installation',
        source: 'source',
        workspaceId: 'workspace',
      }
      const prior = f.approvals.capturePrior(first)
      const b = await f.approvals.prepare({ ...first, workspaceId: 'second' }, () => {})
      await f.approvals.approve(b.token)
      const a = await f.approvals.prepare(first, () => {}, prior)
      expect(f.approvals.project([a.grant]).records).toBe(2)
      await f.approvals.approve(a.token)
      const application: ExtensionSourceGrant = {
        installationId: 'installation',
        declaration: { ...f.declaration, context: 'application' },
        root: f.root,
      }
      expect(f.approvals.project([application]).records).toBe(1)
      expect(() => f.approvals.project([application, a.grant])).toThrow(/Duplicate/)
      expect(f.approvals.settings(f.activation)).toHaveLength(2)
    } finally {
      f.dispose()
    }
  })
  it('projects global source count and bytes without evicting another installation', async () => {
    const f = sourceFixture()
    try {
      await f.grant()
      const saved = (f.state() as ExtensionSourceGrant[])[0]!
      const records = Array.from({ length: 128 }, (_, i) => ({
        ...saved,
        installationId: `other-${i}`,
      }))
      f.authority.readSourceGrants.mockResolvedValue(records)
      await f.approvals.start()
      expect(() => f.approvals.project([saved])).toThrow(/capacity/)
      expect(f.approvals.project([{ ...saved, installationId: 'other-0' }]).records).toBe(
        128,
      )
      f.authority.readSourceGrants.mockResolvedValue(
        Array.from({ length: 32 }, (_, i) => ({
          ...saved,
          installationId: `other-${i}`,
          root: localPath('/' + 'x'.repeat(3900)),
        })),
      )
      await f.approvals.start()
      expect(() =>
        f.approvals.project([{ ...saved, root: localPath('/' + 'y'.repeat(3900)) }]),
      ).toThrow(/capacity/)
      expect(f.authority.saveSourceGrants).toHaveBeenCalledTimes(1)
    } finally {
      f.dispose()
    }
  })
  it('captures obsolete source bindings using the new declaration replacement scope and fences concurrent replacement', async () => {
    const f = sourceFixture('workspace')
    try {
      await f.grant()
      f.workspaces.push({
        id: 'second',
        name: 'Second',
        host: f.root.hostId,
        root: localPath('/second'),
      })
      f.host.stat.mockResolvedValue({ type: 'dir', mode: 0o755, size: 0, mtimeMs: 0 })
      const second = await f.approvals.prepare(
        { installationId: 'installation', source: 'source', workspaceId: 'second' },
        () => {},
      )
      await f.approvals.approve(second.token)
      const next = {
        ...f.activation,
        revision: {
          ...f.activation.revision,
          manifest: {
            ...f.activation.revision.manifest,
            access: [{ ...f.declaration, context: 'application' as const }],
          },
        },
      }
      f.active.set('installation', next)
      const selection = { installationId: 'installation', source: 'source', root: f.root }
      const prior = f.approvals.capturePrior(selection)
      expect(prior.grants).toHaveLength(2)
      const reviewed = await f.approvals.prepare(selection, () => {}, prior)
      expect(f.approvals.project([reviewed.grant]).records).toBe(1)
      const manual = await f.approvals.prepare(selection, () => {})
      await f.approvals.approve(manual.token)
      await expect(f.approvals.approve(reviewed.token)).rejects.toThrow(/changed/)
      expect(f.approvals.settings(next)).toHaveLength(1)
    } finally {
      f.dispose()
    }
  })
})
