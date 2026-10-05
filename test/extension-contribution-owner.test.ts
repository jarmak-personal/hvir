import { guestTestPorts } from './fixtures/extension-guest'
import { connectorFixture } from './fixtures/extension-connector'
import type { ExtensionGuestPorts } from '../src/main/extensions/guest-capability-ports'
import type { ExecResult } from '../src/shared/fs-types'
import { ExtensionActionOwner } from '../src/main/extensions/action-owner'
import { releasedExtension } from './fixtures/released-extension'
import { describe, expect, it, vi } from 'vitest'
import { ExtensionContributionOwner } from '../src/main/extensions/contribution-owner'
import {
  ExtensionGuestOwner,
  DEFAULT_EXTENSION_PRESENTATION,
  type ExtensionGuestSurfacePort,
} from '../src/main/extensions/guest-owner'
import { ExtensionPresentationState } from '../src/main/extensions/presentation-state'
import { RendererResourceScopes } from '../src/main/renderer-resource-scopes'
import { validateCapturedExtension } from '../src/main/extensions/package-store'
import { contextFixture } from './fixtures/extension-context'
import { exampleManifest } from './fixtures/extension-package'
import type { ExtensionActivationOwner } from '../src/main/extensions/activation'

function fixture(
  manifest: Record<string, unknown> = {},
  ports: Partial<ExtensionGuestPorts> = {},
) {
  const revision = validateCapturedExtension({
    sourceIdentity: '1:1',
    files: new Map([
      [
        'hvir-extension.json',
        new TextEncoder().encode(
          JSON.stringify(
            exampleManifest({
              ...manifest,
              updater: 'updater.html',
              railItems: [
                {
                  id: 'signal',
                  placement: 'session',
                  kind: 'observation',
                  icon: '◇',
                  tooltip: 'Signal',
                  click: { view: 'detail', placement: 'popup' },
                },
              ],
            }),
          ),
        ),
      ],
      ['index.html', new Uint8Array()],
      ['detail.html', new Uint8Array()],
      ['updater.html', new Uint8Array()],
    ]),
  })
  const activation = { installationId: 'one', generation: 'current', revision }
  const active = new Map([['one', activation]])
  const activations = {
    active,
    assertWritable: () => Promise.resolve(),
  } as ExtensionActivationOwner
  const scopes = new RendererResourceScopes(),
    a = scopes.activateOwner(1),
    b = scopes.activateOwner(2)
  const surface = {
    prepare: vi.fn<ExtensionGuestSurfacePort['prepare']>(() => Promise.resolve()),
    destroy: vi.fn<ExtensionGuestSurfacePort['destroy']>(() => Promise.resolve()),
    visibility: vi.fn(),
    foreground: (_owner: Parameters<ExtensionGuestSurfacePort['foreground']>[0]) => true,
    send: vi.fn<ExtensionGuestSurfacePort['send']>(),
  }
  const contexts = contextFixture().contexts
  const presentation = new ExtensionPresentationState(
    { read: () => Promise.resolve({}), save: () => Promise.resolve() },
    () => undefined,
  )
  const actions: ExtensionActionOwner = new ExtensionActionOwner({
    open: (owner, installation, contribution, options, admit) =>
      guests.open(owner, installation, contribution, admit, options),
    dispatch: (view, invocation) => guests.dispatch(view, invocation),
    runnable: (view, id, admitted) => guests.runnable(view, id, admitted),
    cancelAction: (view, id) => guests.cancelAction(view, id),
    assertView: (view) => guests.assertView(view),
  })
  const guests: ExtensionGuestOwner = new ExtensionGuestOwner(
    activations,
    scopes,
    surface,
    () => undefined,
    contexts,
    guestTestPorts(actions, presentation, {
      ...ports,
      updaterFailed: (view) => contributions.failed(view),
      visibleContributionsChanged: () => contributions.contextChanged(),
      connectorDemand: (id, workspace) => contributions.connectorDemand(id, workspace),
      updaterSessions: (id) => contributions.updaterSessions(id),
    }),
  )
  const contributions: ExtensionContributionOwner = new ExtensionContributionOwner(
    activations,
    guests,
    () => contexts,
    presentation,
    scopes,
    () => undefined,
  )
  const demand = (sessionId: string) => [
    {
      installationId: 'one',
      contributionId: 'signal',
      surface: 'rail' as const,
      workspaceId: 'workspace',
      sessionId,
    },
  ]
  return { active, scopes, a, b, guests, surface, contributions, presentation, demand }
}

describe('one shared updater from visible contribution demand', () => {
  it('excludes physical background owners immediately and ignores late rail demand', async () => {
    const data = fixture()
    let foreground = true
    data.surface.foreground = () => foreground
    await data.contributions.demand(
      data.a,
      data.demand(data.guests.contexts.sessions(data.a)[0]!.id),
    )
    expect(data.contributions.connectorDemand('one', 'workspace')).toBe(true)
    foreground = false
    expect(data.contributions.connectorDemand('one', 'workspace')).toBe(false)
    await data.contributions.demand(
      data.a,
      data.demand(data.guests.contexts.sessions(data.a)[0]!.id),
    )
    expect(data.contributions.connectorDemand('one', 'workspace')).toBe(false)
    await data.guests.dispose()
  })
  it('keeps the shared updater admitted by another foreground owner and cancels on final withdrawal', async () => {
    const native = connectorFixture()
    const data = fixture(
      {
        requiredCapabilities: ['connector.execute'],
        connectors: native.activation.revision.manifest.connectors,
      },
      { connectors: native.execution },
    )
    const activation = data.active.get('one')!
    native.active.set('one', activation)
    const foreground = new Set([data.a.id, data.b.id])
    data.surface.foreground = (owner = data.a) => foreground.has(owner.id)
    let complete!: (value: ExecResult) => void
    native.host.exec.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve
        }),
    )
    try {
      await native.approvals.start()
      const prepared = await native.approvals.prepare(
        {
          installationId: 'one',
          connector: 'tool',
          host: 'local',
          executable: '/installed/tool',
          configuration: { args: [], env: {} },
        },
        () => {},
      )
      await native.approvals.approve(prepared.token)
      await data.contributions.demand(
        data.a,
        data.demand(data.guests.contexts.sessions(data.a)[0]!.id),
      )
      await data.contributions.demand(
        data.b,
        data.demand(data.guests.contexts.sessions(data.b)[0]!.id),
      )
      const updater = data.guests
        .snapshot(data.a)
        .find((view) => view.role === 'updater')!
      data.guests.claim(data.a, updater.partition, updater.url, updater.id)
      data.guests.bind(data.a, updater.partition, 10)
      data.guests.receive(10, { kind: 'hello', contract: '1.0' })
      const request = (id: string) =>
        data.guests.receive(10, {
          kind: 'request',
          id,
          capability: 'connector.execute',
          input: { ...native.input, args: [id] },
        })
      const result = (id: string) =>
        data.surface.send.mock.calls.find(
          ([guest, message]) =>
            guest === 10 && message.kind === 'result' && message.id === id,
        )?.[1]
      request('held')
      await vi.waitFor(() => expect(native.host.exec).toHaveBeenCalledTimes(1))
      foreground.delete(data.a.id)
      data.guests.foregroundChanged(data.a)
      expect(data.surface.visibility).toHaveBeenLastCalledWith(10, true)
      complete({ code: 0, signal: null, stdout: 'ok', stderr: '' })
      await vi.waitFor(() =>
        expect(result('held')).toMatchObject({
          ok: true,
          value: { outcome: 'completed' },
        }),
      )
      request('withdraw')
      await vi.waitFor(() => expect(native.host.exec).toHaveBeenCalledTimes(2))
      foreground.delete(data.b.id)
      data.guests.foregroundChanged(data.b)
      expect(data.contributions.connectorDemand('one')).toBe(false)
      expect(data.surface.visibility).toHaveBeenLastCalledWith(10, false)
      await vi.waitFor(() =>
        expect(result('withdraw')).toMatchObject({
          ok: true,
          value: { outcome: 'interrupted-uncertain' },
        }),
      )
      expect(data.surface.visibility).toHaveBeenLastCalledWith(10, false)
      await data.contributions.demand(
        data.b,
        data.demand(data.guests.contexts.sessions(data.b)[0]!.id),
      )
      expect(data.contributions.connectorDemand('one')).toBe(false)
      expect(data.surface.visibility).toHaveBeenLastCalledWith(10, false)
      complete({ code: 0, signal: null, stdout: 'late', stderr: '' })
      request('late')
      await vi.waitFor(() => expect(result('late')).toMatchObject({ ok: false }))
      expect(native.host.exec).toHaveBeenCalledTimes(2)
      expect(result('withdraw')).toMatchObject({
        value: { outcome: 'interrupted-uncertain' },
      })
      expect(data.surface.prepare).toHaveBeenCalledTimes(1)
    } finally {
      await data.guests.dispose()
      native.dispose()
    }
  })
  it('admits released navigation and exact session rails, pauses updater demand on withdrawal', async () => {
    const data = fixture()
    const activation = data.active.get('one')!
    data.active.set('one', { ...activation, revision: releasedExtension('reference') })
    try {
      const state = data.contributions.snapshot()[0]!
      expect(
        state.manifest.views
          .filter((view) => view.navigation)
          .map((view) => [view.id, view.navigation]),
      ).toEqual([
        ['workspace', 'left'],
        ['library', 'top'],
      ])
      expect(state.manifest.railItems?.map((item) => [item.id, item.placement])).toEqual([
        ['pulse', 'header'],
        ['session', 'session'],
      ])
      const session = data.guests.contexts.sessions(data.a)[0]!
      await data.contributions.demand(data.a, [
        { installationId: 'one', contributionId: 'pulse', surface: 'rail' },
        {
          installationId: 'one',
          contributionId: 'session',
          surface: 'rail',
          workspaceId: session.workspace.id,
          sessionId: session.id,
        },
        {
          installationId: 'one',
          contributionId: 'workspace',
          surface: 'left',
          workspaceId: session.workspace.id,
        },
        { installationId: 'one', contributionId: 'library', surface: 'top' },
      ])
      expect(data.surface.prepare).toHaveBeenCalledTimes(1)
      expect(
        data.contributions.updaterSessions('one').map((value) => value.id),
      ).toContain(session.id)
      const view = await data.guests.open(data.a, 'one', 'session', undefined, {
        context: {
          surface: 'popup',
          workspaceId: session.workspace.id,
          sessionId: session.id,
        },
      })
      expect(view.context?.session?.id).toBe(session.id)
      expect(view.contributionId).toBe('session')
      await data.contributions.demand(data.a, [])
      expect(data.contributions.updaterSessions('one')).toEqual([])
    } finally {
      await data.guests.dispose()
    }
  })
  it('withdraws old demand and admits independent valid entries when a session races publication', async () => {
    const data = fixture(),
      live = data.guests.contexts.sessions(data.a)[0]!.id
    await data.contributions.demand(data.a, data.demand(live))
    const first = data.guests.snapshot(data.a)[0]!
    data.guests.claim(data.a, first.partition, first.url, first.id)
    data.guests.bind(data.a, first.partition, 10)
    data.active.set('two', { ...data.active.get('one')!, installationId: 'two' })
    await expect(
      data.contributions.demand(data.a, [
        ...data.demand('ended'),
        { ...data.demand(live)[0]!, installationId: 'two' },
      ]),
    ).resolves.toBeUndefined()
    expect(data.surface.visibility).toHaveBeenCalledWith(10, false)
    expect(data.contributions.updaterSessions('one')).toEqual([])
    expect(
      data.guests.snapshot(data.a).some((view) => view.installationId === 'two'),
    ).toBe(true)
    await data.guests.dispose()
  })
  it('recovers a failed updater only after its exact hosting generation is revoked and physical disposal drains', async () => {
    const data = fixture(),
      aDemand = data.demand(data.guests.contexts.sessions(data.a)[0]!.id)
    await data.contributions.demand(data.a, aDemand)
    await data.contributions.demand(
      data.b,
      data.demand(data.guests.contexts.sessions(data.b)[0]!.id),
    )
    const first = data.guests.snapshot(data.a)[0]!
    data.guests.claim(data.a, first.partition, first.url, first.id)
    data.guests.bind(data.a, first.partition, 10)
    let finish!: () => void
    data.surface.destroy.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    data.guests.failed(10, 'Failed exact host')
    await data.contributions.demand(data.a, [])
    await data.contributions.demand(data.a, aDemand)
    expect(data.surface.prepare).toHaveBeenCalledTimes(1)
    const revoked = data.scopes.revokeOwner(data.a.id)
    await Promise.resolve()
    await Promise.resolve()
    expect(data.surface.prepare).toHaveBeenCalledTimes(1)
    finish()
    await revoked
    await vi.waitFor(() => expect(data.surface.prepare).toHaveBeenCalledTimes(2))
    expect(data.guests.snapshot(data.b)).toHaveLength(1)
    expect(data.contributions.snapshot()[0]!.error).toBeUndefined()
    await data.guests.dispose()
  })
  it('runs one updater for several owners/rows and observes only current admitted demand', async () => {
    const data = fixture()
    await data.contributions.demand(
      data.a,
      data.demand(data.guests.contexts.sessions(data.a)[0]!.id),
    )
    await data.contributions.demand(
      data.b,
      data.demand(data.guests.contexts.sessions(data.b)[0]!.id),
    )
    expect(data.surface.prepare).toHaveBeenCalledTimes(1)
    expect(
      data.contributions.updaterSessions('one').map((session) => session.id),
    ).toEqual([
      data.guests.contexts.sessions(data.a)[0]!.id,
      data.guests.contexts.sessions(data.b)[0]!.id,
    ])
    await data.contributions.demand(data.a, [])
    expect(
      data.contributions.updaterSessions('one').map((session) => session.id),
    ).toEqual([data.guests.contexts.sessions(data.b)[0]!.id])
    expect(data.surface.prepare).toHaveBeenCalledTimes(1)
    await data.contributions.demand(data.b, [])
    expect(data.contributions.updaterSessions('one')).toEqual([])
    await data.guests.dispose()
  })

  it('uses an exact visible ordinary viewer as independent demand and pauses the same updater on hide or failure', async () => {
    const data = fixture()
    const session = data.guests.contexts.sessions(data.a)[0]!
    const viewer = await data.guests.open(data.a, 'one', 'detail', undefined, {
      context: {
        surface: 'viewer',
        workspaceId: session.workspace.id,
        sessionId: session.id,
      },
    })
    expect(data.guests.snapshot(data.a)).toHaveLength(1)
    data.guests.claim(data.a, viewer.partition, viewer.url, viewer.id)
    data.guests.bind(data.a, viewer.partition, 11)
    data.guests.presentation(
      data.a,
      viewer.id,
      DEFAULT_EXTENSION_PRESENTATION,
      true,
      true,
    )
    await vi.waitFor(() =>
      expect(
        data.guests.snapshot(data.a).filter((view) => view.role === 'updater'),
      ).toHaveLength(1),
    )
    const updater = data.guests.snapshot(data.a).find((view) => view.role === 'updater')!
    data.guests.claim(data.a, updater.partition, updater.url, updater.id)
    data.guests.bind(data.a, updater.partition, 10)
    expect(data.contributions.updaterSessions('one')).toEqual([session])
    expect(data.surface.visibility).toHaveBeenLastCalledWith(10, true)
    data.surface.visibility.mockClear()
    data.guests.presentation(
      data.a,
      viewer.id,
      DEFAULT_EXTENSION_PRESENTATION,
      true,
      false,
    )
    await vi.waitFor(() =>
      expect(data.surface.visibility).toHaveBeenLastCalledWith(10, false),
    )
    expect(data.contributions.updaterSessions('one')).toEqual([])
    expect(data.surface.visibility).toHaveBeenNthCalledWith(1, 11, true)
    data.guests.presentation(
      data.a,
      viewer.id,
      DEFAULT_EXTENSION_PRESENTATION,
      true,
      true,
    )
    await vi.waitFor(() =>
      expect(data.surface.visibility).toHaveBeenLastCalledWith(10, true),
    )
    expect(data.guests.snapshot(data.a).find((view) => view.role === 'updater')?.id).toBe(
      updater.id,
    )
    data.guests.presentation(
      data.a,
      viewer.id,
      DEFAULT_EXTENSION_PRESENTATION,
      false,
      true,
    )
    await vi.waitFor(() =>
      expect(data.surface.visibility).toHaveBeenLastCalledWith(10, false),
    )
    expect(data.guests.visibleViewContributions()).toEqual([])
    data.guests.presentation(
      data.a,
      viewer.id,
      DEFAULT_EXTENSION_PRESENTATION,
      true,
      true,
    )
    await vi.waitFor(() =>
      expect(data.surface.visibility).toHaveBeenLastCalledWith(10, true),
    )
    data.guests.failed(11, 'Ordinary viewer stopped')
    await vi.waitFor(() =>
      expect(data.surface.visibility).toHaveBeenLastCalledWith(10, false),
    )
    expect(data.guests.visibleViewContributions()).toEqual([])
    expect(data.surface.prepare).toHaveBeenCalledTimes(2)
    await data.guests.dispose()
  })
  it('coalesces same-turn pause and resume after an existing updater reconciles', async () => {
    const data = fixture()
    const visible = data.demand(data.guests.contexts.sessions(data.a)[0]!.id)
    await data.contributions.demand(data.a, visible)
    const view = data.guests.snapshot(data.a)[0]!
    data.guests.claim(data.a, view.partition, view.url, view.id)
    data.guests.bind(data.a, view.partition, 10)
    data.surface.visibility.mockClear()
    const paused = data.contributions.demand(data.a, [])
    const resumed = data.contributions.demand(data.a, visible)
    await Promise.all([paused, resumed])
    expect(data.surface.visibility).toHaveBeenLastCalledWith(10, true)
    const resumedAgain = data.contributions.demand(data.a, visible)
    const pausedAgain = data.contributions.demand(data.a, [])
    await Promise.all([resumedAgain, pausedAgain])
    expect(data.surface.visibility).toHaveBeenLastCalledWith(10, false)
    expect(data.surface.prepare).toHaveBeenCalledTimes(1)
    await data.guests.dispose()
  })
  it('revokes the physical hosting renderer and drains it before successor admission', async () => {
    const data = fixture()
    await data.contributions.demand(
      data.a,
      data.demand(data.guests.contexts.sessions(data.a)[0]!.id),
    )
    await data.contributions.demand(
      data.b,
      data.demand(data.guests.contexts.sessions(data.b)[0]!.id),
    )
    let finish!: () => void
    const disposal = new Promise<void>((resolve) => {
      finish = resolve
    })
    data.surface.destroy.mockImplementationOnce(() => disposal)
    const revoked = data.scopes.revokeOwner(1)
    await Promise.resolve()
    await Promise.resolve()
    expect(data.surface.prepare).toHaveBeenCalledTimes(1)
    finish()
    await revoked
    await vi.waitFor(() => expect(data.surface.prepare).toHaveBeenCalledTimes(2))
    expect(data.guests.snapshot(data.b)).toHaveLength(1)
    await data.scopes.revokeOwner(2)
  })
  it('marks unchanged-demand observations failed without automatically restarting an updater', async () => {
    const data = fixture()
    const demand = data.demand(data.guests.contexts.sessions(data.a)[0]!.id)
    await data.contributions.demand(data.a, demand)
    const view = data.guests.snapshot(data.a)[0]!
    data.guests.claim(data.a, view.partition, view.url, view.id)
    data.guests.bind(data.a, view.partition, 10)
    await data.presentation.publish(
      data.active.get('one')!,
      { item: 'signal', availability: 'current', observedAt: Date.now() },
      () => [],
      () => undefined,
      new AbortController().signal,
    )
    data.guests.failed(10, 'Native updater stopped')
    expect(data.contributions.snapshot()[0]).toMatchObject({
      error: 'Native updater stopped',
      values: [{ availability: 'failed' }],
    })
    await data.contributions.demand(data.a, demand)
    data.contributions.contextChanged()
    await Promise.resolve()
    await Promise.resolve()
    expect(data.surface.prepare).toHaveBeenCalledTimes(1)
    await data.guests.close(data.a, view.id)
    expect(data.guests.snapshot(data.a)).toEqual([])
    await data.guests.dispose()
  })
  it('contains one unavailable updater while independent contributions start', async () => {
    const data = fixture()
    data.active.set('two', { ...data.active.get('one')!, installationId: 'two' })
    data.surface.prepare.mockImplementation((view) =>
      view.installationId === 'one'
        ? Promise.reject(new Error('Unavailable'))
        : Promise.resolve(),
    )
    await data.contributions.demand(data.a, [
      ...data.demand(data.guests.contexts.sessions(data.a)[0]!.id),
      {
        ...data.demand(data.guests.contexts.sessions(data.a)[0]!.id)[0]!,
        installationId: 'two',
      },
    ])
    expect(
      data.contributions.snapshot().find((entry) => entry.installationId === 'one')
        ?.error,
    ).toBe('Unavailable')
    expect(
      data.guests.snapshot(data.a).filter((view) => view.installationId === 'two'),
    ).toHaveLength(1)
    await data.scopes.revokeOwner(1)
  })
})
