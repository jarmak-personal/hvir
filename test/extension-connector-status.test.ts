import { expect, it, vi } from 'vitest'
import { fixture } from './fixtures/extension-guest'
import { connectorFixture } from './fixtures/extension-connector'
import { DEFAULT_EXTENSION_PRESENTATION } from '../src/main/extensions/guest-owner'
import { EXTENSION_LIMITS } from '../src/shared/extensions/contract'

it.each(['ordinary', 'updater'] as const)(
  'bounds %s status to one row per declaration and the exact admitted workspace host',
  async (role) => {
    const declaration = {
      id: 'project',
      description: 'Project tool',
      context: 'workspace',
      timeoutMs: 1000,
      outputBytes: 1000,
      environment: [],
    }
    let demanded = true
    const data = fixture(
      {},
      {
        optionalCapabilities: ['connector.status'],
        updater: 'index.html',
        connectors: [
          { ...declaration, id: 'library', context: 'application' },
          ...Array.from({ length: 7 }, (_, i) => ({
            ...declaration,
            id: 'project-' + i,
          })),
        ],
      },
      undefined,
      {
        connectors: {
          approvals: {
            inspectStatus: (activation, host) =>
              native.approvals.inspectStatus(activation, host),
          },
          execute: vi.fn(),
          output: vi.fn(),
          revalidate: vi.fn(),
        },
        connectorDemand: () => demanded,
      },
    )
    const activation = [...data.active.values()][0]!
    const native = connectorFixture(
      'application',
      undefined,
      undefined,
      activation.revision,
    )
    native.active.set(activation.installationId, activation)
    try {
      for (const declaration of activation.revision.manifest.connectors!) {
        const prepared = await native.approvals.prepare(
          {
            installationId: activation.installationId,
            connector: declaration.id,
            host: 'local',
            executable: '/installed/tool',
            configuration: { args: [], env: {} },
          },
          () => undefined,
        )
        await native.approvals.approve(prepared.token)
      }
      const view = await data.owner.open(
        data.renderer,
        'installation',
        role === 'updater' ? 'updater' : 'reference',
        undefined,
        role === 'updater'
          ? { updater: true }
          : { context: { surface: 'viewer', workspaceId: 'workspace' } },
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
      if (role === 'updater') data.owner.updaterDemand(data.renderer, view.id, true)
      data.owner.receive(10, { kind: 'hello', contract: '1.0' })
      const request = async (id: string, input?: unknown) => {
        data.owner.receive(10, {
          kind: 'request',
          id,
          capability: 'connector.status',
          ...(input === undefined ? {} : { input }),
        })
        await vi.waitFor(() =>
          expect(
            data.sent.some(
              (entry) => entry.message.kind === 'result' && entry.message.id === id,
            ),
          ).toBe(true),
        )
        return data.sent.find(
          (entry) => entry.message.kind === 'result' && entry.message.id === id,
        )!.message
      }
      const supported = await request('exact', { workspace: 'workspace' })
      if (supported.kind === 'result' && !supported.ok) throw new Error(supported.error)
      expect(supported).toMatchObject({
        ok: true,
        value: Array.from({ length: 8 }, (): unknown =>
          expect.objectContaining({ availability: 'supported', host: 'local' }),
        ),
      })
      expect(Buffer.byteLength(JSON.stringify(supported))).toBeLessThanOrEqual(
        EXTENSION_LIMITS.messageBytes,
      )
      expect(JSON.stringify(supported)).not.toContain('/installed/tool')
      for (const [id, input] of [
        ['absent', undefined],
        ['foreign', { workspace: 'foreign' }],
      ] as const) {
        expect(await request(id, input)).toMatchObject({
          ok: true,
          value: [
            expect.objectContaining({
              connector: 'library',
              availability: 'supported',
              host: 'local',
            }),
            ...Array.from({ length: 7 }, (): unknown =>
              expect.objectContaining({ availability: 'unavailable' }),
            ),
          ],
        })
      }
      expect(
        await request('forged', { workspace: 'workspace', host: 'ssh' }),
      ).toMatchObject({ ok: false })
      if (role === 'updater') {
        demanded = false
        expect(await request('demand-ended', { workspace: 'workspace' })).toMatchObject({
          ok: true,
          value: [
            expect.objectContaining({ availability: 'supported' }),
            ...Array.from({ length: 7 }, (): unknown =>
              expect.objectContaining({ availability: 'unavailable' }),
            ),
          ],
        })
      }
      native.host.realpath.mockImplementation((path) =>
        Promise.resolve({
          ...path,
          path: '/updated/private/tool',
        }),
      )
      const changed: unknown = await request('changed-target', { workspace: 'workspace' })
      expect(changed).toMatchObject({
        ok: true,
        value: expect.arrayContaining([
          expect.objectContaining({
            availability: 'unavailable',
            reason: 'executable-changed',
          }),
        ]) as unknown,
      })
      expect(Buffer.byteLength(JSON.stringify(changed))).toBeLessThanOrEqual(
        EXTENSION_LIMITS.messageBytes,
      )
      expect(JSON.stringify(changed)).not.toContain('/updated/private/tool')
      expect(JSON.stringify(changed)).not.toContain('configuration')
      expect(native.host.exec).not.toHaveBeenCalled()
    } finally {
      native.dispose()
      await data.owner.dispose()
    }
  },
)
