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

function fixture() {
  const revision = validateCapturedExtension({
    sourceIdentity: '1:1',
    files: new Map([
      [
        'hvir-extension.json',
        new TextEncoder().encode(
          JSON.stringify(
            exampleManifest({
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
    send: vi.fn(),
  }
  const guests = new ExtensionGuestOwner(activations, scopes, surface, () => undefined)
  const contexts = contextFixture().contexts
  guests.contexts = contexts
  const presentation = new ExtensionPresentationState(
    { read: () => Promise.resolve({}), save: () => Promise.resolve() },
    () => undefined,
  )
  const contributions = new ExtensionContributionOwner(
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
  guests.updaterFailed = (view) => contributions.failed(view)
  guests.visibleContributionsChanged = () => contributions.contextChanged()
  return { active, scopes, a, b, guests, surface, contributions, presentation, demand }
}

describe('one shared updater from visible contribution demand', () => {
  it('runs one updater for several owners/rows and observes only current admitted demand', async () => {
    const data = fixture()
    await data.contributions.demand(
      data.a,
      data.demand(data.guests.contexts!.sessions(data.a)[0]!.id),
    )
    await data.contributions.demand(
      data.b,
      data.demand(data.guests.contexts!.sessions(data.b)[0]!.id),
    )
    expect(data.surface.prepare).toHaveBeenCalledTimes(1)
    expect(
      data.contributions.updaterSessions('one').map((session) => session.id),
    ).toEqual([
      data.guests.contexts!.sessions(data.a)[0]!.id,
      data.guests.contexts!.sessions(data.b)[0]!.id,
    ])
    await data.contributions.demand(data.a, [])
    expect(
      data.contributions.updaterSessions('one').map((session) => session.id),
    ).toEqual([data.guests.contexts!.sessions(data.b)[0]!.id])
    expect(data.surface.prepare).toHaveBeenCalledTimes(1)
    await data.contributions.demand(data.b, [])
    expect(data.contributions.updaterSessions('one')).toEqual([])
    await data.guests.dispose()
  })

  it('uses an exact visible ordinary viewer as independent demand and pauses the same updater on hide or failure', async () => {
    const data = fixture()
    const session = data.guests.contexts!.sessions(data.a)[0]!
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
    const visible = data.demand(data.guests.contexts!.sessions(data.a)[0]!.id)
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
      data.demand(data.guests.contexts!.sessions(data.a)[0]!.id),
    )
    await data.contributions.demand(
      data.b,
      data.demand(data.guests.contexts!.sessions(data.b)[0]!.id),
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
    const demand = data.demand(data.guests.contexts!.sessions(data.a)[0]!.id)
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
      ...data.demand(data.guests.contexts!.sessions(data.a)[0]!.id),
      {
        ...data.demand(data.guests.contexts!.sessions(data.a)[0]!.id)[0]!,
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
