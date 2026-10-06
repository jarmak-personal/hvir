import { describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { localPath } from '../src/shared/host-path'
import { RendererResourceScopes } from '../src/main/renderer-resource-scopes'
import { ExtensionPackageAdditionOwner } from '../src/main/extensions/package-addition'
import type { ExtensionActivation } from '../src/main/extensions/activation'
import type { RendererOwner } from '../src/main/renderer-resource-scopes'
import { ExtensionConnectorConnectionOwner } from '../src/main/extensions/connector-connection'
import {
  ExtensionConnectorApprovalOwner,
  type ConnectorHostCatalog,
} from '../src/main/extensions/connector-approval'
import { extensionInstallationFixture } from './fixtures/extension-installation'
import { exampleManifest } from './fixtures/extension-package'

function held<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function fixture(phase: 'consent' | 'picker' = 'consent') {
  const data = await extensionInstallationFixture(),
    activations = data.make(),
    scopes = new RendererResourceScopes(),
    renderer = scopes.activateOwner(1)
  const source = localPath(join(data.root, 'authored'))
  await fs.mkdir(source.path)
  await fs.writeFile(
    join(source.path, 'hvir-extension.json'),
    JSON.stringify(
      exampleManifest({
        connectors: [
          {
            id: 'tool',
            description: 'Read library metadata',
            context: 'application',
            timeoutMs: 1000,
            outputBytes: 1000,
            environment: [],
            setup: { executable: 'true' },
          },
        ],
      }),
    ),
  )
  await fs.writeFile(join(source.path, 'index.html'), '<h1>Isolated view</h1>')
  await fs.writeFile(join(source.path, 'detail.html'), '<h1>Detail</h1>')
  await activations.start(data.lock)
  const hosts: ConnectorHostCatalog = {
    local: data.host,
    listHosts: () => [
      {
        hostId: data.host.hostId,
        label: 'Local',
        kind: 'local',
        connectionState: 'connected',
        watchTier: 'native',
      },
    ],
    hostById: () => data.host,
    materializeHost: () => Promise.resolve(data.host),
    onHostStateChange: () => () => undefined,
  }
  const approvals = new ExtensionConnectorApprovalOwner(
    hosts,
    activations,
    () => undefined,
  )
  await approvals.start()
  const decision = held<boolean>(),
    selection = held<string | undefined>(),
    entered = held<void>()
  const connection = new ExtensionConnectorConnectionOwner(
    activations,
    approvals,
    {
      folders: phase === 'picker' ? [] : ['/usr/bin'],
      choose: () => {
        entered.resolve()
        return selection.promise
      },
    },
    (owner, proposals) => {
      const proposal = proposals[0]
      if (proposal) {
        entered.resolve()
        void decision.promise.then((accepted) => {
          try {
            connection.decide(owner, proposal.id, accepted)
          } catch {
            /* Late response ignored. */
          }
        })
      }
    },
  )
  data.revoke.mockImplementation((id: string) => {
    connection.revoke(id)
    approvals.discardPrepared(id)
  })
  const connect = vi.fn(
    (activation: ExtensionActivation, owner: RendererOwner, signal: AbortSignal) => {
      expect(activation).toBe(activations.active.get(activation.installationId))
      return connection.request(
        activation,
        owner,
        () => scopes.assertCurrent(owner),
        signal,
        () => true,
      )
    },
  )
  return {
    ...data,
    activations,
    scopes,
    renderer,
    source,
    approvals,
    connection,
    connect,
    decision,
    selection,
    entered,
    stop: async () => {
      decision.resolve(false)
      selection.resolve(undefined)
      connection.dispose()
      approvals.dispose()
      await activations.dispose()
      await data.dispose()
    },
  }
}

describe('committed installation and post-install connection intent', () => {
  it('leaving Settings before picker return suppresses setup while preserving the chosen install', async () => {
    const data = await fixture(),
      selection = held<ReturnType<typeof localPath> | undefined>()
    const addition = new ExtensionPackageAdditionOwner(
      data.scopes,
      data.activations,
      { pick: () => selection.promise },
      data.connect,
    )
    try {
      const operation = addition.add(data.renderer, 'chosen-install')
      addition.cancelSetup(data.renderer, 'chosen-install')
      selection.resolve(data.source)
      const result = await operation
      expect(result.installations[0]?.enabled).toBe(true)
      expect(data.connect).not.toHaveBeenCalled()
      expect(await fs.readFile(join(data.source.path, 'index.html'), 'utf8')).toBe(
        '<h1>Isolated view</h1>',
      )
    } finally {
      selection.resolve(undefined)
      await data.stop()
    }
  })
  it('cancels only the exact current setup request and retains committed installation success', async () => {
    const data = await fixture(),
      addition = new ExtensionPackageAdditionOwner(
        data.scopes,
        data.activations,
        { pick: () => Promise.resolve(data.source) },
        data.connect,
      )
    try {
      const operation = addition.add(data.renderer, 'active-setup')
      await data.entered.promise
      addition.cancelSetup(data.scopes.activateOwner(2), 'active-setup')
      addition.cancelSetup(data.renderer, 'another-request')
      expect(
        data.approvals.status([...data.activations.active.values()][0]!)[0]?.availability,
      ).toBe('unavailable')
      addition.cancelSetup(data.renderer, 'active-setup')
      const result = await operation
      expect(result.installations[0]?.enabled).toBe(true)
      expect(result.connection?.connections[0]?.outcome).toBe('unavailable')
      data.decision.resolve(true)
      await Promise.resolve()
      expect(await data.activations.readConnectorApprovals()).toEqual([])
    } finally {
      await data.stop()
    }
  })
  it.each(['consent', 'picker'] as const)(
    'Disable and disposal release the writer before held %s returns; late response cannot revive it',
    async (phase) => {
      const data = await fixture(phase),
        addition = new ExtensionPackageAdditionOwner(
          data.scopes,
          data.activations,
          { pick: () => Promise.resolve(data.source) },
          data.connect,
        )
      try {
        const operation = addition.add(data.renderer, 'held-setup')
        await data.entered.promise
        const id = [...data.activations.active.keys()][0]!
        await data.activations.disable(id)
        expect((await operation).installations[0]?.enabled).toBe(true) // truthful committed Add receipt
        expect(data.activations.snapshot().installations[0]?.enabled).toBe(false)
        await data.activations.dispose()
        const next = data.make()
        try {
          await next.start(data.lock)
          expect(next.snapshot().writable).toBe(true)
          if (phase === 'picker') data.selection.resolve('/usr/bin/true')
          else data.decision.resolve(true)
          await Promise.resolve()
          expect(await next.readConnectorApprovals()).toEqual([])
          expect(next.active.size).toBe(0)
        } finally {
          await next.dispose()
        }
      } finally {
        await data.stop()
      }
    },
  )
})
