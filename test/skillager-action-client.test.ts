import { runInNewContext } from 'node:vm'
import { buildSync } from 'esbuild'
import { afterEach, expect, it, vi } from 'vitest'

interface PackageClient {
  request(capability: string, input?: unknown): Promise<unknown>
  dispose(): void
  readonly signal: AbortSignal
}
interface ActionClient extends PackageClient {
  reply(value?: unknown, error?: string): Promise<boolean>
}
interface GuestClient extends PackageClient {
  forAction(invocation: { readonly id: string }): ActionClient
  hello(): void
}
function fixture(clamped = false) {
  const sent: Array<Record<string, unknown>> = []
  const times: number[] = []
  let receive!: (message: unknown) => void
  const bundled = buildSync({
    entryPoints: ['packages/skillager-extension/src/bridge.mjs'],
    bundle: true,
    format: 'iife',
    globalName: 'Bridge',
    write: false,
  })
  const context = { Date, AbortController, Bridge: undefined as unknown }
  runInNewContext(bundled.outputFiles[0]!.text, context)
  const module = context.Bridge as {
    guestClient(bridge: unknown, clock: unknown): GuestClient
  }
  const client = module.guestClient(
    {
      onMessage(callback: typeof receive) {
        receive = callback
        return () => undefined
      },
      send(message: Record<string, unknown>) {
        sent.push(message)
        times.push(performance.now())
      },
    },
    {
      setTimeout: (callback: () => void, delay: number) =>
        setTimeout(callback, clamped ? Math.max(delay, 1000) : delay),
      clearTimeout,
      performance,
    },
  )
  return { client, receive: (message: unknown) => receive(message), sent, times }
}
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
      if (!settled) await vi.advanceTimersByTimeAsync(1000)
      await expect(reply).resolves.toBe(true)
      action.dispose()
    }
    const submitted = new Set(
      f.sent.filter((message) => message.kind === 'request').map((message) => message.id),
    )
    const cancels = f.sent.filter((message) => message.kind === 'cancel')
    expect(cancels.length).toBeGreaterThan(8)
    expect(cancels.every((message) => submitted.has(message.id))).toBe(true)
    expect(f.sent.filter((message) => message.kind === 'action-result')).toHaveLength(35)
    for (const time of f.times)
      expect(f.times.filter((value) => value >= time && value < time + 1000).length).toBeLessThanOrEqual(24)
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
    await vi.advanceTimersByTimeAsync(999)
    expect(f.sent).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await expect(reply).resolves.toBe(true)
    expect(f.sent).toHaveLength(1)
    action.dispose()
  } finally {
    f.client.dispose()
  }
})

it.each(['action-cancelled', 'revoked'])('settles a saturated action reply and releases its wait without a late wire result on %s', async (kind) => {
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
})

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
    await vi.advanceTimersByTimeAsync(1000)
    const request = f.sent.find((message) => message.actionId === 'main-issued')!
    f.receive({ kind: 'result', id: request.id, ok: true, value: 'completed' })
    await expect(mutation).resolves.toBe('completed')
    expect(action.signal.aborted).toBe(false)
    action.dispose()
  } finally {
    f.client.dispose()
  }
})

it('retains a submitted human invocation through D4 view selection but refuses hidden or not-yet-submitted work', async () => {
  vi.useFakeTimers()
  const f = fixture()
  try {
    f.receive({ kind: 'context', context: { visible: true } })
    const invocation = f.client.request('actions.invoke', { action: 'initialize-library' })
    await vi.advanceTimersByTimeAsync(0)
    const submitted = f.sent[0]!
    const queued = f.client.request('actions.invoke', { action: 'add-copy' })
    const queuedRejection = expect(queued).rejects.toThrow(/hidden/)
    f.receive({ kind: 'context', context: { visible: false } })
    await queuedRejection
    await expect(f.client.request('actions.invoke')).rejects.toThrow(/hidden/)
    await expect(f.client.request('source.read')).rejects.toThrow(/hidden/)
    expect(f.sent).not.toContainEqual({ kind: 'cancel', id: submitted.id })
    f.receive({ kind: 'result', id: submitted.id, ok: true, value: { outcome: 'verified' } })
    await expect(invocation).resolves.toMatchObject({ outcome: 'verified' })
    expect(f.sent.filter((message) => message.kind === 'request')).toHaveLength(1)
  } finally {
    f.client.dispose()
  }
})

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

it.each(['action-cancelled', 'revoked'])('rejects late paced completion and releases timers on %s', async (kind) => {
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
})
