import { describe, expect, it, vi } from 'vitest'
import { exampleManifest } from './fixtures/extension-package'
import { fixture } from './fixtures/extension-guest'
import { DEFAULT_EXTENSION_PRESENTATION } from '../src/main/extensions/guest-owner'
import { ExtensionGuestLifecycle } from '../src/main/extensions/guest-lifecycle'

describe('native foreground admission and finite guest work', () => {
  it('requires current foreground after deferred document attachment before activating a top guest', async () => {
    let foreground = true
    let loaded!: () => void
    const documentLoaded = new Promise<void>((resolve) => {
      loaded = resolve
    })
    const lifecycle = new ExtensionGuestLifecycle(
      () => Promise.resolve('applied'),
      vi.fn(),
      vi.fn(),
    )
    const data = fixture(
      {
        foreground: () => foreground,
        windowVisible: () => foreground,
        visibility: (_id, visible) => lifecycle.setVisible(visible),
      },
      {
        views: [
          { ...exampleManifest().views[0]!, navigation: 'top', placement: 'application' },
        ],
      },
    )
    try {
      expect(data.owner.ownerForeground(data.renderer)).toBe(true)
      const view = await data.owner.open(
        data.renderer,
        'installation',
        'reference',
        undefined,
        { context: { surface: 'top' } },
      )
      const attach = documentLoaded.then(() => {
        data.owner.claim(data.renderer, view.partition, view.url, view.id)
        data.owner.bind(data.renderer, view.partition, 10)
      })
      foreground = false
      data.owner.foregroundChanged(data.renderer)
      loaded()
      await attach
      data.owner.presentation(
        data.renderer,
        view.id,
        DEFAULT_EXTENSION_PRESENTATION,
        true,
        false,
      )
      await vi.waitFor(() => expect(lifecycle.isActive).toBe(false))
      // The pre-navigation admission does not authorize the now-hidden document.
      expect(data.owner.ownerForeground(data.renderer)).toBe(false)
      foreground = true
      data.owner.foregroundChanged(data.renderer)
      data.owner.presentation(
        data.renderer,
        view.id,
        DEFAULT_EXTENSION_PRESENTATION,
        true,
        false,
      )
      await vi.waitFor(() => expect(lifecycle.isActive).toBe(true))
    } finally {
      loaded()
      lifecycle.dispose()
      await data.owner.dispose()
    }
  })

  it('keeps an issued freeze and latest hidden target when a shown top window loses foreground', async () => {
    let foreground = true,
      holdFreeze = false,
      releaseFreeze: (() => void) | undefined
    const commands: Array<'active' | 'frozen'> = []
    const active = vi.fn(),
      failed = vi.fn()
    const lifecycle = new ExtensionGuestLifecycle(
      (state) => {
        commands.push(state)
        if (state === 'frozen' && holdFreeze) {
          holdFreeze = false
          return new Promise<'applied'>((resolve) => {
            releaseFreeze = () => resolve('applied')
          })
        }
        return Promise.resolve('applied')
      },
      active,
      failed,
    )
    const visibility = vi.fn((_guestId: number, visible: boolean) =>
      lifecycle.setVisible(visible),
    )
    const data = fixture(
      { foreground: () => foreground, windowVisible: () => true, visibility },
      {
        views: [
          { ...exampleManifest().views[0]!, navigation: 'top', placement: 'application' },
        ],
      },
    )
    try {
      const view = await data.owner.open(
        data.renderer,
        'installation',
        'reference',
        undefined,
        { context: { surface: 'top' } },
      )
      expect(data.owner.claim(data.renderer, view.partition, view.url, view.id)).toEqual(
        view,
      )
      expect(data.owner.bind(data.renderer, view.partition, 10)).toEqual(view)
      data.owner.presentation(
        data.renderer,
        view.id,
        DEFAULT_EXTENSION_PRESENTATION,
        true,
        false,
      )
      await vi.waitFor(() => expect(lifecycle.isActive).toBe(true))
      const initialActive = commands.filter((state) => state === 'active').length
      const initialPublications = active.mock.calls.length
      const beforeFreeze = commands.length
      holdFreeze = true
      data.owner.presentation(
        data.renderer,
        view.id,
        DEFAULT_EXTENSION_PRESENTATION,
        false,
        false,
      )
      await vi.waitFor(() => expect(releaseFreeze).toBeTypeOf('function'))
      expect(commands.slice(beforeFreeze)).toEqual(['frozen'])
      foreground = false
      data.owner.foregroundChanged(data.renderer)
      // A shown native document is not foreground authority for a top placement.
      expect(data.surface.windowVisible(data.renderer)).toBe(true)
      expect(data.owner.ownerForeground(data.renderer)).toBe(false)
      data.owner.presentation(
        data.renderer,
        view.id,
        DEFAULT_EXTENSION_PRESENTATION,
        true,
        false,
      )
      expect(visibility).toHaveBeenLastCalledWith(10, false)
      expect(lifecycle.isActive).toBe(false)
      releaseFreeze!()
      await vi.waitFor(() =>
        expect(commands.slice(beforeFreeze)).toEqual(['frozen', 'frozen']),
      )
      expect(commands.filter((state) => state === 'active')).toHaveLength(initialActive)
      expect(active).toHaveBeenCalledTimes(initialPublications)
      expect(lifecycle.isActive).toBe(false)
      expect(failed).not.toHaveBeenCalled()
      foreground = true
      data.owner.foregroundChanged(data.renderer)
      expect(lifecycle.isActive).toBe(false)
      data.owner.presentation(
        data.renderer,
        view.id,
        DEFAULT_EXTENSION_PRESENTATION,
        true,
        false,
      )
      await vi.waitFor(() => expect(lifecycle.isActive).toBe(true))
      expect(commands.at(-1)).toBe('active')
      expect(active.mock.calls.length).toBeGreaterThan(initialPublications)
      expect(failed).not.toHaveBeenCalled()
    } finally {
      releaseFreeze?.()
      lifecycle.dispose()
      await data.owner.dispose()
    }
  })

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
