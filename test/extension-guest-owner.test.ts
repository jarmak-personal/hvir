import { exampleManifest } from './fixtures/extension-package'
import {
  MAX_FONT_FAMILY_LENGTH,
  MAX_INTERFACE_FONT_STACK_LENGTH,
} from '../src/shared/interface-typography'
import { fontFamilyStack } from '../src/renderer/src/settings/typography-settings'
import { describe, expect, it, vi } from 'vitest'
import {
  ExtensionGuestOwner,
  DEFAULT_EXTENSION_PRESENTATION,
} from '../src/main/extensions/guest-owner'
import { contextFixture } from './fixtures/extension-context'
import { localPath } from '../src/shared/host-path'

import { fixture, attached } from './fixtures/extension-guest'

describe('extension guest capability and lifetime owner', () => {
  it('reports allocation only for a new view while reuse remains independently owned', async () => {
    const data = fixture()
    const created = vi.fn(),
      reused = vi.fn()
    try {
      const view = await data.owner.open(
        data.renderer,
        'installation',
        'reference',
        undefined,
        { select: false, focus: false, onCreated: created },
      )
      expect(created).toHaveBeenCalledExactlyOnceWith(view)
      expect(
        await data.owner.open(data.renderer, 'installation', 'reference', undefined, {
          select: false,
          focus: false,
          onCreated: reused,
        }),
      ).toBe(view)
      expect(reused).not.toHaveBeenCalled()
      expect(data.destroy).not.toHaveBeenCalled()
    } finally {
      await data.owner.dispose()
    }
    expect(data.destroy).toHaveBeenCalledOnce()
  })
  it.each(['allocation', 'preparation'] as const)(
    'drains a newly allocated view when its %s callback fails',
    async (stage) => {
      const created = vi.fn(() => {
        if (stage === 'allocation') throw new Error('creation refused')
      })
      const data = fixture({
        prepare: () => Promise.reject(new Error('preparation refused')),
      })
      try {
        await expect(
          data.owner.open(data.renderer, 'installation', 'reference', undefined, {
            onCreated: created,
          }),
        ).rejects.toThrow('refused')
        expect(created).toHaveBeenCalledOnce()
        expect(data.owner.snapshot(data.renderer)).toEqual([])
        await data.owner.dispose()
        expect(data.destroy).toHaveBeenCalledOnce()
      } finally {
        await data.owner.dispose()
      }
    },
  )
  it('negotiates updater observation while excluding source reveal and terminal handoff', async () => {
    const data = fixture(
      {},
      {
        updater: 'index.html',
        requiredCapabilities: ['presentation.read'],
        optionalCapabilities: ['source.request', 'source.reveal', 'terminal.start'],
      },
    )
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
    expect(
      data.sent.find((entry) => entry.message.kind === 'hello')?.message,
    ).toMatchObject({
      capabilities: ['presentation.read'],
    })
    await data.owner.dispose()
  })
  it('refuses a declared terminal handoff when the host has no terminal collaborator', async () => {
    const data = fixture({}, { requiredCapabilities: ['terminal.start'] })
    const view = await attached(data)
    data.owner.receive(10, { kind: 'hello', contract: '1.0' })
    data.owner.receive(10, {
      kind: 'request',
      id: 'terminal',
      capability: 'terminal.start',
      input: {},
    })
    await vi.waitFor(() =>
      expect(data.sent.find((entry) => entry.message.kind === 'result')).toMatchObject({
        message: {
          kind: 'result',
          ok: false,
          id: 'terminal',
          error: 'Terminal handoff is unavailable',
        },
      }),
    )
    expect(data.owner.snapshot(data.renderer)).toEqual([view])
    await data.owner.dispose()
  })
  it('publishes a separate action view without selecting it on first open or reuse', async () => {
    const data = fixture()
    const human = await attached(data)
    data.publish.mockClear()
    const options = { readingOrigin: 'action' as const, focus: false, select: false }
    const action = await data.owner.open(
      data.renderer,
      'installation',
      'reference',
      () => {},
      options,
    )
    expect(action.id).not.toBe(human.id)
    expect(data.publish).toHaveBeenLastCalledWith(
      data.renderer,
      expect.arrayContaining([human, action]),
      undefined,
      false,
    )
    await expect(
      data.owner.open(data.renderer, 'installation', 'reference', () => {}, options),
    ).resolves.toEqual(action)
    expect(data.publish).toHaveBeenLastCalledWith(
      data.renderer,
      expect.arrayContaining([human, action]),
      undefined,
      false,
    )
    await data.owner.close(data.renderer, action.id)
    expect(data.owner.snapshot(data.renderer)).toEqual([human])
    expect(() => data.owner.assertView(action.id)).toThrow(/unavailable/)
    expect(() => data.owner.assertView(human.id)).not.toThrow()
    await data.owner.dispose()
  })
  it('admits bounded resolved semantic colors, scale and monospace typography', async () => {
    const data = fixture()
    const view = await attached(data)
    data.owner.receive(10, { kind: 'hello', contract: '1.0' })
    const presentation = {
      ...DEFAULT_EXTENSION_PRESENTATION,
      colors: {
        ...DEFAULT_EXTENSION_PRESENTATION.colors,
        '--accent': 'color(srgb 0.2 0.4 0.6)',
      },
      monospaceFontFamily: '"Example Mono", monospace',
      interfaceScale: 1.2,
    }
    data.owner.presentation(data.renderer, view.id, presentation, true, true)
    expect(data.sent.at(-1)).toMatchObject({
      message: { kind: 'presentation', presentation },
    })
    for (const color of [
      'var(--accent)',
      'color-mix(in srgb, red, blue)',
      'url(file:///secret)',
      '#12345',
    ])
      expect(() =>
        data.owner.presentation(
          data.renderer,
          view.id,
          {
            ...presentation,
            colors: { ...presentation.colors, '--accent': color },
          },
          true,
          true,
        ),
      ).toThrow('presentation color')
    for (const interfaceScale of [0.79, 1.51, NaN, Infinity])
      expect(() =>
        data.owner.presentation(
          data.renderer,
          view.id,
          { ...presentation, interfaceScale },
          true,
          true,
        ),
      ).toThrow('presentation size')
    await data.owner.dispose()
  })
  it('refuses construction without the required context admission owner', () => {
    const data = fixture()
    expect(
      () =>
        new ExtensionGuestOwner(
          { active: data.active, assertWritable: data.assertWritable },
          data.scopes,
          data.surface,
          data.publish,
          undefined as unknown as ReturnType<typeof contextFixture>['contexts'],
          data.ports,
        ),
    ).toThrow('context admission')
  })
  it('reclaims capacity from exact previous-workspace left guests after physical disposal', async () => {
    const data = fixture(
      {},
      {
        views: [
          { ...exampleManifest().views[0]!, navigation: 'left', placement: 'workspace' },
        ],
      },
    )
    const state = data.context.sources.projectState(),
      project = state.projects[0]!,
      workspace = project.workspaces[0]!
    vi.spyOn(data.context.sources, 'projectState').mockReturnValue({
      ...state,
      projects: [
        {
          ...project,
          workspaces: Array.from({ length: 9 }, (_, index) => ({
            ...workspace,
            id: `workspace-${index}`,
            root: localPath(`/project-${index}`),
          })),
        },
      ],
    })
    const open = (index: number) =>
      data.owner.open(data.renderer, 'installation', 'reference', undefined, {
        context: { surface: 'left', workspaceId: `workspace-${index}` },
      })
    const retained = await Promise.all(
      Array.from({ length: 8 }, (_, index) => open(index)),
    )
    await expect(open(8)).rejects.toThrow('Close an extension view')
    let finish!: () => void
    const drained = new Promise<void>((resolve) => {
      finish = resolve
    })
    data.destroy.mockImplementation(() => drained)
    const closed = Promise.all(
      retained.map((view) => data.owner.close(data.renderer, view.id)),
    )
    let settled = false
    void closed.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    finish()
    await closed
    expect((await open(8)).context?.workspace?.id).toBe('workspace-8')
    expect(data.owner.snapshot(data.renderer)).toHaveLength(1)
    await data.owner.dispose()
  })
  it('discards expired action results without failing the view or cancelling current siblings', async () => {
    const data = fixture(
      {},
      {
        requiredCapabilities: ['presentation.read', 'context.read'],
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
    const view = await attached(data, 10, 'action')
    const actions = data.actions
    data.owner.receive(10, { kind: 'hello', contract: '1.0' })
    const activation = data.active.get('installation')!
    const cancelled = new AbortController()
    const invoke = (signal?: AbortSignal) =>
      actions.invoke(
        data.renderer,
        activation,
        'describe',
        null,
        { surface: 'viewer' },
        'agent',
        'standing',
        () => undefined,
        signal,
      )
    const expired = invoke(cancelled.signal)
    const rejected = expect(expired).rejects.toThrow('cancelled')
    await vi.waitFor(() =>
      expect(data.sent.filter((entry) => entry.message.kind === 'action')).toHaveLength(
        1,
      ),
    )
    const old = data.sent.find((entry) => entry.message.kind === 'action')!.message
    expect(old.kind).toBe('action')
    if (old.kind !== 'action') throw new Error('missing action')
    cancelled.abort()
    await rejected
    const sibling = invoke()
    await vi.waitFor(() =>
      expect(data.sent.filter((entry) => entry.message.kind === 'action')).toHaveLength(
        2,
      ),
    )
    const latest = data.sent
      .filter((entry) => entry.message.kind === 'action')
      .at(-1)!.message
    if (latest.kind !== 'action') throw new Error('missing sibling')
    data.owner.receive(10, {
      kind: 'action-result',
      id: old.invocation.id,
      value: 'late',
    })
    expect(data.owner.snapshot(data.renderer)).toEqual([view])
    expect(actions.provenance(view.id, latest.invocation.id)).toBeDefined()
    data.owner.receive(10, {
      kind: 'action-result',
      id: latest.invocation.id,
      value: 'current',
    })
    await expect(sibling).resolves.toBe('current')
    expect(data.destroy).not.toHaveBeenCalled()
    await data.owner.dispose()
  })

  it('revokes inherited child action authority when its originating invocation completes', async () => {
    const data = fixture(
      {},
      {
        requiredCapabilities: ['actions.invoke', 'context.read'],
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
    const view = await attached(data, 10, 'action')
    const actions = data.actions
    data.owner.receive(10, { kind: 'hello', contract: '1.0' })
    const parent = actions.invoke(
      data.renderer,
      data.active.get('installation')!,
      'describe',
      null,
      { surface: 'viewer' },
      'agent',
      'standing',
      () => undefined,
    )
    await vi.waitFor(() =>
      expect(data.sent.filter((entry) => entry.message.kind === 'action')).toHaveLength(
        1,
      ),
    )
    const parentMessage = data.sent.find(
      (entry) => entry.message.kind === 'action',
    )!.message
    if (parentMessage.kind !== 'action') throw new Error('missing parent')
    data.owner.receive(10, {
      kind: 'request',
      id: 'child-request',
      capability: 'actions.invoke',
      actionId: parentMessage.invocation.id,
      input: { action: 'describe', input: 'child' },
    })
    await vi.waitFor(() =>
      expect(data.sent.filter((entry) => entry.message.kind === 'action')).toHaveLength(
        2,
      ),
    )
    const child = data.sent
      .filter((entry) => entry.message.kind === 'action')
      .at(-1)!.message
    if (child.kind !== 'action') throw new Error('missing child')
    expect(child.invocation).toMatchObject({
      caller: 'agent',
      authorization: 'standing',
      input: 'child',
    })
    data.owner.receive(10, {
      kind: 'action-result',
      id: parentMessage.invocation.id,
      value: 'finished',
    })
    await expect(parent).resolves.toBe('finished')
    await vi.waitFor(() =>
      expect(data.sent).toContainEqual({
        guestId: 10,
        message: {
          kind: 'result',
          id: 'child-request',
          ok: false,
          error: 'Originating action was revoked',
          warnings: [],
        },
      }),
    )
    expect(actions.provenance(view.id, child.invocation.id)).toBeUndefined()
    data.owner.receive(10, {
      kind: 'action-result',
      id: child.invocation.id,
      value: 'late child',
    })
    expect(data.owner.snapshot(data.renderer)).toEqual([view])
    await data.owner.dispose()
  })

  it('withholds undeclared metadata and subscriptions and retains only current hidden snapshots', async () => {
    for (const declared of [false, true]) {
      const data = fixture(
        {},
        {
          requiredCapabilities: declared
            ? ['context.read', 'contributions.read']
            : ['presentation.read'],
          railItems: [
            {
              id: 'state',
              placement: 'header',
              kind: 'control',
              icon: '◇',
              tooltip: 'State',
              click: { view: 'reference', placement: 'viewer' },
            },
          ],
        },
      )
      const context = data.context
      const state = data.presentation
      const view = await data.owner.open(
        data.renderer,
        'installation',
        'reference',
        undefined,
        {
          context: {
            surface: 'viewer',
            workspaceId: 'workspace',
            sessionId: context.id(1),
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
      const initial = data.sent.find((entry) => entry.message.kind === 'context')!.message
      if (initial.kind !== 'context') throw new Error('missing context')
      expect(initial.context.session?.id).toBe(declared ? context.id(1) : undefined)
      expect(initial.context.workspace?.id).toBe(declared ? 'workspace' : undefined)
      expect(data.sent.some((entry) => entry.message.kind === 'contributions')).toBe(
        declared,
      )
      data.owner.presentation(
        data.renderer,
        view.id,
        DEFAULT_EXTENSION_PRESENTATION,
        false,
        false,
      )
      data.sent.length = 0
      context.change('title')
      data.owner.updateContext()
      for (let index = 0; index < 20; index++)
        await state.publish(
          data.active.get('installation')!,
          { item: 'state', label: `Latest ${index}` },
          () => [],
          () => undefined,
          new AbortController().signal,
        )
      expect(data.sent).toEqual([])
      data.owner.presentation(
        data.renderer,
        view.id,
        DEFAULT_EXTENSION_PRESENTATION,
        true,
        true,
      )
      const contexts = data.sent.filter((entry) => entry.message.kind === 'context')
      const values = data.sent.filter((entry) => entry.message.kind === 'contributions')
      if (declared) {
        expect(contexts).toMatchObject([
          { message: { context: { session: { title: 'Updated' } } } },
        ])
        expect(values).toMatchObject([{ message: { values: [{ label: 'Latest 19' }] } }])
      } else {
        expect(values).toEqual([])
        expect(contexts).toMatchObject([
          { message: { context: { surface: 'viewer', visible: true } } },
        ])
      }
      await data.owner.dispose()
    }
  })

  it('reapplies hidden intent only for the exact current physical guest and activation', async () => {
    const visibility = vi.fn()
    const data = fixture({ visibility })
    const view = await attached(data)
    visibility.mockClear()
    data.owner.nativeVisibilityChanged(99)
    data.owner.nativeVisibilityChanged(10)
    expect(visibility).not.toHaveBeenCalled()
    data.owner.presentation(
      data.renderer,
      view.id,
      DEFAULT_EXTENSION_PRESENTATION,
      false,
      false,
    )
    visibility.mockClear()
    data.owner.nativeVisibilityChanged(10)
    expect(visibility.mock.calls).toEqual([[10, false]])
    const activation = data.active.get('installation')!
    data.active.set('installation', { ...activation, generation: 'replacement' })
    data.owner.nativeVisibilityChanged(10)
    expect(visibility).toHaveBeenCalledTimes(1)
    data.active.set('installation', activation)
    await data.scopes.revokeOwner(data.renderer.id)
    data.scopes.activateOwner(data.renderer.id)
    data.owner.nativeVisibilityChanged(10)
    expect(visibility).toHaveBeenCalledTimes(1)
    await data.owner.dispose()
    data.owner.nativeVisibilityChanged(10)
    expect(visibility).toHaveBeenCalledTimes(1)
  })
  it('ignores native visibility from a failed or closed guest', async () => {
    const visibility = vi.fn()
    const data = fixture({ visibility })
    const view = await attached(data)
    data.owner.presentation(
      data.renderer,
      view.id,
      DEFAULT_EXTENSION_PRESENTATION,
      false,
      false,
    )
    visibility.mockClear()
    data.owner.failed(10)
    data.owner.nativeVisibilityChanged(10)
    await data.owner.close(data.renderer, view.id)
    data.owner.nativeVisibilityChanged(10)
    expect(visibility).not.toHaveBeenCalled()
    await data.owner.dispose()
  })
  it('accepts the longest escaped Settings font stack and applies visibility even for rejected presentation', async () => {
    const visibility = vi.fn()
    const data = fixture({ visibility })
    const view = await attached(data)
    data.owner.receive(10, { kind: 'hello', contract: '1.0' })
    const fontFamily = fontFamilyStack(
      { mode: 'custom', family: '\\'.repeat(MAX_FONT_FAMILY_LENGTH) },
      'interface',
    )
    expect(fontFamily.length).toBe(MAX_INTERFACE_FONT_STACK_LENGTH)
    data.owner.presentation(
      data.renderer,
      view.id,
      { ...DEFAULT_EXTENSION_PRESENTATION, fontFamily },
      true,
      true,
    )
    expect(data.sent.at(-1)).toMatchObject({
      message: { kind: 'presentation', presentation: { fontFamily } },
    })
    expect(() =>
      data.owner.presentation(
        data.renderer,
        view.id,
        {
          ...DEFAULT_EXTENSION_PRESENTATION,
          fontFamily: 'x'.repeat(MAX_INTERFACE_FONT_STACK_LENGTH + 1),
        },
        false,
        false,
      ),
    ).toThrow('interface font')
    expect(visibility).toHaveBeenLastCalledWith(10, false)
    await data.owner.dispose()
  })
  it('retains only the latest hidden presentation and publishes it on selection', async () => {
    const data = fixture()
    const view = await attached(data)
    data.owner.receive(10, { kind: 'hello', contract: '1.0' })
    data.sent.length = 0
    for (const interfaceScale of [1.1, 1.2, 1.3])
      data.owner.presentation(
        data.renderer,
        view.id,
        { ...DEFAULT_EXTENSION_PRESENTATION, interfaceScale },
        false,
        false,
      )
    expect(data.sent.filter((entry) => entry.message.kind === 'presentation')).toEqual([])
    data.owner.presentation(
      data.renderer,
      view.id,
      { ...DEFAULT_EXTENSION_PRESENTATION, interfaceScale: 1.3 },
      true,
      true,
    )
    expect(data.sent.filter((entry) => entry.message.kind === 'presentation')).toEqual([
      {
        guestId: 10,
        message: {
          kind: 'presentation',
          presentation: { ...DEFAULT_EXTENSION_PRESENTATION, interfaceScale: 1.3 },
        },
      },
    ])
    await data.owner.dispose()
  })
  it('bounds views per extension and requests per view and extension without queuing excess work', async () => {
    const data = fixture()
    await attached(data)
    const detail = await data.owner.open(data.renderer, 'installation', 'detail')
    data.owner.claim(data.renderer, detail.partition, detail.url, detail.id)
    data.owner.bind(data.renderer, detail.partition, 11)
    data.owner.presentation(
      data.renderer,
      detail.id,
      DEFAULT_EXTENSION_PRESENTATION,
      true,
      true,
    )
    const otherRenderer = data.scopes.activateOwner(2)
    const third = await data.owner.open(otherRenderer, 'installation', 'reference')
    data.owner.claim(otherRenderer, third.partition, third.url, third.id)
    data.owner.bind(otherRenderer, third.partition, 12)
    data.owner.presentation(
      otherRenderer,
      third.id,
      DEFAULT_EXTENSION_PRESENTATION,
      true,
      true,
    )
    for (let id = 3; id < 8; id++)
      await data.owner.open(data.scopes.activateOwner(id), 'installation', 'reference')
    await expect(
      data.owner.open(data.scopes.activateOwner(8), 'installation', 'reference'),
    ).rejects.toThrow('Close an extension view')
    for (const guestId of [10, 11, 12])
      data.owner.receive(guestId, { kind: 'hello', contract: '1.0' })
    let finish: (() => void) | undefined
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    data.assertWritable.mockImplementation(() => pending)
    for (const guestId of [10, 11])
      for (let index = 0; index < 8; index++) {
        data.owner.receive(guestId, {
          kind: 'request',
          id: `pending-${index}`,
          capability: 'presentation.read',
        })
      }
    data.owner.receive(10, {
      kind: 'request',
      id: 'view-overflow',
      capability: 'presentation.read',
    })
    data.owner.receive(12, {
      kind: 'request',
      id: 'extension-overflow',
      capability: 'presentation.read',
    })
    expect(data.sent.slice(-2).map((entry) => entry.message)).toEqual([
      expect.objectContaining({
        id: 'view-overflow',
        ok: false,
        error: 'Extension request capacity is full',
      }),
      expect.objectContaining({
        id: 'extension-overflow',
        ok: false,
        error: 'Extension request capacity is full',
      }),
    ])
    finish!()
    await vi.waitFor(() =>
      expect(
        data.sent.filter((entry) => entry.message.kind === 'result' && entry.message.ok),
      ).toHaveLength(16),
    )
    await data.owner.dispose()
  })
  it('does not publish or attach a pending surface through a concurrent duplicate Open', async () => {
    let finish: (() => void) | undefined
    const data = fixture({
      prepare: () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    })
    const opening = data.owner.open(data.renderer, 'installation', 'reference')
    await vi.waitFor(() => expect(finish).toBeDefined())
    await expect(
      data.owner.open(data.renderer, 'installation', 'reference'),
    ).rejects.toThrow('opening')
    expect(data.owner.snapshot(data.renderer)).toEqual([])
    expect(data.publish).not.toHaveBeenCalled()
    finish!()
    await opening
    expect(data.owner.snapshot(data.renderer)).toHaveLength(1)
    await data.owner.dispose()
  })
  it('binds one exact attachment and ignores forged guest/view/approval identity fields', async () => {
    const data = fixture()
    const view = await attached(data)
    expect(
      data.owner.claim(data.renderer, view.partition, view.url, view.id),
    ).toBeUndefined()
    expect(data.owner.bind(data.renderer, view.partition, 99)).toBeUndefined()
    data.owner.receive(99, {
      kind: 'hello',
      contract: '1.0',
      viewId: view.id,
      userApproved: true,
    })
    expect(data.sent).toEqual([])
    data.owner.receive(10, { kind: 'hello', contract: '1.0', userApproved: true })
    expect(
      data.sent.find((entry) => entry.message.kind === 'hello')?.message,
    ).toMatchObject({
      kind: 'hello',
      capabilities: ['presentation.read', 'viewer.open-own'],
      warnings: ['Ignored unknown field: userApproved'],
    })
    data.owner.receive(10, {
      kind: 'request',
      id: 'ungranted',
      capability: 'project.read',
      input: { userApproved: true, host: 'all' },
    })
    expect(data.sent.at(-1)?.message).toMatchObject({
      kind: 'result',
      id: 'ungranted',
      ok: false,
    })
  })
  it('requires negotiation and confines view targets to its accepted declarations', async () => {
    const data = fixture()
    await attached(data)
    data.owner.receive(10, {
      kind: 'request',
      id: 'early',
      capability: 'viewer.open-own',
      input: { contributionId: 'detail' },
    })
    expect(data.sent.at(-1)?.message).toMatchObject({
      ok: false,
      error: 'Negotiate before requesting a capability',
    })
    data.owner.receive(10, { kind: 'hello', contract: '1.0' })
    data.owner.receive(10, {
      kind: 'request',
      id: 'other',
      capability: 'viewer.open-own',
      input: { contributionId: 'elsewhere' },
    })
    await vi.waitFor(() =>
      expect(data.sent.at(-1)?.message).toMatchObject({ id: 'other', ok: false }),
    )
    data.owner.receive(10, {
      kind: 'request',
      id: 'own',
      capability: 'viewer.open-own',
      input: { contributionId: 'detail', installationId: 'other', approved: true },
    })
    await vi.waitFor(() =>
      expect(data.sent.at(-1)?.message).toMatchObject({ id: 'own', ok: true }),
    )
    expect(data.owner.snapshot(data.renderer).map((view) => view.contributionId)).toEqual(
      ['reference', 'detail'],
    )
  })
  it('refuses hidden refresh and bounds message rate independently of the guest preload', async () => {
    const data = fixture()
    const view = await attached(data)
    data.owner.receive(10, { kind: 'hello', contract: '1.0' })
    data.owner.presentation(
      data.renderer,
      view.id,
      DEFAULT_EXTENSION_PRESENTATION,
      false,
      false,
    )
    data.owner.receive(10, {
      kind: 'request',
      id: 'hidden',
      capability: 'presentation.read',
    })
    expect(data.sent.at(-1)?.message).toMatchObject({ id: 'hidden', ok: false })
    for (let index = 0; index < 31; index++)
      data.owner.receive(10, { kind: 'cancel', id: `cancel-${index}` })
    expect(data.owner.snapshot(data.renderer)[0]?.failure).toContain('stopped')
    await data.owner.close(data.renderer, view.id)
    expect(data.owner.snapshot(data.renderer)).toEqual([])
    expect(data.destroy).toHaveBeenCalled()
  })
  it('reclaims guest capacity after close and rejects late preparation after disable', async () => {
    let finish: (() => void) | undefined
    const data = fixture({
      prepare: () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    })
    const opening = data.owner.open(data.renderer, 'installation', 'reference')
    await vi.waitFor(() => expect(finish).toBeDefined())
    data.active.clear()
    data.owner.revokeInstallation('installation')
    finish!()
    await expect(opening).rejects.toThrow('revoked')
    expect(data.owner.snapshot(data.renderer)).toEqual([])
    expect(data.destroy).toHaveBeenCalledOnce()
  })
  it('revokes all renderer descendants before late capability completion and rejects reused generations', async () => {
    const data = fixture()
    const view = await attached(data)
    data.owner.receive(10, { kind: 'hello', contract: '1.0' })
    await data.scopes.rolloverOwner(data.renderer.id).cleanup
    expect(data.owner.snapshot(data.renderer)).toEqual([])
    expect(data.sent.at(-1)?.message).toEqual({ kind: 'revoked' })
    data.owner.receive(10, {
      kind: 'request',
      id: 'late',
      capability: 'presentation.read',
    })
    expect(
      data.sent.some(
        (entry) => entry.message.kind === 'result' && entry.message.id === 'late',
      ),
    ).toBe(false)
    expect(
      data.owner.claim(data.renderer, view.partition, view.url, view.id),
    ).toBeUndefined()
    await data.owner.dispose()
    await data.owner.dispose()
    expect(data.destroy).toHaveBeenCalledOnce()
  })
  it('cancelled requests cannot open late views', async () => {
    let finish: (() => void) | undefined
    let prepares = 0
    const data = fixture({
      prepare: () =>
        ++prepares === 1
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              finish = resolve
            }),
    })
    await attached(data)
    data.owner.receive(10, { kind: 'hello', contract: '1.0' })
    data.owner.receive(10, {
      kind: 'request',
      id: 'cancel-me',
      capability: 'viewer.open-own',
      input: { contributionId: 'detail' },
    })
    await vi.waitFor(() => expect(finish).toBeDefined())
    data.owner.receive(10, { kind: 'cancel', id: 'cancel-me' })
    finish!()
    await vi.waitFor(() =>
      expect(
        data.owner.snapshot(data.renderer).map((view) => view.contributionId),
      ).toEqual(['reference']),
    )
    expect(
      data.sent.some(
        (entry) => entry.message.kind === 'result' && entry.message.id === 'cancel-me',
      ),
    ).toBe(false)
  })
  it('renderer revocation waits for its actual per-view disposal receipt without draining another owner', async () => {
    const receipts = new Map<string, { promise: Promise<void>; finish: () => void }>()
    const data = fixture({
      destroy: (id) => {
        let finish!: () => void
        const promise = new Promise<void>((resolve) => {
          finish = resolve
        })
        receipts.set(id, { promise, finish })
        return promise
      },
    })
    const first = await attached(data)
    const other = data.scopes.activateOwner(2)
    const second = await data.owner.open(other, 'installation', 'reference')
    const closingOther = data.owner.close(other, second.id)
    expect(data.owner.close(other, second.id)).toBe(closingOther)
    const revoked = data.scopes.rolloverOwner(data.renderer.id)
    expect(data.owner.snapshot(data.renderer)).toEqual([])
    expect(data.sent.at(-1)?.message).toEqual({ kind: 'revoked' })
    let complete = false
    void revoked.cleanup.then(() => {
      complete = true
    })
    await Promise.resolve()
    expect(complete).toBe(false)
    receipts.get(first.id)!.finish()
    await revoked.cleanup
    expect(complete).toBe(true)
    let otherComplete = false
    void closingOther.then(() => {
      otherComplete = true
    })
    await Promise.resolve()
    expect(otherComplete).toBe(false)
    receipts.get(second.id)!.finish()
    await closingOther
    await data.owner.dispose()
  })
  it('retains a failed native disposal receipt for later renderer-scoped cleanup', async () => {
    const failure = new Error('native cleanup refused')
    const data = fixture({ destroy: () => Promise.reject(failure) })
    const view = await attached(data)
    const receipt = data.owner.close(data.renderer, view.id)
    await expect(receipt).rejects.toBe(failure)
    expect(data.owner.close(data.renderer, view.id)).toBe(receipt)
    await expect(data.scopes.revokeOwner(data.renderer.id)).rejects.toMatchObject({
      errors: [{ errors: [failure] }],
    })
    await expect(data.owner.dispose()).rejects.toMatchObject({ errors: [failure] })
  })
  it('reports one failed disposal only after every affected view receipt settles', async () => {
    const failure = new Error('native cleanup refused')
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    let firstId = ''
    const data = fixture({
      destroy: (id) => (id === firstId ? Promise.reject(failure) : pending),
    })
    firstId = (await attached(data)).id
    await data.owner.open(data.renderer, 'installation', 'detail')
    const draining = data.scopes.revokeOwner(data.renderer.id)
    let complete = false
    void draining.then(
      () => {
        complete = true
      },
      () => {
        complete = true
      },
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(complete).toBe(false)
    finish()
    await expect(draining).rejects.toMatchObject({ errors: [{ errors: [failure] }] })
    expect(complete).toBe(true)
    await expect(data.owner.dispose()).rejects.toMatchObject({ errors: [failure] })
  })
})
