import { describe, expect, it, vi } from 'vitest'
import { exampleManifest } from './fixtures/extension-package'
import { fixture } from './fixtures/extension-guest'
import { DEFAULT_EXTENSION_PRESENTATION } from '../src/main/extensions/guest-owner'

describe('native foreground admission and finite guest work', () => {
  it.each(['top', 'left'] as const)(
    'fences ordinary %s reads and stale visibility before background renderer publication',
    async (placement) => {
      let foreground = true
      let finish!: (value: string) => void
      const visibility = vi.fn(),
        sourceRevalidate = vi.fn()
      const read = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            finish = resolve
          }),
      )
      const data = fixture(
        { foreground: () => foreground, visibility },
        {
          requiredCapabilities: ['source.read'],
          views: [
            {
              ...exampleManifest().views[0]!,
              navigation: placement,
              placement: placement === 'left' ? 'workspace' : 'application',
            },
          ],
        },
        undefined,
        {
          sources: {
            approvals: { status: vi.fn(() => []) },
            select: vi.fn(),
            read,
            render: vi.fn(),
            asset: vi.fn(),
            closeView: vi.fn(),
            revalidate: sourceRevalidate,
          },
        },
      )
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
      )
      data.owner.receive(10, { kind: 'hello', contract: '1.0' })
      data.owner.receive(10, {
        kind: 'request',
        id: 'read',
        capability: 'source.read',
        input: {},
      })
      await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
      foreground = false
      // The native predicate rejects the already-running read even before its event is published.
      finish('owned test body')
      await vi.waitFor(() =>
        expect(data.sent.find((entry) => entry.message.kind === 'result')).toMatchObject({
          message: {
            id: 'read',
            ok: false,
            error: 'Selected extension window is in the background',
          },
        }),
      )
      data.owner.foregroundChanged(data.renderer)
      expect(sourceRevalidate).toHaveBeenCalled()
      expect(visibility).toHaveBeenLastCalledWith(10, false)
      data.owner.presentation(
        data.renderer,
        view.id,
        DEFAULT_EXTENSION_PRESENTATION,
        true,
        true,
      )
      expect(visibility).toHaveBeenLastCalledWith(10, false)
      data.owner.receive(10, {
        kind: 'request',
        id: 'late',
        capability: 'source.read',
        input: {},
      })
      expect(read).toHaveBeenCalledOnce()
      expect(
        data.sent.find(
          (entry) => entry.message.kind === 'result' && entry.message.id === 'late',
        ),
      ).toMatchObject({ message: { ok: false } })
      foreground = true
      data.owner.presentation(
        data.renderer,
        view.id,
        DEFAULT_EXTENSION_PRESENTATION,
        true,
        true,
      )
      expect(visibility).toHaveBeenLastCalledWith(10, true)
      await data.owner.dispose()
    },
  )
  it('keeps exact finite action work admitted while its native top window backgrounds', async () => {
    let foreground = true
    const data = fixture(
      { foreground: () => foreground },
      {
        requiredCapabilities: ['presentation.read'],
        views: [{ ...exampleManifest().views[0]!, navigation: 'top' }],
        actions: [
          {
            id: 'describe',
            title: 'Describe',
            view: 'reference',
            agents: true,
            effects: { delete: false, replace: false },
          },
        ],
      },
    )
    const view = await data.owner.open(
      data.renderer,
      'installation',
      'reference',
      undefined,
      { readingOrigin: 'action', context: { surface: 'top' } },
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
    data.owner.receive(10, { kind: 'hello', contract: '1.0' })
    const operation = data.actions.invoke(
      data.renderer,
      data.active.get('installation')!,
      'describe',
      null,
      { surface: 'top' },
      'agent',
      'standing',
      () => {},
    )
    await vi.waitFor(() =>
      expect(data.sent.some((entry) => entry.message.kind === 'action')).toBe(true),
    )
    const action = data.sent.find((entry) => entry.message.kind === 'action')!.message
    if (action.kind !== 'action') throw new Error('No exact admitted action')
    foreground = false
    data.owner.foregroundChanged(data.renderer)
    data.owner.receive(10, {
      kind: 'request',
      id: 'finite',
      capability: 'presentation.read',
      actionId: action.invocation.id,
      input: null,
    })
    await vi.waitFor(() =>
      expect(
        data.sent.find(
          (entry) => entry.message.kind === 'result' && entry.message.id === 'finite',
        ),
      ).toMatchObject({ message: { ok: true } }),
    )
    data.owner.receive(10, {
      kind: 'action-result',
      id: action.invocation.id,
      value: 'complete',
    })
    await expect(operation).resolves.toBe('complete')
    await data.owner.dispose()
  })
})
