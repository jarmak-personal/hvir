import { describe, expect, it, vi } from 'vitest'
import { localPath } from '../src/shared/host-path'
import type { NativeTerminalHost } from '../src/main/terminal/native-terminal-host'
import {
  NativeTerminalQueryRequestOwner,
  type NativeTerminalQuerySource,
} from '../src/main/terminal/native-terminal-query-request'
import { NATIVE_TERMINAL_LIMITS } from '../src/shared/native-terminal'
import type { NativeTerminalQueryOperation } from '../src/shared/native-terminal-query-operations'

const session = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  instanceId: '22222222-2222-4222-8222-222222222222',
  ownerId: 1,
  ownerGeneration: 1,
  workspaceRoot: localPath('/tmp/native-query-request'),
}
const context = { screen: 0 as const, geometrySerial: 3 }
function source(current: () => void = () => {}): NativeTerminalQuerySource {
  return {
    handle: 'physical-surface',
    session,
    viewId: '33333333-3333-4333-8333-333333333333',
    assertCurrent: current,
    context: () => Promise.resolve(context),
    prefix: () => ({ parsed: () => Promise.resolve(), replies: () => Promise.resolve() }),
  }
}
function host(query: NativeTerminalHost['query']) {
  return { query, inspectProducer: vi.fn<NativeTerminalHost['inspectProducer']>() }
}

describe('retained request physical ownership', () => {
  const acquiring: NativeTerminalQueryOperation[] = [
    { kind: 'resolve-begin', query: '71', occurrence: '9', reveal: false, context },
    {
      kind: 'range-begin',
      source: { kind: 'match', query: '71', occurrence: '9' },
      context,
    },
    { kind: 'boundary-resolve-begin', boundary: '9', reveal: false, context },
  ]
  it.each(acquiring)(
    'admits $kind after the physical cursor becomes available',
    async (operation) => {
      let attempts = 0
      const query = vi.fn<NativeTerminalHost['query']>((_handle, _instance, op) => {
        if (op.kind === 'close') return Promise.resolve({ result: 0 })
        attempts++
        return Promise.resolve(
          attempts === 1 ? { unavailable: 6, stale: false } : { cursor: '82' },
        )
      })
      const request = new NativeTerminalQueryRequestOwner(host(query), source())
      await expect(request.call(operation)).resolves.toEqual({ cursor: '82' })
      await request.close()
      expect(attempts).toBe(2)
      expect(query.mock.calls.at(-1)?.[2]).toEqual({ kind: 'close', cursor: '82' })
    },
  )

  it.each([
    [
      { kind: 'next', cursor: '82' },
      { unavailable: 6, stale: false },
    ],
    [
      { kind: 'finish', cursor: '82' },
      { unavailable: 6, stale: false },
    ],
    [acquiring[0]!, { unavailable: 6, stale: true }],
    [acquiring[0]!, { unavailable: 7, stale: false }],
    [acquiring[0]!, { unavailable: 6, stale: false, cursor: '82' }],
  ] as const)(
    'does not replay a refusal or an already acquired token (%j)',
    async (operation, value) => {
      const query = vi.fn<NativeTerminalHost['query']>((_handle, _instance, op) =>
        Promise.resolve(op.kind === 'close' ? { result: 0 } : value),
      )
      const request = new NativeTerminalQueryRequestOwner(host(query), source())
      await expect(request.call(operation)).resolves.toEqual(value)
      expect(query).toHaveBeenCalledOnce()
      await request.close()
      if ('cursor' in value)
        expect(query.mock.calls.at(-1)?.[2]).toEqual({ kind: 'close', cursor: '82' })
    },
  )

  it('uses the existing acquisition deadline rather than restarting it after BUSY', async () => {
    let now = 0
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const busy = { unavailable: 6, stale: false }
    const query = vi.fn<NativeTerminalHost['query']>(() => {
      now = NATIVE_TERMINAL_LIMITS.requestMs
      return Promise.resolve(busy)
    })
    const request = new NativeTerminalQueryRequestOwner(host(query), source())
    try {
      await expect(request.call(acquiring[0]!)).resolves.toEqual(busy)
      expect(query).toHaveBeenCalledOnce()
      await request.close()
    } finally {
      clock.mockRestore()
    }
  })

  it('cancels a waiting acquisition without posting another native attempt', async () => {
    let release!: (value: unknown) => void
    const query = vi.fn<NativeTerminalHost['query']>(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const request = new NativeTerminalQueryRequestOwner(host(query), source())
    const pending = request.call(acquiring[0]!)
    const rejected = expect(pending).rejects.toThrow()
    request.abort.abort()
    release({ unavailable: 6, stale: false })
    await rejected
    await request.close()
    expect(query).toHaveBeenCalledOnce()
  })

  it.each([
    [6, false, true],
    [6, true, false],
    [7, false, false],
  ] as const)(
    'cleans a late acquired query after cancellation, replaying only BUSY (%s/stale=%s)',
    async (code, stale, retries) => {
      let acquired!: (value: unknown) => void
      let closes = 0
      const query = vi.fn<NativeTerminalHost['query']>((_handle, _instance, op) => {
        if (op.kind === 'query-begin')
          return new Promise((resolve) => {
            acquired = resolve
          })
        if (op.kind !== 'query-close' || op.query !== '71')
          throw new Error('Unexpected cleanup')
        closes++
        return Promise.resolve(
          closes === 1 ? { unavailable: code, stale } : { result: 0 },
        )
      })
      const request = new NativeTerminalQueryRequestOwner(host(query), source())
      const pending = request.call({
        kind: 'query-begin',
        text: 'hit',
        caseSensitive: false,
      })
      request.abort.abort()
      acquired({ query: '71' })
      await expect(pending).rejects.toThrow()
      if (retries) await expect(request.close()).resolves.toBeUndefined()
      else await expect(request.close()).rejects.toMatchObject({ code, stale })
      expect(closes).toBe(retries ? 2 : 1)
      expect(query.mock.calls.at(-1)?.slice(0, 2)).toEqual([
        'physical-surface',
        session.instanceId,
      ])
    },
  )
  it('transfers an acquisition only to the owner that accepted its exact token', async () => {
    const query = vi.fn<NativeTerminalHost['query']>().mockResolvedValue({ query: '71' })
    const request = new NativeTerminalQueryRequestOwner(host(query), source())
    await request.call({ kind: 'query-begin', text: 'alpha', caseSensitive: false })
    expect(() => request.transferAcquisition('query-close', '72')).toThrow(
      'acquisition-mismatch',
    )
    request.transferAcquisition('query-close', '71')
    await request.close()
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('never returns collected text after a failed Finish and does not close a definitively finished cursor twice', async () => {
    const query = vi.fn<NativeTerminalHost['query']>((_handle, _instance, operation) => {
      if (operation.kind === 'range-begin') return Promise.resolve({ cursor: '82' })
      if (operation.kind === 'next')
        return Promise.resolve({
          cursor: '82',
          selectionSerial: 1,
          data: new TextEncoder().encode('alpha'),
          done: true,
          work: 10,
          visited: 5,
        })
      if (operation.kind === 'finish')
        return Promise.resolve({ unavailable: 6, stale: true })
      return Promise.resolve({ result: 0 })
    })
    const request = new NativeTerminalQueryRequestOwner(host(query), source())
    await request.call({
      kind: 'range-begin',
      source: { kind: 'match', query: '71', occurrence: '9' },
      context,
    })
    await expect(request.collect()).rejects.toThrow('native-selection-stale')
    await request.close()
    expect(query.mock.calls.some(([, , op]) => op.kind === 'close')).toBe(false)
  })
})
