import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_EXTENSION_PRESENTATION } from '../src/main/extensions/guest-owner'
import { EXTENSION_LIMITS } from '../src/shared/extensions/contract'
import { extensionRequestDeadline } from '../src/shared/extensions/request-deadline'
import type { ExtensionDeliveryResult } from '../src/shared/extensions/managed-delivery'
import { attached, fixture } from './fixtures/extension-guest'

afterEach(() => vi.useRealTimers())

const deadlineError =
  'Extension request timed out; completion was not confirmed. Check the outcome before retrying.'

function pendingWork<T = unknown>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function results(data: ReturnType<typeof fixture>, id: string) {
  return data.sent.flatMap(({ message }) =>
    message.kind === 'result' && message.id === id ? [message] : [],
  )
}

async function readingGuest(operation: 'select' | 'render' = 'select') {
  vi.useFakeTimers()
  const data = fixture(
    {},
    {
      requiredCapabilities: ['presentation.read', 'source.select', 'source.render'],
    },
  )
  const work = pendingWork()
  const source = vi.spyOn(data.ports.sources, operation).mockReturnValue(work.promise)
  const view = await attached(data)
  data.owner.receive(10, { kind: 'hello', contract: '1.0' })
  const request = (id: string) =>
    data.owner.receive(10, {
      kind: 'request',
      id,
      capability: `source.${operation}`,
      input: {},
    })
  return { data, view, work, source, request }
}

describe('correlated guest request deadlines', () => {
  it.each([
    ['select', 'success'],
    ['select', 'failure'],
    ['render', 'success'],
    ['render', 'failure'],
  ] as const)(
    'settles slow source.%s once and rejects late %s',
    async (operation, late) => {
      const f = await readingGuest(operation)
      try {
        f.request('slow-source')
        await vi.advanceTimersByTimeAsync(0)
        expect(f.source).toHaveBeenCalledOnce()
        const caller = f.source.mock.calls[0]![0]
        await vi.advanceTimersByTimeAsync(EXTENSION_LIMITS.requestTimeoutMs - 1)
        expect(results(f.data, 'slow-source')).toEqual([])
        expect(caller.signal.aborted).toBe(false)
        await vi.advanceTimersByTimeAsync(1)
        expect(caller.signal.aborted).toBe(true)
        expect(results(f.data, 'slow-source')).toEqual([
          {
            kind: 'result',
            id: 'slow-source',
            ok: false,
            error: deadlineError,
            warnings: [],
          },
        ])
        expect(f.data.owner.snapshot(f.data.renderer)).toEqual([f.view])
        if (late === 'success') f.work.resolve({ receipt: 'late-source' })
        else f.work.reject(new Error('Late host failure must not replace the deadline'))
        await vi.advanceTimersByTimeAsync(EXTENSION_LIMITS.requestTimeoutMs)
        expect(results(f.data, 'slow-source')).toHaveLength(1)
        f.data.owner.receive(10, {
          kind: 'request',
          id: 'still-usable',
          capability: 'presentation.read',
        })
        await vi.advanceTimersByTimeAsync(0)
        expect(results(f.data, 'still-usable')).toMatchObject([{ ok: true }])
      } finally {
        f.work.resolve(null)
        await f.data.owner.dispose()
      }
    },
  )

  it.each([
    'cancel',
    'close',
    'disable',
    'renderer-replacement',
    'activation-replacement',
  ] as const)('does not publish a deadline or late result after %s', async (ending) => {
    const f = await readingGuest()
    try {
      f.request('ended')
      await vi.advanceTimersByTimeAsync(0)
      if (ending === 'cancel') f.data.owner.receive(10, { kind: 'cancel', id: 'ended' })
      else if (ending === 'close') await f.data.owner.close(f.data.renderer, f.view.id)
      else if (ending === 'disable') f.data.owner.revokeInstallation('installation')
      else if (ending === 'renderer-replacement') {
        await f.data.scopes.revokeOwner(f.data.renderer.id)
        f.data.scopes.activateOwner(f.data.renderer.id)
      }
      else
        f.data.active.set('installation', {
          ...f.data.active.get('installation')!,
          generation: 'new',
        })
      await vi.advanceTimersByTimeAsync(EXTENSION_LIMITS.requestTimeoutMs)
      expect(f.source.mock.calls[0]![0].signal.aborted).toBe(true)
      expect(results(f.data, 'ended')).toEqual([])
      f.work.resolve({ receipt: 'late-source' })
      await vi.advanceTimersByTimeAsync(0)
      expect(results(f.data, 'ended')).toEqual([])
    } finally {
      f.work.resolve(null)
      await f.data.owner.dispose()
    }
  })

  it('retains view and extension capacity after timeout until physical work settles', async () => {
    const f = await readingGuest()
    try {
      for (const [contribution, guest] of [
        ['detail', 11],
        ['reference', 12],
      ] as const) {
        const renderer = guest === 12 ? f.data.scopes.activateOwner(2) : f.data.renderer
        const view = await f.data.owner.open(renderer, 'installation', contribution)
        f.data.owner.claim(renderer, view.partition, view.url, view.id)
        f.data.owner.bind(renderer, view.partition, guest)
        f.data.owner.presentation(
          renderer,
          view.id,
          DEFAULT_EXTENSION_PRESENTATION,
          true,
          true,
        )
        f.data.owner.receive(guest, { kind: 'hello', contract: '1.0' })
      }
      for (const guest of [10, 11])
        for (let index = 0; index < EXTENSION_LIMITS.requestsPerView; index++)
          f.data.owner.receive(guest, {
            kind: 'request',
            id: `pending-${guest}-${index}`,
            capability: 'source.select',
            input: {},
          })
      await vi.advanceTimersByTimeAsync(EXTENSION_LIMITS.requestTimeoutMs)
      expect(f.source).toHaveBeenCalledTimes(EXTENSION_LIMITS.requestsPerExtension)
      expect(f.data.sent.filter(({ message }) => message.kind === 'result')).toHaveLength(
        16,
      )
      for (const [guest, id] of [
        [10, 'view-full'],
        [12, 'extension-full'],
      ] as const)
        f.data.owner.receive(guest, {
          kind: 'request',
          id,
          capability: 'presentation.read',
        })
      for (const id of ['view-full', 'extension-full'])
        expect(results(f.data, id)).toMatchObject([
          { ok: false, error: 'Extension request capacity is full' },
        ])
      f.work.resolve({ receipt: 'late-source' })
      await vi.advanceTimersByTimeAsync(0)
      for (const guest of [10, 12])
        f.data.owner.receive(guest, {
          kind: 'request',
          id: `available-${guest}`,
          capability: 'presentation.read',
        })
      await vi.advanceTimersByTimeAsync(0)
      for (const guest of [10, 12])
        expect(results(f.data, `available-${guest}`)).toMatchObject([{ ok: true }])
      expect(results(f.data, 'pending-10-0')).toHaveLength(1)
    } finally {
      f.work.resolve(null)
      await f.data.owner.dispose()
    }
  })

  it('keeps the longer mutation deadline and reports unconfirmed completion without replay', async () => {
    vi.useFakeTimers()
    const data = fixture({}, { requiredCapabilities: ['delivery.apply'] })
    const work = pendingWork<ExtensionDeliveryResult>()
    const apply = vi.spyOn(data.ports.deliveries, 'apply').mockReturnValue(work.promise)
    await attached(data)
    data.owner.receive(10, { kind: 'hello', contract: '1.0' })
    try {
      data.owner.receive(10, {
        kind: 'request',
        id: 'mutation',
        capability: 'delivery.apply',
        input: {},
      })
      await vi.advanceTimersByTimeAsync(EXTENSION_LIMITS.requestTimeoutMs)
      expect(apply).toHaveBeenCalledOnce()
      expect(results(data, 'mutation')).toEqual([])
      await vi.advanceTimersByTimeAsync(
        extensionRequestDeadline('delivery.apply') - EXTENSION_LIMITS.requestTimeoutMs,
      )
      expect(results(data, 'mutation')).toMatchObject([
        {
          ok: false,
          error: deadlineError,
        },
      ])
      expect(apply.mock.calls[0]![0].signal.aborted).toBe(true)
      work.resolve({ outcome: 'completed', operation: 'late-mutation' })
      await vi.advanceTimersByTimeAsync(extensionRequestDeadline('delivery.apply'))
      expect(results(data, 'mutation')).toHaveLength(1)
      expect(apply).toHaveBeenCalledOnce()
    } finally {
      work.resolve({ outcome: 'uncertain' })
      await data.owner.dispose()
    }
  })
})
