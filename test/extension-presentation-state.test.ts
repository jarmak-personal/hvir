import { describe, expect, it, vi } from 'vitest'
import { ExtensionPresentationState } from '../src/main/extensions/presentation-state'
import { validateCapturedExtension } from '../src/main/extensions/package-store'
import { exampleManifest } from './fixtures/extension-package'

function activation(kind: 'control' | 'observation' = 'observation') {
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
                    kind,
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
  it('isolates malformed saved entries and restores clock-rollback observations as stale', async () => {
    const active = activation(),
      now = Date.now()
    const state = new ExtensionPresentationState(
      {
        read: () =>
          Promise.resolve({
            broken: [{ item: 'signal' }],
            '22222222-2222-2222-2222-222222222222': [
              { item: 'signal', availability: 'current' },
            ],
            [active.installationId]: [
              { item: 'signal', availability: 'current', observedAt: now + 60000 },
            ],
          }),
        save: vi.fn(),
      },
      vi.fn(),
    )
    await expect(state.restore()).resolves.toBeUndefined()
    expect(state.values(active)).toHaveLength(1)
    expect(state.values(active)[0]).toMatchObject({
      item: 'signal',
      availability: 'stale',
    })
    expect(typeof state.values(active)[0]!.observedAt).toBe('number')
    expect(state.values(active)[0]!.observedAt).toBeLessThanOrEqual(Date.now())
  })
  it.each([null, [], 'invalid', { oversized: 'x'.repeat(256 * 1024) }])(
    'discards invalid saved cache without disabling presentation',
    async (saved) => {
      const active = activation()
      const state = new ExtensionPresentationState(
        { read: () => Promise.resolve(saved), save: vi.fn() },
        vi.fn(),
      )
      await expect(state.restore()).resolves.toBeUndefined()
      expect(state.values(active)).toEqual([])
    },
  )
  it('does not persist timer observations and publishes only application controls to storage', async () => {
    const observed = activation(),
      controlled = activation('control'),
      save = vi.fn(() => Promise.resolve()),
      changed = vi.fn()
    const state = new ExtensionPresentationState(
      { read: () => Promise.resolve({}), save },
      changed,
    )
    for (let index = 0; index < 20; index++)
      await state.publish(
        observed,
        {
          item: 'signal',
          label: String(index),
          availability: 'current',
          observedAt: Date.now(),
        },
        () => [],
        () => undefined,
        new AbortController().signal,
      )
    expect(save).not.toHaveBeenCalled()
    expect(state.values(observed)[0]!.label).toBe('19')
    state.pruneSessions([])
    expect(changed).toHaveBeenCalledTimes(20)
    state.stale(observed.installationId)
    state.stale(observed.installationId)
    expect(changed).toHaveBeenCalledTimes(21)
    await state.publish(
      controlled,
      { item: 'signal', label: 'Saved' },
      () => [],
      () => undefined,
      new AbortController().signal,
    )
    expect(save).toHaveBeenLastCalledWith(
      { [controlled.installationId]: [{ item: 'signal', label: 'Saved' }] },
      expect.any(Function),
      expect.any(AbortSignal),
    )
  })
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
    const active = activation('control')
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
      { item: 'signal', label: 'Saved control' },
      () => [],
      () => undefined,
      new AbortController().signal,
    )
    await Promise.resolve()
    let live = true
    const late = state.publish(
      active,
      { item: 'signal', session: 'old', label: 'Saved control' },
      () => (live ? ['old'] : []),
      () => undefined,
      new AbortController().signal,
    )
    const lateRejected = expect(late).rejects.toThrow('stale')
    const controller = new AbortController()
    const cancelled = state.publish(
      active,
      { item: 'signal', label: 'Saved control' },
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
    const active = activation('control')
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
    const value = { item: 'signal', label: 'Saved control' }
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
