import { describe, expect, it, vi } from 'vitest'
import { localPath } from '../src/shared/host-path'
import type { NativeTerminalHost } from '../src/main/terminal/native-terminal-host'
import {
  NativeTerminalQueryRequestOwner,
  type NativeTerminalQuerySource,
} from '../src/main/terminal/native-terminal-query-request'
import { NativeTerminalQueryBoundaries } from '../src/main/terminal/native-terminal-query-boundaries'
import { NativeTerminalQuery } from '../src/main/terminal/native-terminal-query'
import { NATIVE_TERMINAL_LIMITS } from '../src/shared/native-terminal'
import type { NativeTerminalQueryOperation } from '../src/shared/native-terminal-query-operations'
import type { NativeTerminalEffectBatch } from '../src/shared/native-terminal-effects'

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
  it('retires an accepted registry handle if its logical delivery is then revoked', async () => {
    const viewId = '33333333-3333-4333-8333-333333333333'
    const nextView = '44444444-4444-4444-8444-444444444444'
    let valid = true
    let accepted = ''
    const original = Object.getOwnPropertyDescriptor(
      NativeTerminalQueryBoundaries.prototype,
      'capture',
    )?.value as NativeTerminalQueryBoundaries['capture']
    const admitted = vi
      .spyOn(NativeTerminalQueryBoundaries.prototype, 'capture')
      .mockImplementation(function (this: NativeTerminalQueryBoundaries, s, token) {
        return original.call(this, s, token).then((id) => {
          accepted = id
          valid = false // Registry acceptance preceded renderer delivery revocation.
          return id
        })
      })
    const call = vi.fn<NativeTerminalHost['query']>((_handle, _instance, operation) => {
      if (operation.kind === 'boundary-capture')
        return Promise.resolve({ boundary: '999', screen: 0, row: 10, column: 0 })
      if (operation.kind === 'boundary-close') return Promise.resolve({ result: 0 })
      throw new Error(`Unexpected native operation: ${operation.kind}`)
    })
    const queries = new NativeTerminalQuery(
      host(call),
      (id) => ({
        ...source(() => {
          if (id === viewId && !valid) throw new Error('owner-stale')
        }),
        viewId: id,
      }),
      vi.fn(),
      vi.fn(),
    )
    const owner = { id: 1, generation: 1 }
    try {
      await expect(
        queries.action(
          {
            viewId,
            requestId: '55555555-5555-4555-8555-555555555555',
            kind: 'capture-end',
          },
          owner,
        ),
      ).rejects.toThrow('owner-stale')
      expect(
        call.mock.calls.filter(
          ([, , operation]) =>
            operation.kind === 'boundary-close' && operation.boundary === '999',
        ),
      ).toHaveLength(1)
      await expect(
        queries.action(
          {
            viewId: nextView,
            requestId: '66666666-6666-4666-8666-666666666666',
            kind: 'boundary-resolve',
            boundaryId: accepted,
          },
          owner,
        ),
      ).resolves.toEqual({ kind: 'boundary' })
    } finally {
      admitted.mockRestore()
      await queries.dispose()
    }
  })

  it('closes a captured native end when deferred registry admission loses its owner', async () => {
    let owner = 1
    const a = source(() => {
      if (owner !== 1) throw new Error('owner-stale')
    })
    const b = {
      ...source(() => {
        if (owner !== 2) throw new Error('owner-stale')
      }),
      session: { ...session, ownerId: 2 },
    }
    let release!: () => void
    let entered!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const query = vi.fn<NativeTerminalHost['query']>((_handle, _instance, operation) => {
      if (operation.kind === 'boundary-capture')
        return Promise.resolve({ boundary: '999', screen: 0, row: 10, column: 0 })
      if (operation.kind === 'boundary-close' && operation.boundary === '1') {
        entered()
        return held.then(() => ({ result: 0 }))
      }
      return Promise.resolve({ result: 0 })
    })
    const native = host(query)
    const boundaries = new NativeTerminalQueryBoundaries(
      (s, token) =>
        native
          .query(s.handle, s.session.instanceId, {
            kind: 'boundary-close',
            boundary: token,
          })
          .then(() => undefined),
      vi.fn(),
    )
    for (let serial = 1; serial <= 511; serial++) {
      const batch: NativeTerminalEffectBatch = {
        droppedEffects: 0,
        semanticGeneration: 0,
        effects: [
          {
            kind: 'semantic',
            sequence: serial,
            eventSerial: serial,
            action: 1,
            options: '',
            screen: 'normal',
            row: serial,
            column: 0,
            boundary: String(serial),
          },
        ],
      }
      await boundaries.consume(a, batch)
    }
    const request = new NativeTerminalQueryRequestOwner(native, a)
    await request.call({ kind: 'boundary-capture', context })
    const admitting = boundaries.capture(a, '999')
    await started
    owner = 2
    await boundaries.snapshot(b)
    release()
    await expect(admitting).rejects.toThrow('owner-stale')
    await request.close()
    await request.close()
    expect(
      query.mock.calls.filter(
        ([, , op]) => op.kind === 'boundary-close' && op.boundary === '999',
      ),
    ).toHaveLength(1)
    expect(query.mock.calls.at(-1)?.slice(0, 2)).toEqual([
      'physical-surface',
      session.instanceId,
    ])
  })

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
