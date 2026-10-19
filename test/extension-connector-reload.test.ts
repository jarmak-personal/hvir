import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { ExtensionConnectorApprovalOwner } from '../src/main/extensions/connector-approval'
import { localPath } from '../src/shared/host-path'
import { connectorFixture } from './fixtures/extension-connector'
import { extensionInstallationFixture } from './fixtures/extension-installation'

async function fixture() {
  const data = await extensionInstallationFixture(),
    native = connectorFixture()
  const owner = data.make((id) => {
    approvals.forget(id)
  })
  const approvals = new ExtensionConnectorApprovalOwner(
    native.hosts,
    owner,
    () => undefined,
  )
  data.revoke.mockImplementation(
    (
      id: string,
      reloading?: Parameters<ExtensionConnectorApprovalOwner['activationEnded']>[1],
    ) => approvals.activationEnded(id, reloading),
  )
  const connectors = native.activation.revision.manifest.connectors!
  await data.packageAt('example', { connectors })
  await owner.start(data.lock)
  await owner.enable('example', owner.snapshot().installations[0]!.revision!)
  await approvals.start()
  const activation = [...owner.active.values()][0]!
  const selection = {
    installationId: activation.installationId,
    connector: 'tool',
    host: 'local',
    executable: '/bin/tool',
    configuration: { args: [], env: {} },
  }
  native.host.realpath.mockResolvedValue(localPath('/versions/A/tool'))
  const prepared = await approvals.prepare(selection, () => undefined)
  await approvals.approve(prepared.token)
  const trusted = await approvals.prepare(selection, () => undefined, undefined, true)
  await approvals.approve(trusted.token)
  native.host.realpath.mockResolvedValue(localPath('/versions/B/tool'))
  return {
    ...data,
    native,
    owner,
    approvals,
    activation,
    connectors,
    prepared,
    stop: async () => {
      approvals.dispose()
      native.dispose()
      await owner.dispose()
      await data.dispose()
    },
  }
}

it('preserves session trust through unchanged package Reload while rejecting the old activation', async () => {
  const f = await fixture()
  try {
    await fs.writeFile(join(f.directory, 'example', 'index.html'), 'rebuilt view')
    await f.owner.reload('example', f.activation.revision.hash)
    const next = [...f.owner.active.values()][0]!
    expect(next).not.toBe(f.activation)
    expect(await f.approvals.resolve(f.activation, f.prepared.approval)).toMatchObject({
      reason: 'context-ended',
    })
    expect(await f.approvals.inspectStatus(next)).toMatchObject([
      { availability: 'supported' },
    ])
    expect(f.approvals.get(next, 'tool', 'local')).toBe(f.prepared.approval)
    f.approvals.endSession(f.prepared.approval)
    expect(await f.approvals.inspectStatus(next)).toMatchObject([
      { reason: 'executable-changed' },
    ])
  } finally {
    await f.stop()
  }
})

it('keeps the accepted activation and choice when Reload inspection fails before replacement', async () => {
  const f = await fixture()
  try {
    await fs.writeFile(join(f.directory, 'example', 'hvir-extension.json'), '{invalid')
    await expect(f.owner.reload('example', f.activation.revision.hash)).rejects.toThrow()
    expect(f.owner.active.get(f.activation.installationId)).toBe(f.activation)
    expect(f.revoke).not.toHaveBeenCalled()
    expect(f.approvals.settings(f.activation).connectors[0]?.trustUpdates).toBe(true)
    expect(await f.approvals.inspectStatus(f.activation)).toMatchObject([
      { availability: 'supported' },
    ])
  } finally {
    await f.stop()
  }
})

it.each([
  'disable',
  'remove',
  'forget',
  'writer-loss',
  'dispose',
  'declaration',
  'failed-reload-save',
] as const)(
  '%s ends the session choice through the real activation owner',
  async (fence) => {
    const f = await fixture()
    try {
      if (fence === 'disable') await f.owner.disable(f.activation.installationId)
      if (fence === 'remove' || fence === 'forget') {
        const installed = f.owner.snapshot().installations[0]!
        await f.owner.remove('example', installed.sourceIdentity, fence === 'forget')
      }
      if (fence === 'writer-loss') {
        await fs.rename(f.lock.path, f.lock.path + '.old')
        await fs.writeFile(f.lock.path, '')
        await expect(f.owner.assertWritable()).rejects.toThrow()
      }
      if (fence === 'dispose') await f.owner.dispose()
      if (fence === 'declaration') {
        const path = join(f.directory, 'example', 'hvir-extension.json')
        const manifest = JSON.parse(await fs.readFile(path, 'utf8')) as {
          connectors: { description: string }[]
        }
        manifest.connectors[0]!.description = 'Changed access declaration'
        await fs.writeFile(path, JSON.stringify(manifest))
        await f.owner.reload('example', f.activation.revision.hash)
      }
      if (fence === 'failed-reload-save') {
        const write = f.host.writeFile.bind(f.host)
        const intercepted = vi
          .spyOn(f.host, 'writeFile')
          .mockImplementation((path, data, opts) => {
            if (path.path === join(f.root, 'state.json'))
              return Promise.reject(new Error('Save failed'))
            return write(path, data, opts)
          })
        await expect(
          f.owner.reload('example', f.activation.revision.hash),
        ).rejects.toThrow('Save failed')
        intercepted.mockRestore()
      }
      expect(
        f.approvals
          .settings(f.activation)
          .connectors.every((entry) => !entry.trustUpdates),
      ).toBe(true)
      if (fence === 'disable' || fence === 'failed-reload-save') {
        await f.owner.enable('example', f.activation.revision.hash)
        const next = [...f.owner.active.values()][0]!
        expect(await f.approvals.inspectStatus(next)).toMatchObject([
          { reason: 'executable-changed' },
        ])
      }
    } finally {
      await f.stop()
    }
  },
)
