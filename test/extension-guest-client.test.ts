import { afterEach, expect, it, vi } from 'vitest'
import {
  guestClientFixture as fixture,
  type PackageClient,
} from './fixtures/extension-guest-client'

async function consumeMessages(
  f: ReturnType<typeof fixture>,
  client: PackageClient,
  count: number,
) {
  for (let index = 0; index < count; index++) {
    const result = client.request('connector.output')
    await vi.advanceTimersByTimeAsync(0)
    f.receive({ kind: 'result', id: f.sent.at(-1)!.id, ok: true, value: null })
    await result
  }
  f.sent.length = 0
}
afterEach(() => vi.useRealTimers())

it('submits hello synchronously once before consumers inspect negotiated state', () => {
  const f = fixture()
  try {
    f.client.hello()
    expect(f.sent).toEqual([{ kind: 'hello', contract: '1.0' }])
    f.client.hello()
    expect(f.sent).toHaveLength(1)
  } finally {
    f.client.dispose()
  }
})

it('completes four public CLI receipt cycles without inter-page timers even when background timers are clamped', async () => {
  vi.useFakeTimers()
  const f = fixture(true)
  try {
    f.client.hello()
    f.receive({ kind: 'action', invocation: { id: 'main-issued' } })
    const action = f.client.forAction({ id: 'main-issued' })
    for (let command = 0; command < 4; command++) {
      for (const capability of [
        'connector.execute',
        'connector.output',
        'connector.output',
        'connector.output',
      ]) {
        const completed = action.request(capability)
        await vi.advanceTimersByTimeAsync(0)
        f.receive({ kind: 'result', id: f.sent.at(-1)!.id, ok: true, value: null })
        await completed
      }
    }
    const reply = action.reply({ outcome: 'verified' })
    await vi.advanceTimersByTimeAsync(0)
    await expect(reply).resolves.toBe(true)
    expect(f.sent.filter((message) => message.kind === 'request')).toHaveLength(16)
    expect(f.sent.at(-1)).toMatchObject({ kind: 'action-result', id: 'main-issued' })
    expect(vi.getTimerCount()).toBe(0)
    action.dispose()
  } finally {
    f.client.dispose()
  }
})

it('bounds all outbound messages through repeated hide/resume and sequential short actions, cancelling only submitted requests', async () => {
  vi.useFakeTimers()
  const f = fixture()
  try {
    f.client.hello()
    for (let round = 0; round < 3; round++) {
      f.receive({ kind: 'context', context: { visible: true } })
      const requests = Array.from({ length: 8 }, () => f.client.request('source.read'))
      const rejected = Promise.allSettled(requests)
      await vi.advanceTimersByTimeAsync(0)
      f.receive({ kind: 'context', context: { visible: false } })
      expect((await rejected).every((result) => result.status === 'rejected')).toBe(true)
    }
    for (let index = 0; index < 35; index++) {
      const id = `main-issued-${index}`
      f.receive({ kind: 'action', invocation: { id } })
      const action = f.client.forAction({ id })
      let settled = false
      const reply = action.reply({ outcome: 'verified' }).then((value) => {
        settled = true
        return value
      })
      await vi.advanceTimersByTimeAsync(0)
      if (!settled) await vi.advanceTimersByTimeAsync(1050)
      await expect(reply).resolves.toBe(true)
      expect(action.alive).toBe(false)
      expect(action.signal.aborted).toBe(true)
    }
    const submitted = new Set(
      f.sent.filter((message) => message.kind === 'request').map((message) => message.id),
    )
    const cancels = f.sent.filter((message) => message.kind === 'cancel')
    expect(cancels.length).toBeGreaterThan(8)
    expect(cancels.every((message) => submitted.has(message.id))).toBe(true)
    expect(f.sent.filter((message) => message.kind === 'action-result')).toHaveLength(35)
    for (const time of f.times)
      expect(
        f.times.filter((value) => value >= time && value < time + 1000).length,
      ).toBeLessThanOrEqual(24)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    f.client.dispose()
  }
})

it('does not recycle a full monotonic transport window after a wall clock jump', async () => {
  vi.useFakeTimers()
  const f = fixture()
  try {
    f.receive({ kind: 'action', invocation: { id: 'main-issued' } })
    const action = f.client.forAction({ id: 'main-issued' })
    await consumeMessages(f, action, 24)
    vi.setSystemTime(Date.now() + 60_000)
    const reply = action.reply({ outcome: 'verified' })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.sent).toEqual([])
    await vi.advanceTimersByTimeAsync(1049)
    expect(f.sent).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await expect(reply).resolves.toBe(true)
    expect(f.sent).toHaveLength(1)
    action.dispose()
  } finally {
    f.client.dispose()
  }
})

it.each(['action-cancelled', 'revoked'])(
  'settles a saturated action reply and releases its wait without a late wire result on %s',
  async (kind) => {
    vi.useFakeTimers()
    const f = fixture()
    try {
      f.receive({ kind: 'action', invocation: { id: 'main-issued' } })
      const action = f.client.forAction({ id: 'main-issued' })
      await consumeMessages(f, action, 24)
      const reply = action.reply({ outcome: 'verified' })
      await vi.advanceTimersByTimeAsync(0)
      expect(vi.getTimerCount()).toBe(1)
      f.receive({ kind, id: 'main-issued' })
      await vi.advanceTimersByTimeAsync(0)
      await expect(reply).resolves.toBe(false)
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(2000)
      expect(f.sent).toEqual([])
    } finally {
      f.client.dispose()
    }
  },
)

it('paces admitted hidden action requests with exact provenance while ordinary body requests remain visibility gated', async () => {
  vi.useFakeTimers()
  const f = fixture()
  try {
    expect(() => f.client.forAction({ id: 'manufactured' })).toThrow(/admitted/)
    f.receive({ kind: 'action', invocation: { id: 'main-issued' } })
    const action = f.client.forAction({ id: 'main-issued' })
    const result = action.request('connector.execute', { args: ['library', 'init'] })
    await vi.advanceTimersByTimeAsync(0)
    const request = f.sent[0]!
    expect(request).toMatchObject({
      kind: 'request',
      capability: 'connector.execute',
      actionId: 'main-issued',
    })
    f.receive({ kind: 'result', id: request.id, ok: true, value: 'completed' })
    await expect(result).resolves.toBe('completed')
    await expect(f.client.request('source.select')).rejects.toThrow(/hidden/)
    action.dispose()
    expect(action.signal.aborted).toBe(true)
    await expect(action.request('connector.execute')).rejects.toThrow(/hidden/)
    expect(f.sent.filter((message) => message.kind === 'request')).toHaveLength(1)
  } finally {
    f.client.dispose()
  }
})

it('hiding an ordinary view cancels its paced read without recycling or canceling an admitted action request', async () => {
  vi.useFakeTimers()
  const f = fixture()
  try {
    f.receive({ kind: 'context', context: { visible: true } })
    f.receive({ kind: 'action', invocation: { id: 'main-issued' } })
    const action = f.client.forAction({ id: 'main-issued' })
    await consumeMessages(f, action, 23)
    const ordinary = f.client.request('source.read')
    const rejected = expect(ordinary).rejects.toThrow(/hidden/)
    const mutation = action.request('connector.execute')
    await vi.advanceTimersByTimeAsync(0)
    f.receive({ kind: 'context', context: { visible: false } })
    await rejected
    await vi.advanceTimersByTimeAsync(1050)
    const request = f.sent.find((message) => message.actionId === 'main-issued')!
    f.receive({ kind: 'result', id: request.id, ok: true, value: 'completed' })
    await expect(mutation).resolves.toBe('completed')
    expect(action.signal.aborted).toBe(false)
    action.dispose()
  } finally {
    f.client.dispose()
  }
})

it.each(['actions.invoke', 'connector.connect', 'source.request-trash'])(
  'retains submitted %s through view selection but refuses hidden or not-yet-submitted work',
  async (capability) => {
    vi.useFakeTimers()
    const f = fixture()
    try {
      f.receive({ kind: 'context', context: { visible: true } })
      const invocation = f.client.request(capability)
      await vi.advanceTimersByTimeAsync(0)
      const submitted = f.sent[0]!
      const queued = f.client.request(capability)
      const queuedRejection = expect(queued).rejects.toThrow(/hidden/)
      f.receive({ kind: 'context', context: { visible: false } })
      await queuedRejection
      await expect(f.client.request(capability)).rejects.toThrow(/hidden/)
      await expect(f.client.request('source.read')).rejects.toThrow(/hidden/)
      expect(f.sent).not.toContainEqual({ kind: 'cancel', id: submitted.id })
      f.receive({
        kind: 'result',
        id: submitted.id,
        ok: true,
        value: { outcome: 'verified' },
      })
      await expect(invocation).resolves.toMatchObject({ outcome: 'verified' })
      expect(f.sent.filter((message) => message.kind === 'request')).toHaveLength(1)
    } finally {
      f.client.dispose()
    }
  },
)

it('delivers a submitted Trash decision once through hide/show without resubmission', async () => {
  vi.useFakeTimers()
  const f = fixture()
  try {
    f.receive({ kind: 'context', context: { visible: true } })
    const completed = vi.fn()
    const request = f.client.request('source.request-trash').then(completed)
    await vi.advanceTimersByTimeAsync(0)
    const submitted = f.sent[0]!
    for (let index = 0; index < 2; index++) {
      f.receive({ kind: 'context', context: { visible: false } })
      await vi.advanceTimersByTimeAsync(1050)
      expect(completed).not.toHaveBeenCalled()
      f.receive({ kind: 'context', context: { visible: true } })
    }
    expect(f.sent).toEqual([submitted])
    f.receive({
      kind: 'result',
      id: submitted.id,
      ok: true,
      value: { outcome: 'cancelled' },
    })
    await request
    f.receive({
      kind: 'result',
      id: submitted.id,
      ok: true,
      value: { outcome: 'completed' },
    })
    expect(completed).toHaveBeenCalledExactlyOnceWith({ outcome: 'cancelled' })
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    f.client.dispose()
  }
})

it.each(['dispose', 'revoked'] as const)(
  '%s ends a hidden submitted Trash request and ignores its late result',
  async (ending) => {
    vi.useFakeTimers()
    const f = fixture()
    try {
      f.receive({ kind: 'context', context: { visible: true } })
      const fulfilled = vi.fn()
      const request = f.client.request('source.request-trash').then(fulfilled)
      const rejected = expect(request).rejects.toThrow(/closed/)
      await vi.advanceTimersByTimeAsync(0)
      const submitted = f.sent[0]!
      f.receive({ kind: 'context', context: { visible: false } })
      if (ending === 'dispose') f.client.dispose()
      else f.receive({ kind: 'revoked' })
      await rejected
      expect(f.sent.filter((message) => message.kind === 'cancel')).toEqual(
        ending === 'dispose' ? [{ kind: 'cancel', id: submitted.id }] : [],
      )
      f.receive({
        kind: 'result',
        id: submitted.id,
        ok: true,
        value: { outcome: 'completed' },
      })
      f.receive({ kind: 'context', context: { visible: true } })
      await vi.advanceTimersByTimeAsync(2000)
      expect(fulfilled).not.toHaveBeenCalled()
      expect(f.client.alive).toBe(false)
      expect(f.client.signal.aborted).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
      await expect(f.client.request('source.request-trash')).rejects.toThrow(/closed/)
    } finally {
      f.client.dispose()
    }
  },
)

it('revocation cancels the submitted outer invocation even after its caller is hidden', async () => {
  vi.useFakeTimers()
  const f = fixture()
  f.receive({ kind: 'context', context: { visible: true } })
  const invocation = f.client.request('actions.invoke')
  const rejected = expect(invocation).rejects.toThrow(/closed/)
  await vi.advanceTimersByTimeAsync(0)
  const submitted = f.sent[0]!
  f.receive({ kind: 'context', context: { visible: false } })
  f.receive({ kind: 'revoked' })
  await rejected
  expect(f.sent).not.toContainEqual({ kind: 'cancel', id: submitted.id })
  f.receive({ kind: 'result', id: submitted.id, ok: true, value: 'late' })
  expect(f.client.signal.aborted).toBe(true)
})

it.each(['action-cancelled', 'revoked'])(
  'rejects late paced completion and releases timers on %s',
  async (kind) => {
    vi.useFakeTimers()
    const f = fixture()
    try {
      f.receive({ kind: 'action', invocation: { id: 'main-issued' } })
      const action = f.client.forAction({ id: 'main-issued' })
      await consumeMessages(f, action, 23)
      const first = action.request('connector.execute')
      const second = action.request('connector.output')
      const rejectedFirst = expect(first).rejects.toThrow(),
        rejectedSecond = expect(second).rejects.toThrow()
      await vi.advanceTimersByTimeAsync(0)
      f.receive({ kind, id: 'main-issued' })
      await rejectedFirst
      await rejectedSecond
      expect(action.signal.aborted).toBe(true)
      await vi.advanceTimersByTimeAsync(100)
      expect(f.sent.filter((message) => message.kind === 'request')).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      f.client.dispose()
    }
  },
)

it('keeps only submitted Connect through passive picker focus loss, while hiding still cancels reads and disposal cancels Connect', async () => {
  const f = fixture()
  f.receive({ kind: 'context', context: { visible: true } })
  const connect = f.client.request('connector.connect', { connector: 'library-cli' })
  await vi.waitFor(() =>
    expect(f.sent.some((message) => message.capability === 'connector.connect')).toBe(
      true,
    ),
  )
  const connectId = f.sent.find(
    (message) => message.capability === 'connector.connect',
  )!.id
  const read = f.client.request('source.read')
  const readRejected = expect(read).rejects.toThrow(/hidden/)
  f.receive({ kind: 'context', context: { visible: false } })
  await readRejected
  expect(f.sent).not.toContainEqual({ kind: 'cancel', id: connectId })
  await expect(f.client.request('connector.connect')).rejects.toThrow(/hidden/)
  f.receive({ kind: 'context', context: { visible: true } })
  f.receive({
    kind: 'result',
    id: connectId,
    ok: true,
    value: { connections: [{ outcome: 'connected' }] },
  })
  await expect(connect).resolves.toEqual({ connections: [{ outcome: 'connected' }] })
  const next = f.client.request('connector.connect')
  await vi.waitFor(() =>
    expect(
      f.sent.filter((message) => message.capability === 'connector.connect'),
    ).toHaveLength(2),
  )
  const nextId = f.sent
    .filter((message) => message.capability === 'connector.connect')
    .at(-1)!.id
  const ended = expect(next).rejects.toThrow(/closed/)
  f.receive({ kind: 'context', context: { visible: false } })
  f.client.dispose()
  await ended
  expect(f.sent).toContainEqual({ kind: 'cancel', id: nextId })
})

it('bounds queued requests and cancellation obligations, deduplicates action replies, and frees slots only after sending', async () => {
  vi.useFakeTimers()
  const f = fixture()
  try {
    f.receive({ kind: 'context', context: { visible: true } })
    await consumeMessages(f, f.client, 16)
    const pending = Array.from({ length: 8 }, () => f.client.request('source.read'))
    const settled = Promise.allSettled(pending)
    await vi.advanceTimersByTimeAsync(0)
    await expect(f.client.request('source.read')).rejects.toThrow('capacity')
    f.receive({ kind: 'context', context: { visible: false } })
    expect((await settled).every((entry) => entry.status === 'rejected')).toBe(true)
    f.receive({ kind: 'context', context: { visible: true } })
    await expect(f.client.request('source.read')).rejects.toThrow('capacity')
    f.receive({ kind: 'action', invocation: { id: 'main-issued' } })
    const action = f.client.forAction({ id: 'main-issued' })
    const reply = action.reply({ done: true })
    expect(action.reply({ done: false })).toBe(reply)
    await vi.advanceTimersByTimeAsync(1050)
    await expect(reply).resolves.toBe(true)
    expect(f.sent.filter((message) => message.kind === 'cancel')).toHaveLength(8)
    expect(f.sent.filter((message) => message.kind === 'action-result')).toHaveLength(1)
    const next = f.client.request('source.read')
    await vi.advanceTimersByTimeAsync(0)
    f.receive({ kind: 'result', id: f.sent.at(-1)!.id, ok: true, value: 'current' })
    await expect(next).resolves.toBe('current')
  } finally {
    f.client.dispose()
  }
})

it('contains transport failure and rejects late cancelled completion without affecting another live action', async () => {
  vi.useFakeTimers()
  let throws = true
  const f = fixture(false, () => {
    if (throws) throw new Error('transport unavailable')
  })
  try {
    for (const id of ['first', 'second'])
      f.receive({ kind: 'action', invocation: { id } })
    const first = f.client.forAction({ id: 'first' }),
      second = f.client.forAction({ id: 'second' })
    await expect(first.request('connector.execute')).rejects.toThrow(
      'transport unavailable',
    )
    throws = false
    const one = first.request('connector.output'),
      two = second.request('connector.output')
    const rejected = expect(one).rejects.toThrow('action ended')
    await vi.advanceTimersByTimeAsync(0)
    f.receive({ kind: 'action-cancelled', id: 'first' })
    await rejected
    const requests = f.sent.filter((message) => message.kind === 'request').slice(-2)
    for (const request of requests)
      f.receive({ kind: 'result', id: request.id, ok: true, value: 'late-or-current' })
    await expect(two).resolves.toBe('late-or-current')
    expect(first.signal.aborted).toBe(true)
    expect(second.signal.aborted).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    f.client.dispose()
  }
})

it('disposal rejects queued action completion while flushing only submitted cancellation within the shared budget', async () => {
  vi.useFakeTimers()
  const f = fixture()
  f.receive({ kind: 'context', context: { visible: true } })
  f.receive({ kind: 'action', invocation: { id: 'main-issued' } })
  const action = f.client.forAction({ id: 'main-issued' })
  const read = f.client.request('source.read')
  const rejected = expect(read).rejects.toThrow('closed')
  await vi.advanceTimersByTimeAsync(0)
  const id = f.sent[0]!.id
  const reply = action.reply({ complete: true })
  f.client.dispose()
  await rejected
  await expect(reply).resolves.toBe(false)
  expect(f.sent).toEqual([
    { kind: 'request', id, capability: 'source.read' },
    { kind: 'cancel', id },
  ])
  expect(action.signal.aborted).toBe(true)
  expect(f.client.signal.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

it('retires a physically replied action before later queued work while preserving its deduplicated reply and unrelated reads', async () => {
  vi.useFakeTimers()
  const f = fixture()
  try {
    f.receive({ kind: 'context', context: { visible: true } })
    await consumeMessages(f, f.client, 24)
    for (const id of ['finished', 'sibling'])
      f.receive({ kind: 'action', invocation: { id } })
    const action = f.client.forAction({ id: 'finished' }),
      sibling = f.client.forAction({ id: 'sibling' })
    const reply = action.reply({ complete: true })
    const abandoned = action.request('source.read')
    const rejected = expect(abandoned).rejects.toThrow('action ended')
    const ordinary = f.client.request('presentation.read'),
      other = sibling.request('source.read')
    await vi.advanceTimersByTimeAsync(1049)
    expect(action.alive).toBe(true)
    expect(action.signal.aborted).toBe(false)
    expect(f.sent).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await expect(reply).resolves.toBe(true)
    await rejected
    expect(action.reply({ complete: false })).toBe(reply)
    expect(action.alive).toBe(false)
    expect(action.signal.aborted).toBe(true)
    expect(() => f.client.forAction({ id: 'finished' })).toThrow('admitted')
    action.dispose()
    action.dispose()
    expect(f.sent.map((message) => message.kind)).toEqual([
      'action-result',
      'request',
      'request',
    ])
    expect(f.sent.some((message) => message.actionId === 'finished')).toBe(false)
    for (const request of f.sent.filter((message) => message.kind === 'request'))
      f.receive({ kind: 'result', id: request.id, ok: true, value: 'current' })
    await expect(ordinary).resolves.toBe('current')
    await expect(other).resolves.toBe('current')
    expect(sibling.alive).toBe(true)
    expect(f.client.alive).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    f.client.dispose()
  }
})

it('ignores only an excess invocation while existing actions and ordinary work remain usable', async () => {
  const f = fixture()
  try {
    f.receive({ kind: 'context', context: { visible: true } })
    for (let index = 0; index < 4; index++)
      f.receive({ kind: 'action', invocation: { id: `action-${index}` } })
    const first = f.client.forAction({ id: 'action-0' }),
      sibling = f.client.forAction({ id: 'action-1' })
    const ordinary = f.client.request('presentation.read'),
      other = sibling.request('source.read')
    const settled = Promise.allSettled([ordinary, other])
    f.receive({ kind: 'action', invocation: { id: 'excess' } })
    expect(() => f.client.forAction({ id: 'excess' })).toThrow('admitted')
    expect(f.client.alive).toBe(true)
    expect(f.client.signal.aborted).toBe(false)
    expect(first.alive && sibling.alive).toBe(true)
    await Promise.resolve()
    for (const request of f.sent.filter((message) => message.kind === 'request'))
      f.receive({ kind: 'result', id: request.id, ok: true, value: 'current' })
    expect(await settled).toEqual([
      { status: 'fulfilled', value: 'current' },
      { status: 'fulfilled', value: 'current' },
    ])
    await expect(first.reply({ complete: true })).resolves.toBe(true)
    f.receive({ kind: 'action', invocation: { id: 'next' } })
    expect(f.client.forAction({ id: 'next' }).alive).toBe(true)
    expect(sibling.signal.aborted).toBe(false)
    expect(f.sent.some((message) => message.kind === 'cancel')).toBe(false)
  } finally {
    f.client.dispose()
  }
})

it.each(['cancelled', 'throw'])(
  'preserves reply identity and scope isolation when its physical send synchronously %s',
  async (event) => {
    let duringSend: (() => void) | undefined
    const f = fixture(false, (message) => {
      if (message.kind === 'action-result') duringSend?.()
    })
    try {
      for (const id of ['first', 'sibling'])
        f.receive({ kind: 'action', invocation: { id } })
      const action = f.client.forAction({ id: 'first' }),
        sibling = f.client.forAction({ id: 'sibling' })
      let duplicate: Promise<boolean> | undefined
      duringSend = () => {
        duplicate = action.reply({ duplicate: true })
        if (event === 'throw') throw new Error('transport unavailable')
        f.receive({ kind: 'action-cancelled', id: 'first' })
      }
      const reply = action.reply({ complete: true })
      if (event === 'throw') {
        await expect(reply).rejects.toThrow('transport unavailable')
        expect(action.alive).toBe(true)
        expect(action.signal.aborted).toBe(false)
        f.receive({ kind: 'action-cancelled', id: 'first' })
      } else await expect(reply).resolves.toBe(true)
      expect(duplicate).toBe(reply)
      expect(action.reply()).toBe(reply)
      expect(action.alive).toBe(false)
      expect(action.signal.aborted).toBe(true)
      action.dispose()
      expect(sibling.alive).toBe(true)
      expect(f.client.alive).toBe(true)
      expect(f.sent.filter((message) => message.kind === 'action-result')).toHaveLength(1)
    } finally {
      f.client.dispose()
    }
  },
)
