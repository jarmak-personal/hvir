import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_EXTENSION_PRESENTATION } from '../src/main/extensions/guest-owner'
import { sourceFixture } from './fixtures/extension-source'
import { fixture, attached } from './fixtures/extension-guest'
describe('main-owned source origin and current visibility', () => {
  async function sourceGuest(origin: 'human' | 'agent' | 'action') {
    const source = sourceFixture()
    const data = fixture(
      {},
      {
        requiredCapabilities: [
          'presentation.read',
          'context.read',
          'viewer.open-own',
          'source.status',
          'source.select',
          'source.read',
          'source.asset',
          'source.render',
        ],
        access: [source.declaration],
      },
      undefined,
      { sources: source.reading },
    )
    await source.grant()
    source.active.set('installation', data.active.get('installation')!)
    const view = await attached(data, 10, origin)
    data.owner.receive(10, { kind: 'hello', contract: '1.0' })
    return {
      data,
      source,
      view,
      async close() {
        await data.owner.dispose()
        source.dispose()
      },
    }
  }
  async function result(
    data: ReturnType<typeof fixture>,
    guest: number,
    id: string,
    capability: string,
    input: unknown,
  ) {
    data.owner.receive(guest, { kind: 'request', id, capability, input })
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
  it.each(['agent', 'action'] as const)(
    'denies omitted invocation IDs after %s origin and own-detail reuse',
    async (origin) => {
      const f = await sourceGuest(origin)
      try {
        const human = await f.data.owner.open(
          f.data.renderer,
          'installation',
          'reference',
        )
        expect(human.id).not.toBe(f.view.id) // No human cached body can enter this origin.
        const reused = await f.data.owner.open(
          f.data.renderer,
          'installation',
          'reference',
          () => {},
          { readingOrigin: origin },
        )
        expect(reused.id).toBe(f.view.id)
        expect(
          await result(f.data, 10, 'body-omitted', 'source.select', {
            source: 'source',
            path: f.source.path,
          }),
        ).toMatchObject({
          ok: false,
          error:
            'Instruction bodies are available only to ordinary human-selected views, never actions, agents or updaters',
        })
        expect(
          await result(f.data, 10, 'own-detail', 'viewer.open-own', {
            contributionId: 'detail',
            context: 'application',
            input: { selection: 'explicit' },
          }),
        ).toMatchObject({ ok: true })
        const detail = f.data.owner
          .snapshot(f.data.renderer)
          .find((view) => view.contributionId === 'detail')!
        f.data.owner.claim(f.data.renderer, detail.partition, detail.url, detail.id)
        f.data.owner.bind(f.data.renderer, detail.partition, 11)
        f.data.owner.presentation(
          f.data.renderer,
          detail.id,
          DEFAULT_EXTENSION_PRESENTATION,
          true,
          true,
        )
        f.data.owner.receive(11, { kind: 'hello', contract: '1.0' })
        expect(
          await result(f.data, 11, 'derived-omitted', 'source.select', {
            source: 'source',
            path: f.source.path,
          }),
        ).toMatchObject({
          ok: false,
          error:
            'Instruction bodies are available only to ordinary human-selected views, never actions, agents or updaters',
        })
        for (const capability of ['source.read', 'source.asset', 'source.render']) {
          expect(
            await result(f.data, 10, capability.replace('.', '-'), capability, {
              receipt: 'omitted-invocation',
            }),
          ).toMatchObject({
            ok: false,
            error:
              'Instruction bodies are available only to ordinary human-selected views, never actions, agents or updaters',
          })
        }
        expect(f.source.host.readTextFilePrefix).not.toHaveBeenCalled()
      } finally {
        await f.close()
      }
    },
  )
  it.each([false, true])(
    'rejects a new hidden selection and prevents publication when its real guest becomes hidden during the owning read (renew visibility: %s)',
    async (renew) => {
      const f = await sourceGuest('human')
      try {
        f.data.owner.presentation(
          f.data.renderer,
          f.view.id,
          DEFAULT_EXTENSION_PRESENTATION,
          false,
          false,
        )
        expect(
          await result(f.data, 10, 'hidden-new', 'source.select', {
            source: 'source',
            path: f.source.path,
          }),
        ).toMatchObject({ ok: false })
        expect(f.source.host.readTextFilePrefix).not.toHaveBeenCalled()
        f.data.owner.presentation(
          f.data.renderer,
          f.view.id,
          DEFAULT_EXTENSION_PRESENTATION,
          true,
          true,
        )
        let resume!: () => void
        f.source.host.readTextFilePrefix.mockImplementationOnce(async () => {
          await new Promise<void>((resolve) => {
            resume = resolve
          })
          return {
            content: 'late',
            byteLength: 4,
            lineCount: 1,
            complete: true,
            validUtf8: true,
          }
        })
        const reading = result(f.data, 10, 'hidden-late', 'source.select', {
          source: 'source',
          path: f.source.path,
        })
        await vi.waitFor(() =>
          expect(f.source.host.readTextFilePrefix).toHaveBeenCalledTimes(1),
        )
        f.data.owner.presentation(
          f.data.renderer,
          f.view.id,
          DEFAULT_EXTENSION_PRESENTATION,
          false,
          false,
        )
        if (renew)
          f.data.owner.presentation(
            f.data.renderer,
            f.view.id,
            DEFAULT_EXTENSION_PRESENTATION,
            true,
            true,
          )
        resume()
        expect(await reading).toMatchObject({
          ok: false,
          error: renew ? 'This operation was aborted' : 'Selected source view is hidden',
        })
      } finally {
        await f.close()
      }
    },
  )
})
