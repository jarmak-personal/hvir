import { describe, expect, it, vi } from 'vitest'
import { attached, fixture } from './fixtures/extension-guest'
import { connectorFixture } from './fixtures/extension-connector'
import { ExtensionConnectorConnectionOwner } from '../src/main/extensions/connector-connection'
import type { ExtensionGuestPorts } from '../src/main/extensions/guest-capability-ports'
import { exampleManifest } from './fixtures/extension-package'
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
      data.scopes,
      () => true,
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
  it.each(
    (['top', 'left', 'viewer'] as const).flatMap((placement) =>
      [
        'hide',
        'deselection',
        'cancel',
        'close',
        'return-before-publication',
        'withdraw-before-publication',
        'background-before-publication',
        'cancel-before-publication',
      ].map((ending) => ({
        placement,
        ending,
      })),
    ),
  )(
    'keeps $placement connection through picker focus loss but retires on $ending',
    async ({ placement, ending }) => {
      let foreground = true,
        physicallyVisible = true
      let latest!: ReturnType<ExtensionConnectorConnectionOwner['request']>
      let pickerCalls = 0
      let select!: (path: string | undefined) => void
      let pickerEntered!: () => void
      const entered = new Promise<void>((resolve) => {
        pickerEntered = resolve
      })
      const data = fixture(
        { foreground: () => foreground, windowVisible: () => physicallyVisible },
        {
          optionalCapabilities: ['connector.connect'],
          views: [
            {
              ...exampleManifest().views[0]!,
              placement: placement === 'left' ? 'workspace' : 'application',
              ...(placement === 'viewer' ? {} : { navigation: placement }),
            },
          ],
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
        {
          connections: {
            request: (...args) => (latest = connection.request(...args)),
            revalidate: () => connection.revalidate(),
          },
        },
      )
      const native = connectorFixture(
        'application',
        undefined,
        undefined,
        [...data.active.values()][0]!.revision,
      )
      native.active.set('installation', [...data.active.values()][0]!)
      const prepare = vi.spyOn(native.approvals, 'prepare')
      native.host.stat.mockImplementation((path) =>
        path.path.startsWith('/installed')
          ? Promise.reject(Object.assign(new Error('Absent'), { code: 'ENOENT' }))
          : Promise.resolve({ type: 'file', mode: 0o755, size: 3, mtimeMs: 0 }),
      )
      const connection = new ExtensionConnectorConnectionOwner(
        data.scopes,
        () => physicallyVisible,
        native.authority,
        native.approvals,
        {
          folders: ['/installed'],
          choose: () =>
            new Promise((resolve) => {
              select = resolve
              pickerCalls++
              pickerEntered()
            }),
        },
        (owner, proposals) => {
          if (proposals[0]) connection.decide(owner, proposals[0].id, true)
        },
      )
      try {
        const view = await data.owner.open(
          data.renderer,
          'installation',
          'reference',
          undefined,
          {
            context: {
              surface: placement,
              ...(placement === 'left' ? { workspaceId: 'workspace' } : {}),
            },
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
          true,
        )
        data.owner.receive(10, { kind: 'hello', contract: '1.0' })
        data.owner.receive(10, {
          kind: 'request',
          id: 'connect',
          capability: 'connector.connect',
          input: { connector: 'tool' },
        })
        await entered
        foreground = false
        data.owner.foregroundChanged(data.renderer)
        // Unrelated appearance/context publication retains placement but never runnable demand.
        data.owner.presentation(
          data.renderer,
          view.id,
          DEFAULT_EXTENSION_PRESENTATION,
          false,
          false,
          true,
        )
        connection.revalidate()
        expect(connection.snapshot(data.renderer)).toEqual([])
        expect(native.write).not.toHaveBeenCalled()
        expect(
          data.sent.some(
            (entry) => entry.message.kind === 'result' && entry.message.id === 'connect',
          ),
        ).toBe(false)
        foreground = true
        data.owner.presentation(
          data.renderer,
          view.id,
          DEFAULT_EXTENSION_PRESENTATION,
          true,
          true,
          true,
        )
        select('/chosen/tool')
        await vi.waitFor(() =>
          expect(
            data.sent.find(
              (entry) =>
                entry.message.kind === 'result' && entry.message.id === 'connect',
            ),
          ).toMatchObject({
            message: { ok: true, value: { connections: [{ outcome: 'connected' }] } },
          }),
        )
        expect(
          native.approvals.get([...data.active.values()][0]!, 'tool')
            ?.canonicalExecutable,
        ).toBe('/chosen/tool')
        // A new explicit retry held in the same picker retires immediately on physical hide.
        await native.approvals.revoke('installation', 'tool')
        const writesBeforeRetry = native.write.mock.calls.length
        data.owner.receive(10, {
          kind: 'request',
          id: 'again',
          capability: 'connector.connect',
          input: { connector: 'tool' },
        })
        await vi.waitFor(() => expect(pickerCalls).toBe(2))
        if (ending === 'hide') {
          physicallyVisible = false
          connection.revalidate()
        } else if (ending === 'deselection')
          data.owner.presentation(
            data.renderer,
            view.id,
            DEFAULT_EXTENSION_PRESENTATION,
            false,
            false,
            false,
          )
        else if (ending.endsWith('before-publication')) {
          foreground = false
          data.owner.foregroundChanged(data.renderer)
          data.owner.presentation(
            data.renderer,
            view.id,
            DEFAULT_EXTENSION_PRESENTATION,
            false,
            false,
            true,
          )
          foreground = true
          select('/returned-before-publication/tool')
          let settled = false
          void latest.then(() => {
            settled = true
          })
          await new Promise<void>((resolve) => setImmediate(resolve))
          expect(settled).toBe(false)
          expect(connection.snapshot(data.renderer)).toEqual([])
          expect(native.write).toHaveBeenCalledTimes(writesBeforeRetry)
          expect(prepare).toHaveBeenCalledOnce()
          if (ending === 'return-before-publication') {
            data.owner.presentation(
              data.renderer,
              view.id,
              DEFAULT_EXTENSION_PRESENTATION,
              true,
              true,
              true,
            )
            expect((await latest).connections[0]?.outcome).toBe('connected')
            expect(
              native.approvals.get([...data.active.values()][0]!, 'tool')
                ?.canonicalExecutable,
            ).toBe('/returned-before-publication/tool')
            return
          }
          if (ending === 'background-before-publication') {
            foreground = false
            data.owner.foregroundChanged(data.renderer)
          } else if (ending === 'cancel-before-publication')
            data.owner.receive(10, { kind: 'cancel', id: 'again' })
          else
            data.owner.presentation(
              data.renderer,
              view.id,
              DEFAULT_EXTENSION_PRESENTATION,
              false,
              false,
              false,
            )
        } else if (ending === 'cancel')
          data.owner.receive(10, { kind: 'cancel', id: 'again' })
        else await data.owner.close(data.renderer, view.id)
        expect((await latest).connections[0]?.outcome).toBe('unavailable')
        select('/late/tool')
        expect(
          native.approvals.get([...data.active.values()][0]!, 'tool'),
        ).toBeUndefined()
      } finally {
        connection.dispose()
        native.dispose()
        await data.owner.dispose()
      }
    },
  )
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
