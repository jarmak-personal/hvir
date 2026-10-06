import { describe, expect, it, vi } from 'vitest'
import { attached, fixture } from './fixtures/extension-guest'
import { connectorFixture } from './fixtures/extension-connector'
import { ExtensionConnectorConnectionOwner } from '../src/main/extensions/connector-connection'
import type { ExtensionGuestPorts } from '../src/main/extensions/guest-capability-ports'
import { DEFAULT_EXTENSION_PRESENTATION } from '../src/main/extensions/guest-owner'

describe('ordinary human connection proposals', () => {
  it('routes visible human proposals with a revocable view signal and refuses late completion after hide', async () => {
    let complete!: (value: boolean) => void
    const request = vi.fn<ExtensionGuestPorts['connections']['request']>((...args) =>
      connection.request(...args),
    )
    const data = fixture(
      {},
      {
        optionalCapabilities: ['connector.connect'],
        connectors: [
          {
            id: 'tool',
            description: 'Library tool',
            context: 'application',
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
    const native = connectorFixture(
      'application',
      undefined,
      undefined,
      [...data.active.values()][0]!.revision,
    )
    native.active.set('installation', [...data.active.values()][0]!)
    const connection = new ExtensionConnectorConnectionOwner(
      native.authority,
      native.approvals,
      { folders: ['/installed'], choose: () => Promise.resolve(undefined) },
      (owner, proposals) => {
        const proposal = proposals[0]
        if (proposal) {
          const response = new Promise<boolean>((resolve) => {
            complete = resolve
          })
          void response.then((accepted) => {
            try {
              connection.decide(owner, proposal.id, accepted)
            } catch {
              /* Late response ignored. */
            }
          })
        }
      },
    )
    try {
      const view = await attached(data)
      data.owner.receive(10, { kind: 'hello', contract: '1.0' })
      data.owner.receive(10, {
        kind: 'request',
        id: 'connect',
        capability: 'connector.connect',
        input: { connector: 'tool' },
      })
      await vi.waitFor(() => expect(connection.snapshot(data.renderer)).toHaveLength(1))
      data.owner.presentation(
        data.renderer,
        view.id,
        DEFAULT_EXTENSION_PRESENTATION,
        false,
        false,
      )
      expect(connection.snapshot(data.renderer)).toEqual([])
      await vi.waitFor(() =>
        expect(
          data.sent.find(
            (entry) => entry.message.kind === 'result' && entry.message.id === 'connect',
          ),
        ).toMatchObject({
          message: {
            value: { connections: [{ connector: 'tool', outcome: 'unavailable' }] },
          },
        }),
      )
      complete(true)
      await Promise.resolve()
      expect(native.write).not.toHaveBeenCalled()
    } finally {
      connection.dispose()
      native.dispose()
      await data.owner.dispose()
    }
  })
  it.each(['agent', 'action'] as const)(
    'does not prompt from a %s-origin view, even without an invocation ID',
    async (origin) => {
      const request = vi.fn()
      const data = fixture(
        {},
        { requiredCapabilities: ['connector.connect'] },
        undefined,
        { connections: { request, revalidate: vi.fn() } },
      )
      try {
        await attached(data, 10, origin)
        data.owner.receive(10, { kind: 'hello', contract: '1.0' })
        data.owner.receive(10, {
          kind: 'request',
          id: 'connect',
          capability: 'connector.connect',
          input: { connector: 'tool' },
        })
        await vi.waitFor(() =>
          expect(
            data.sent.some(
              (entry) =>
                entry.message.kind === 'result' && entry.message.id === 'connect',
            ),
          ).toBe(true),
        )
        expect(request).not.toHaveBeenCalled()
      } finally {
        await data.owner.dispose()
      }
    },
  )
  it('excludes connection prompts from updater negotiation', async () => {
    const request = vi.fn()
    const data = fixture(
      {},
      { optionalCapabilities: ['connector.connect'], updater: 'index.html' },
      undefined,
      { connections: { request, revalidate: vi.fn() } },
    )
    try {
      const view = await data.owner.open(
        data.renderer,
        'installation',
        'updater',
        undefined,
        { updater: true },
      )
      data.owner.claim(data.renderer, view.partition, view.url, view.id)
      data.owner.bind(data.renderer, view.partition, 10)
      data.owner.receive(10, { kind: 'hello', contract: '1.0' })
      const hello = data.sent.find((entry) => entry.message.kind === 'hello')?.message
      expect(
        hello?.kind === 'hello' && hello.capabilities.includes('connector.connect'),
      ).toBe(false)
      data.owner.receive(10, {
        kind: 'request',
        id: 'connect',
        capability: 'connector.connect',
        input: { connector: 'tool' },
      })
      expect(request).not.toHaveBeenCalled()
    } finally {
      await data.owner.dispose()
    }
  })
})
