import { describe, expect, it, vi } from 'vitest'
import { ExtensionPresentationState } from '../src/main/extensions/presentation-state'
import { validateCapturedExtension } from '../src/main/extensions/package-store'
import { exampleManifest } from './fixtures/extension-package'

function activation() {
  return {
    installationId: '11111111-1111-1111-1111-111111111111',
    generation: 'current',
    revision: validateCapturedExtension({
      sourceIdentity: '1:1',
      files: new Map([
        [
          'hvir-extension.json',
          new TextEncoder().encode(
            JSON.stringify(
              exampleManifest({
                railItems: [
                  {
                    id: 'signal',
                    placement: 'session',
                    icon: '◇',
                    tooltip: 'Signal',
                    kind: 'observation',
                    click: { view: 'detail', placement: 'popup' },
                  },
                ],
              }),
            ),
          ),
        ],
        ['index.html', new Uint8Array()],
        ['detail.html', new Uint8Array()],
      ]),
    }),
  }
}

describe('bounded extension contribution presentation', () => {
  it('restores observations as stale and ends exact session state independently', async () => {
    const active = activation(),
      changed = vi.fn(),
      save = vi.fn(() => Promise.resolve())
    const state = new ExtensionPresentationState(
      {
        read: () =>
          Promise.resolve({
            [active.installationId]: [
              { item: 'signal', availability: 'current', observedAt: 1 },
            ],
          }),
        save,
      },
      changed,
    )
    await state.restore()
    expect(state.values(active)).toEqual([
      { item: 'signal', availability: 'stale', observedAt: 1 },
    ])
    await state.publish(
      active,
      {
        item: 'signal',
        session: 'live-one',
        label: 'Now',
        availability: 'current',
        observedAt: Date.now(),
      },
      () => ['live-one'],
      () => undefined,
      new AbortController().signal,
    )
    expect(save).not.toHaveBeenCalled()
    state.pruneSessions(['replacement'])
    expect(state.values(active)).toHaveLength(1)
  })

  it('checks cancelled and stale queued work at execution instead of saving old session state', async () => {
    const active = activation()
    let finish!: () => void
    const gate = new Promise<void>((resolve) => {
      finish = resolve
    })
    const save = vi.fn(async (_value, current: () => void, signal: AbortSignal) => {
      await gate
      signal.throwIfAborted()
      current()
    })
    const state = new ExtensionPresentationState(
      { read: () => Promise.resolve({}), save },
      () => undefined,
    )
    const first = state.publish(
      active,
      { item: 'signal', availability: 'current', observedAt: Date.now() },
      () => [],
      () => undefined,
      new AbortController().signal,
    )
    await Promise.resolve()
    let live = true
    const late = state.publish(
      active,
      { item: 'signal', session: 'old', availability: 'current', observedAt: Date.now() },
      () => (live ? ['old'] : []),
      () => undefined,
      new AbortController().signal,
    )
    const lateRejected = expect(late).rejects.toThrow('stale')
    const controller = new AbortController()
    const cancelled = state.publish(
      active,
      { item: 'signal', availability: 'current', observedAt: Date.now() },
      () => [],
      () => undefined,
      controller.signal,
    )
    const cancelledRejected = expect(cancelled).rejects.toThrow()
    live = false
    controller.abort()
    finish()
    await first
    await lateRejected
    await cancelledRejected
    expect(save).toHaveBeenCalledTimes(1)
    expect(state.values(active).some((value) => value.session)).toBe(false)
  })

  it('keeps timed-out queued storage work charged against the finite queue bound', async () => {
    const active = activation()
    let finish!: () => void
    const gate = new Promise<void>((resolve) => {
      finish = resolve
    })
    const save = vi.fn(async (_value, current: () => void, signal: AbortSignal) => {
      await gate
      signal.throwIfAborted()
      current()
    })
    const state = new ExtensionPresentationState(
      { read: () => Promise.resolve({}), save },
      vi.fn(),
    )
    const controllers = Array.from({ length: 64 }, () => new AbortController())
    const value = { item: 'signal', availability: 'current', observedAt: Date.now() }
    const pending = controllers.map((controller) =>
      state
        .publish(
          active,
          value,
          () => [],
          () => undefined,
          controller.signal,
        )
        .catch(() => undefined),
    )
    await Promise.resolve()
    for (const controller of controllers) controller.abort()
    expect(() =>
      state.publish(
        active,
        value,
        () => [],
        () => undefined,
        new AbortController().signal,
      ),
    ).toThrow('capacity')
    finish()
    await Promise.all(pending)
    expect(state.values(active)).toEqual([])
    await state.publish(
      active,
      value,
      () => [],
      () => undefined,
      new AbortController().signal,
    )
    expect(state.values(active)).toHaveLength(1)
  })

  it('refuses unknown targets and current observations without timestamps', async () => {
    const active = activation()
    const state = new ExtensionPresentationState(
      { read: () => Promise.resolve({}), save: () => Promise.resolve() },
      () => undefined,
    )
    await expect(
      state.publish(
        active,
        { item: 'other' },
        () => [],
        () => undefined,
        new AbortController().signal,
      ),
    ).rejects.toThrow('undeclared')
    await expect(
      state.publish(
        active,
        { item: 'signal', availability: 'current' },
        () => [],
        () => undefined,
        new AbortController().signal,
      ),
    ).rejects.toThrow('timestamp')
  })
})
