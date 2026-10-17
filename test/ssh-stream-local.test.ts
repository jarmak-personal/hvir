import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { Client, Channel } from 'ssh2'
import { expect, it, vi } from 'vitest'
import { SshStreamLocalOwner } from '../src/main/project-host/ssh-stream-local'
import {
  SshTransportPool,
  SSH_CONTROL_CHANNEL_BUDGET,
} from '../src/main/project-host/ssh-transport-pool'
import { asHostId, hostPath } from '../src/shared/host-path'

function fixture(delayed = false) {
  const emitter = new EventEmitter(),
    lifecycle = new AbortController(),
    unforward = vi.fn((_path: string, callback: (error?: Error) => void) => callback())
  let reply: ((error?: Error) => void) | undefined
  const client = Object.assign(emitter, {
    openssh_forwardInStreamLocal: vi.fn(
      (_path: string, callback: (error?: Error) => void) => {
        reply = callback
        if (!delayed) callback()
      },
    ),
    openssh_unforwardInStreamLocal: unforward,
  }) as unknown as Client
  const pool = new SshTransportPool({
    connected: () => Promise.resolve(client),
    assertTransportGrowthAllowed: () => undefined,
    openAuxiliaryTransport: () => Promise.reject(new Error('not required')),
    lifecycleSignal: () => lifecycle.signal,
  })
  pool.registerPrimary(client)
  const owner = new SshStreamLocalOwner(pool)
  const binding = owner.binding(asHostId('ssh'), 1, client, () => true)
  return { client, pool, owner, binding, unforward, reply: () => reply!() }
}
it('charges incoming channels to the actual control transport until physical close and contains callback errors', async () => {
  const f = fixture(),
    streams: (PassThrough & { close(): void })[] = [],
    reject = vi.fn()
  const forward = await f.binding.forward(
    hostPath(asHostId('ssh'), '/tmp/a.sock'),
    () => undefined,
  )
  for (let index = 0; index < SSH_CONTROL_CHANNEL_BUDGET + 1; index++) {
    const stream = Object.assign(new PassThrough(), { close: vi.fn() })
    f.client.emit(
      'unix connection',
      { socketPath: '/tmp/a.sock' },
      () => {
        streams.push(stream)
        return stream as unknown as Channel
      },
      reject,
    )
  }
  expect(streams).toHaveLength(SSH_CONTROL_CHANNEL_BUDGET)
  expect(reject).toHaveBeenCalledOnce()
  const disposed = forward.dispose()
  expect(f.pool.diagnostics()[0]?.channels).toBe(SSH_CONTROL_CHANNEL_BUDGET)
  streams.forEach((stream) => stream.emit('close'))
  await disposed
  expect(f.pool.diagnostics()[0]?.channels).toBe(0)
  const broken = await f.binding.forward(hostPath(asHostId('ssh'), '/tmp/b.sock'), () => {
    throw new Error('adapter failed')
  })
  expect(() =>
    f.client.emit(
      'unix connection',
      { socketPath: '/tmp/b.sock' },
      () => {
        throw new Error('accept failed')
      },
      reject,
    ),
  ).not.toThrow()
  const stream = Object.assign(new PassThrough(), { close: vi.fn() })
  expect(() =>
    f.client.emit(
      'unix connection',
      { socketPath: '/tmp/b.sock' },
      () => stream as unknown as Channel,
      reject,
    ),
  ).not.toThrow()
  await broken.dispose()
  f.owner.revoke()
  f.pool.dispose()
})
it('revokes before a delayed successful reply and sends another exact cancellation without restoring the listener', async () => {
  const f = fixture(true),
    accept = vi.fn(),
    starting = f.binding.forward(hostPath(asHostId('ssh'), '/tmp/a.sock'), accept)
  const result = starting.catch((reason: unknown) => reason)
  f.owner.revoke()
  expect(await result).toBeInstanceOf(Error)
  f.reply()
  expect(f.client.listenerCount('unix connection')).toBe(0)
  expect(f.unforward).toHaveBeenCalledTimes(2)
  expect(accept).not.toHaveBeenCalled()
  f.pool.dispose()
})
it('a timeout never admits a late acknowledgment or overlong socket', async () => {
  vi.useFakeTimers()
  try {
    const f = fixture(true),
      starting = f.binding.forward(
        hostPath(asHostId('ssh'), '/tmp/a.sock'),
        () => undefined,
      )
    const failure = starting.catch((reason: unknown) => reason)
    await vi.advanceTimersByTimeAsync(8001)
    expect(await failure).toBeInstanceOf(Error)
    f.reply()
    expect(f.client.listenerCount('unix connection')).toBe(0)
    expect(f.unforward).toHaveBeenCalledTimes(2)
    await expect(
      f.binding.forward(
        hostPath(asHostId('ssh'), '/' + 'x'.repeat(103)),
        () => undefined,
      ),
    ).rejects.toThrow('too long')
    f.pool.dispose()
  } finally {
    vi.useRealTimers()
  }
})

it('host replacement never reuses a trusted forwarded generation', () => {
  const a = fixture(),
    b = fixture()
  expect(a.binding.generation).not.toBe(b.binding.generation)
  a.owner.revoke()
  b.owner.revoke()
  a.pool.dispose()
  b.pool.dispose()
})
