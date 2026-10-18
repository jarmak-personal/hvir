import { expect, it, vi } from 'vitest'
import { DEFAULT_EXTENSION_PRESENTATION } from '../src/main/extensions/guest-owner'
import { attached, fixture } from './fixtures/extension-guest'

it('retains the same ordinary guest and selected input while admitting an exact trusted destination', async () => {
  const f = fixture({}, { requiredCapabilities: ['context.read', 'viewer.open-own'] })
  try {
    const view = await attached(f)
    f.owner.receive(10, { kind: 'hello', contract: '1.0' })
    expect(view.context?.workspace).toBeUndefined()
    const targeted = f.owner.targetWorkspace(f.renderer, view.id, 'workspace')
    expect(targeted.id).toBe(view.id)
    expect(targeted.partition).toBe(view.partition)
    expect(targeted.context?.workspace?.root).toEqual({
      hostId: 'local',
      path: '/project',
    })
    expect(f.destroy).not.toHaveBeenCalled()
    expect(f.ports.sources.closeView).toHaveBeenCalledWith(view.id)
    const independent = f.owner.targetWorkspace(f.renderer, view.id)
    expect(independent.context?.workspace).toBeUndefined()
    expect(f.owner.snapshot(f.renderer)).toHaveLength(1)
  } finally {
    await f.owner.dispose()
  }
})
it.each([undefined, 'application'] as const)(
  'uses only explicit own-view launch context (%s), preserving independent application entry',
  async (context) => {
    const f = fixture()
    try {
      const source = await attached(f)
      f.owner.targetWorkspace(f.renderer, source.id, 'workspace')
      f.owner.receive(10, { kind: 'hello', contract: '1.0' })
      f.owner.receive(10, {
        kind: 'request',
        id: 'open-library',
        capability: 'viewer.open-own',
        input: { contributionId: 'detail', ...(context ? { context } : {}) },
      })
      await vi.waitFor(() =>
        expect(
          f.sent.some(
            ({ message }) =>
              message.kind === 'result' && message.id === 'open-library' && message.ok,
          ),
        ).toBe(true),
      )
      const opened = f.owner
        .snapshot(f.renderer)
        .find(({ contributionId }) => contributionId === 'detail')!
      expect(opened.context?.workspace?.id).toBe(context ? undefined : 'workspace')
      expect(
        f.owner.snapshot(f.renderer).find(({ id }) => id === source.id)?.context
          ?.workspace?.id,
      ).toBe('workspace')
    } finally {
      await f.owner.dispose()
    }
  },
)
it.each(['agent', 'action'] as const)(
  'does not grant trusted targeting to a %s origin',
  async (origin) => {
    const f = fixture()
    try {
      const view = await attached(f, 10, origin)
      expect(() => f.owner.targetWorkspace(f.renderer, view.id, 'workspace')).toThrow(
        /ordinary application/,
      )
      expect(f.owner.snapshot(f.renderer)[0]?.context?.workspace).toBeUndefined()
    } finally {
      await f.owner.dispose()
    }
  },
)
it('rejects unavailable targets without changing the selected context', async () => {
  const f = fixture()
  try {
    const view = await attached(f)
    expect(() => f.owner.targetWorkspace(f.renderer, view.id, 'unknown')).toThrow(
      /unavailable/,
    )
    f.context.change('close')
    expect(() => f.owner.targetWorkspace(f.renderer, view.id, 'workspace')).toThrow(
      /unavailable/,
    )
    expect(f.owner.snapshot(f.renderer)[0]?.context?.workspace).toBeUndefined()
  } finally {
    await f.owner.dispose()
  }
})
it('retires an old-context request before its late completion can publish into the new destination', async () => {
  const f = fixture({}, { requiredCapabilities: ['context.read'] })
  let settle!: () => void
  try {
    const view = await attached(f)
    f.owner.receive(10, { kind: 'hello', contract: '1.0' })
    f.assertWritable.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve
        }),
    )
    f.owner.receive(10, {
      kind: 'request',
      id: 'old',
      capability: 'context.read',
      input: null,
    })
    f.owner.targetWorkspace(f.renderer, view.id, 'workspace')
    settle()
    await vi.waitFor(() =>
      expect(
        f.sent.filter(({ message }) => message.kind === 'result' && message.id === 'old'),
      ).toHaveLength(1),
    )
    expect(
      f.sent.find(({ message }) => message.kind === 'result' && message.id === 'old')
        ?.message,
    ).toMatchObject({ ok: false })
  } finally {
    await f.owner.dispose()
  }
})
it('keeps the admitted action pinned by refusing target changes until it settles', async () => {
  const f = fixture({}, { requiredCapabilities: ['actions.invoke'] })
  let settle!: () => void
  try {
    const view = await attached(f)
    f.owner.receive(10, { kind: 'hello', contract: '1.0' })
    f.assertWritable.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve
        }),
    )
    f.owner.receive(10, {
      kind: 'request',
      id: 'action',
      capability: 'actions.invoke',
      input: { action: 'unknown' },
    })
    expect(() => f.owner.targetWorkspace(f.renderer, view.id, 'workspace')).toThrow(
      /current extension operation/,
    )
    settle()
    await vi.waitFor(() =>
      expect(
        f.sent.some(
          ({ message }) => message.kind === 'result' && message.id === 'action',
        ),
      ).toBe(true),
    )
    expect(
      f.owner.targetWorkspace(f.renderer, view.id, 'workspace').context?.workspace?.id,
    ).toBe('workspace')
  } finally {
    await f.owner.dispose()
  }
})

it('refuses hidden target changes and retains request identity admission until old work settles', async () => {
  const f = fixture({}, { requiredCapabilities: ['context.read'] })
  let settle!: () => void
  try {
    const view = await attached(f)
    f.owner.receive(10, { kind: 'hello', contract: '1.0' })
    f.assertWritable.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve
        }),
    )
    f.owner.receive(10, {
      kind: 'request',
      id: 'reused',
      capability: 'context.read',
      input: null,
    })
    f.owner.targetWorkspace(f.renderer, view.id, 'workspace')
    f.owner.receive(10, {
      kind: 'request',
      id: 'reused',
      capability: 'context.read',
      input: null,
    })
    expect(
      f.sent.filter(
        ({ message }) => message.kind === 'result' && message.id === 'reused',
      ),
    ).toHaveLength(2)
    expect(f.sent.at(-1)?.message).toMatchObject({
      ok: false,
      error: 'Extension request capacity is full',
    })
    settle()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    f.owner.receive(10, {
      kind: 'request',
      id: 'reused',
      capability: 'context.read',
      input: null,
    })
    await vi.waitFor(() =>
      expect(f.sent.at(-1)?.message).toMatchObject({
        kind: 'result',
        id: 'reused',
        ok: true,
      }),
    )
    f.owner.presentation(
      f.renderer,
      view.id,
      { ...DEFAULT_EXTENSION_PRESENTATION },
      false,
      false,
      true,
    )
    expect(() => f.owner.targetWorkspace(f.renderer, view.id)).toThrow(
      /ordinary application/,
    )
  } finally {
    await f.owner.dispose()
  }
})

it.each(['completed', 'rejected'] as const)(
  'pins a physically unsettled delivery apply until it is %s',
  async (outcome) => {
    const f = fixture({}, { requiredCapabilities: ['delivery.apply'] })
    let resolve!: (value: unknown) => void, reject!: (reason: Error) => void
    const physical = new Promise<unknown>((yes, no) => {
      resolve = yes
      reject = no
    })
    vi.mocked(f.ports.deliveries.apply).mockReturnValue(physical as never)
    try {
      const view = await attached(f)
      f.owner.receive(10, { kind: 'hello', contract: '1.0' })
      f.owner.receive(10, {
        kind: 'request',
        id: 'delivery',
        capability: 'delivery.apply',
        input: { receipt: 'prepared' },
      })
      await vi.waitFor(() => expect(f.ports.deliveries.apply).toHaveBeenCalledTimes(1))
      expect(() => f.owner.targetWorkspace(f.renderer, view.id, 'workspace')).toThrow(
        /current extension operation/,
      )
      if (outcome === 'completed') resolve({ outcome: 'completed' })
      else reject(new Error('Delivery reply failed'))
      await vi.waitFor(() =>
        expect(
          f.sent.some(
            ({ message }) => message.kind === 'result' && message.id === 'delivery',
          ),
        ).toBe(true),
      )
      expect(
        f.owner.targetWorkspace(f.renderer, view.id, 'workspace').context?.workspace?.id,
      ).toBe('workspace')
    } finally {
      await f.owner.dispose()
    }
  },
)
