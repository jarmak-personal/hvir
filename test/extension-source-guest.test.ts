import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_EXTENSION_PRESENTATION } from '../src/main/extensions/guest-owner'
import { ExtensionSourceRequestOwner } from '../src/main/extensions/source-request'
import { sourceFixture } from './fixtures/extension-source'
import { fixture, attached } from './fixtures/extension-guest'
describe('main-owned source origin and current visibility', () => {
  async function sourceGuest(
    origin: 'human' | 'agent' | 'action',
    granted = true,
    context: 'application' | 'workspace' = 'application',
  ) {
    const source = sourceFixture(context)
    const data = fixture(
      {},
      {
        requiredCapabilities: [
          'presentation.read',
          'context.read',
          'viewer.open-own',
          'source.status',
          'source.request',
          'source.select',
          'source.read',
          'source.asset',
          'source.render',
        ],
        access: [source.declaration],
      },
      undefined,
      {
        sources: source.reading,
        sourceRequests: {
          request: (...args) => requests.request(...args),
          revalidate: () => requests?.revalidate(),
        },
      },
    )
    const requests = new ExtensionSourceRequestOwner(
      data.scopes,
      source.approvals,
      () => true,
      () => {},
    )
    if (granted) await source.grant()
    else await source.approvals.start()
    source.active.set('installation', data.active.get('installation')!)
    const view = await attached(data, 10, origin)
    data.owner.receive(10, { kind: 'hello', contract: '1.0' })
    return {
      data,
      source,
      view,
      requests,
      async close() {
        requests.dispose()
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
  it.each([
    ['agent', 'application'],
    ['action', 'application'],
    ['agent', 'workspace'],
    ['action', 'workspace'],
  ] as const)(
    'denies omitted invocation IDs after %s origin and own-detail reuse for %s sources',
    async (origin, context) => {
      const f = await sourceGuest(origin, true, context)
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
        expect(
          await result(f.data, 10, 'human-forgery', 'source.request', {
            source: 'source',
            root: f.source.root,
            caller: 'human',
          }),
        ).toMatchObject({
          ok: false,
          error: 'Read access requires an ordinary human-selected view',
        })
        expect(f.requests.snapshot(f.data.renderer)).toEqual([])
        expect(f.source.host.readTextFilePrefix).not.toHaveBeenCalled()
      } finally {
        await f.close()
      }
    },
  )
  it.each(['missing', 'file', 'unreadable', 'valid'] as const)(
    'withholds %s preflight and repeated cancellation outcomes at the real guest transport',
    async (kind) => {
      const f = await sourceGuest('human', false)
      if (kind === 'missing')
        f.source.host.realpath.mockRejectedValue(
          new Error('ENOENT private missing folder'),
        )
      if (kind === 'unreadable')
        f.source.host.realpath.mockRejectedValue(new Error('EACCES private folder'))
      if (kind === 'file')
        f.source.host.stat.mockResolvedValue({
          type: 'file',
          size: 10,
          mode: 0o644,
          mtimeMs: 0,
        })
      const publicReply = (id: string) =>
        f.data.sent.filter(
          (entry) => entry.message.kind === 'result' && entry.message.id === id,
        )
      try {
        for (const id of ['probe-one', 'probe-two']) {
          f.data.owner.receive(10, {
            kind: 'request',
            id,
            capability: 'source.request',
            input: { source: 'source', root: f.source.root },
          })
          await vi.waitFor(() =>
            expect(f.requests.snapshot(f.data.renderer)[0]?.state).toBe(
              kind === 'valid' ? 'ready' : 'failed',
            ),
          )
          expect(publicReply(id)).toEqual([])
          f.data.owner.receive(10, { kind: 'cancel', id })
          await vi.waitFor(() => expect(f.requests.snapshot(f.data.renderer)).toEqual([]))
          await Promise.resolve()
          expect(publicReply(id)).toEqual([])
        }
        f.data.owner.receive(10, {
          kind: 'request',
          id: 'human-decision',
          capability: 'source.request',
          input: { source: 'source', root: f.source.root },
        })
        await vi.waitFor(() =>
          expect(f.requests.snapshot(f.data.renderer)[0]?.state).toBe(
            kind === 'valid' ? 'ready' : 'failed',
          ),
        )
        const p = f.requests.snapshot(f.data.renderer)[0]!
        expect(publicReply('human-decision')).toEqual([])
        f.requests.decide(f.data.renderer, p.id, false)
        await vi.waitFor(() => expect(publicReply('human-decision')).toHaveLength(1))
        expect(publicReply('human-decision')[0]!.message).toMatchObject({
          kind: 'result',
          ok: true,
          value: { granted: false },
        })
        expect(f.source.host.readTextFilePrefix).not.toHaveBeenCalled()
        expect(f.source.state()).toEqual([])
      } finally {
        await f.close()
      }
    },
  )
  it('reuses an unchanged canonical read grant only from the actual ordinary human view', async () => {
    const f = await sourceGuest('human')
    try {
      expect(
        await result(f.data, 10, 'current-read', 'source.request', {
          source: 'source',
          root: f.source.root,
        }),
      ).toMatchObject({ ok: true, value: { granted: true } })
      expect(f.requests.snapshot(f.data.renderer)).toEqual([])
      expect(f.source.host.readTextFilePrefix).not.toHaveBeenCalled()
    } finally {
      await f.close()
    }
  })
  it('retires the request before its first physical writer await when visibility withdraws and returns', async () => {
    const f = await sourceGuest('human')
    let resume!: () => void, entered!: () => void
    const waiting = new Promise<void>((resolve) => {
        resume = resolve
      }),
      reached = new Promise<void>((resolve) => {
        entered = resolve
      })
    const hold = async () => {
      entered()
      await waiting
    }
    f.data.assertWritable.mockImplementationOnce(hold)
    f.source.authority.assertWritable.mockImplementationOnce(hold)
    try {
      const request = result(f.data, 10, 'early-withdrawal', 'source.request', {
        source: 'source',
        root: f.source.root,
      })
      await reached
      f.data.owner.presentation(
        f.data.renderer,
        f.view.id,
        DEFAULT_EXTENSION_PRESENTATION,
        false,
        false,
      )
      f.data.owner.presentation(
        f.data.renderer,
        f.view.id,
        DEFAULT_EXTENSION_PRESENTATION,
        true,
        true,
      )
      resume()
      expect(await request).toMatchObject({ ok: false })
      expect(f.requests.snapshot(f.data.renderer)).toEqual([])
      expect(f.source.host.readTextFilePrefix).not.toHaveBeenCalled()
    } finally {
      resume()
      await f.close()
    }
  })
  it('denies a source request when the canonical writer gate is unavailable', async () => {
    const f = await sourceGuest('human')
    f.source.authority.assertWritable.mockRejectedValueOnce(
      new Error('Extension writer was lost'),
    )
    try {
      expect(
        await result(f.data, 10, 'writer-lost', 'source.request', {
          source: 'source',
          root: f.source.root,
        }),
      ).toMatchObject({ ok: false, error: 'Extension writer was lost' })
      expect(f.requests.snapshot(f.data.renderer)).toEqual([])
      expect(f.source.host.readTextFilePrefix).not.toHaveBeenCalled()
    } finally {
      await f.close()
    }
  })
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
