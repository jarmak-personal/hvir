import type { WebFrameMain } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  NATIVE_TERMINAL_PRESENTATION as channels,
  type NativeTerminalViewGrant,
} from '../src/shared/native-terminal-presentation'
import { NativeTerminalPresentationTargets } from '../src/main/terminal/native-terminal-presentation-target'

function fixture() {
  const owner = new NativeTerminalPresentationTargets()
  let current = true
  let dead = false
  const messages: { ticket: string }[] = []
  const send = vi.fn((_channel: string, value: unknown) => {
    if (
      value &&
      typeof value === 'object' &&
      'ticket' in value &&
      typeof value.ticket === 'string'
    )
      messages.push({ ticket: value.ticket })
  })
  const frame = { isDestroyed: () => dead, send } as unknown as WebFrameMain
  const target = owner.create(
    frame,
    () => current,
    () => true,
  )
  const grant = {
    viewId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    nativeEpoch: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    attachment: 1,
    geometrySerial: 1,
    width: 64,
    height: 32,
    backingScale: 1,
  }
  const pixels = {
    nativeTerminal: grant,
    screen: 0 as const,
    colorSpace: 1,
    origin: 1,
    premultiplied: false as const,
    stride: 256,
    bytes: new Uint8Array(8192),
  }
  const ack = (ticket: string, sender = frame, accepted = true) =>
    owner.acknowledge(sender, { kind: 'pixels', ticket, accepted })
  target.publishGrant(grant)
  return {
    owner,
    frame,
    send,
    target,
    grant,
    pixels,
    messages,
    ack,
    destroy: () => {
      dead = true
    },
    revoke: () => {
      current = false
    },
  }
}
afterEach(() => vi.useRealTimers())
describe('private native presentation Electron target', () => {
  it('requires a current matching successful-draw receipt and revokes it with geometry', () => {
    const f = fixture()
    f.target.publishGrant(f.grant)
    const ack = { kind: 'drawn', grant: f.grant, screen: 0 }
    expect(f.owner.drawn(f.grant.viewId, f.frame)).toBeUndefined()
    f.owner.acknowledge({} as WebFrameMain, ack)
    expect(f.owner.drawn(f.grant.viewId, f.frame)).toBeUndefined()
    f.owner.acknowledge(f.frame, ack)
    expect(f.owner.drawn(f.grant.viewId, f.frame)).toEqual({
      screen: 0,
      geometrySerial: 1,
      nativeEpoch: f.grant.nativeEpoch,
      attachment: f.grant.attachment,
    })
    f.target.publishGrant({ ...f.grant, geometrySerial: 2 })
    f.owner.acknowledge(f.frame, ack)
    expect(f.owner.drawn(f.grant.viewId, f.frame)).toBeUndefined()
    f.owner.acknowledge(f.frame, {
      ...ack,
      grant: { ...f.grant, geometrySerial: 2 },
      screen: 1,
    })
    expect(f.owner.drawn(f.grant.viewId, f.frame)?.screen).toBe(1)
    f.revoke()
    expect(f.owner.drawn(f.grant.viewId, f.frame)).toBeUndefined()
  })
  it('requires the actual recipient frame and current authority for pixel acknowledgements', async () => {
    const f = fixture()
    const uploaded = f.target.sendPixels(f.pixels)
    let settled = false
    void uploaded.then(() => {
      settled = true
    })
    const ticket = f.messages[0]!.ticket
    f.ack(ticket, {} as WebFrameMain)
    await Promise.resolve()
    expect(settled).toBe(false)
    f.ack(ticket)
    await uploaded
    expect(settled).toBe(true)
    f.owner.dispose()
  })
  it('bounds global uploads and recovers credit only after settlement', async () => {
    const f = fixture()
    const pending = Array.from({ length: 3 }, () => f.target.sendPixels(f.pixels))
    await expect(f.target.sendPixels(f.pixels)).rejects.toThrow('bound')
    f.ack(f.messages[0]!.ticket)
    await pending[0]
    const fourth = f.target.sendPixels(f.pixels)
    for (const message of f.messages.slice(1)) f.ack(message.ticket)
    await Promise.all([...pending, fourth])
    f.owner.dispose()
  })
  it('fails closed after revocation, receiver refusal, deadline, or owner disposal', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const timed = f.target.sendPixels(f.pixels)
    const timedAssertion = expect(timed).rejects.toThrow('timeout')
    await vi.advanceTimersByTimeAsync(5000)
    await timedAssertion
    const rejected = f.target.sendPixels(f.pixels)
    f.ack(f.messages.at(-1)!.ticket, f.frame, false)
    await expect(rejected).rejects.toThrow('rejected')
    const closed = f.target.sendPixels(f.pixels)
    f.owner.dispose()
    await expect(closed).rejects.toThrow('closed')
    const g = fixture()
    const revoked = g.target.sendPixels(g.pixels)
    g.revoke()
    g.ack(g.messages[0]!.ticket)
    await expect(revoked).rejects.toThrow('rejected')
    await expect(g.target.sendPixels(g.pixels)).rejects.toThrow('stale')
    g.owner.dispose()
  })
})

it('latches renderer failure only for the actual frame and exact currently granted view', async () => {
  const f = fixture()
  f.target.publishGrant(f.grant)
  f.owner.acknowledge(f.frame, { kind: 'renderer-failure', grant: f.grant })
  expect(f.target.isCurrent()).toBe(false)
  await expect(f.target.sendPixels(f.pixels)).rejects.toThrow('stale')
  f.target.publishGrant(undefined)
  expect(f.send).toHaveBeenLastCalledWith(channels.grantChannel, {
    viewId: f.grant.viewId,
    grant: undefined,
  })
  f.owner.dispose()
})
it.each<Partial<NativeTerminalViewGrant>>([
  { viewId: 'cccccccc-cccc-cccc-cccc-cccccccccccc' },
  { nativeEpoch: 'dddddddd-dddd-dddd-dddd-dddddddddddd' },
  { attachment: 2 },
  { geometrySerial: 2 },
  { width: 128 },
  { height: 64 },
  { backingScale: 2 },
])('ignores stale renderer failure grant %j', (changes) => {
  const f = fixture()
  f.target.publishGrant(f.grant)
  f.owner.acknowledge(f.frame, {
    kind: 'renderer-failure',
    grant: { ...f.grant, ...changes },
  })
  expect(f.target.isCurrent()).toBe(true)
  f.owner.dispose()
})
it('ignores spoofed frames and revoked grants without poisoning the current target', () => {
  const f = fixture()
  f.target.publishGrant(f.grant)
  f.owner.acknowledge({} as WebFrameMain, { kind: 'renderer-failure', grant: f.grant })
  expect(f.target.isCurrent()).toBe(true)
  f.target.publishGrant(undefined)
  f.owner.acknowledge(f.frame, { kind: 'renderer-failure', grant: f.grant })
  expect(f.target.isCurrent()).toBe(true)
  f.owner.dispose()
})
it('delivers revocation after authority becomes stale while rejecting new status and pixel work', async () => {
  const f = fixture()
  f.target.publishGrant(f.grant)
  f.revoke()
  f.target.publishGrant(undefined)
  expect(f.send).toHaveBeenLastCalledWith(channels.grantChannel, {
    viewId: f.grant.viewId,
    grant: undefined,
  })
  expect(() =>
    f.target.publishStatus({ viewId: f.grant.viewId, mode: 'native-gpu' }),
  ).toThrow('stale')
  await expect(f.target.sendPixels(f.pixels)).rejects.toThrow('stale')
  f.owner.dispose()
})
it('drops destroyed-target grant cleanup and rejects its pending upload without sending again', async () => {
  const f = fixture()
  f.target.publishGrant(f.grant)
  const uploaded = f.target.sendPixels(f.pixels)
  const ticket = f.messages.at(-1)!.ticket
  const before = f.send.mock.calls.length
  f.destroy()
  expect(() => f.target.publishGrant(undefined)).not.toThrow()
  expect(f.send).toHaveBeenCalledTimes(before)
  f.owner.acknowledge(f.frame, { kind: 'renderer-failure', grant: f.grant })
  f.ack(ticket)
  await expect(uploaded).rejects.toThrow('rejected')
  expect(f.target.isCurrent()).toBe(false)
  f.owner.dispose()
})
it('notifies its one bound attachment only for qualified loss and permits unavailable cleanup notification', () => {
  const f = fixture()
  const lost = vi.fn(() => {
    expect(f.target.isCurrent()).toBe(false)
  })
  const unbind = f.target.onUnavailable(lost)
  expect(() => f.target.onUnavailable(vi.fn())).toThrow('already-bound')
  f.target.publishGrant(f.grant)
  f.owner.acknowledge(f.frame, {
    kind: 'renderer-failure',
    grant: { ...f.grant, geometrySerial: 0 },
  })
  expect(lost).not.toHaveBeenCalled()
  f.owner.acknowledge(f.frame, { kind: 'renderer-failure', grant: f.grant })
  expect(lost).toHaveBeenCalledExactlyOnceWith(f.grant)
  f.target.publishStatus({
    viewId: f.grant.viewId,
    mode: 'unavailable',
    reason: 'renderer-lost',
  })
  expect(f.send).toHaveBeenLastCalledWith(channels.statusChannel, {
    viewId: f.grant.viewId,
    mode: 'unavailable',
    reason: 'renderer-lost',
  })
  unbind()
  unbind()
  f.owner.acknowledge(f.frame, { kind: 'renderer-failure', grant: f.grant })
  expect(lost).toHaveBeenCalledOnce()
  f.owner.dispose()
})

it('forwards a refit identity while immediately withdrawing draw and failure acknowledgement authority', () => {
  const f = fixture()
  f.target.publishGrant(f.grant)
  const refit = { attachment: f.grant.attachment, nativeEpoch: f.grant.nativeEpoch }
  f.target.publishGrant(undefined, refit)
  expect(f.send).toHaveBeenLastCalledWith(channels.grantChannel, {
    viewId: f.grant.viewId,
    grant: undefined,
    refit,
  })
  expect(f.owner.drawn(f.grant.viewId, f.frame)).toBeUndefined()
  f.owner.acknowledge(f.frame, { kind: 'drawn', grant: f.grant, screen: 0 })
  f.owner.acknowledge(f.frame, { kind: 'renderer-failure', grant: f.grant })
  expect(f.owner.drawn(f.grant.viewId, f.frame)).toBeUndefined()
  expect(f.target.isCurrent()).toBe(true)
  const next = { ...f.grant, geometrySerial: 2 }
  f.target.publishGrant(next)
  f.owner.acknowledge(f.frame, { kind: 'renderer-failure', grant: next })
  expect(f.target.isCurrent()).toBe(false)
  f.target.publishGrant(undefined)
  expect(f.send).toHaveBeenLastCalledWith(channels.grantChannel, {
    viewId: f.grant.viewId,
    grant: undefined,
  })
  f.owner.dispose()
})

it('reserves the same three upload slots before any copied payload is sent', () => {
  const f = fixture(),
    slots = Array.from({ length: 3 }, () => f.target.reservePixels(f.grant))
  expect(f.messages).toHaveLength(0)
  expect(() => f.target.reservePixels(f.grant)).toThrow('bound')
  slots[0]!.cancel()
  slots[0]!.cancel()
  const replacement = f.target.reservePixels(f.grant)
  for (const slot of slots) slot.cancel()
  replacement.cancel()
  f.owner.dispose()
})
it('starts the unchanged ACK deadline at send, not while a copy owns its reservation', async () => {
  vi.useFakeTimers()
  const f = fixture(),
    slot = f.target.reservePixels(f.grant)
  await vi.advanceTimersByTimeAsync(6000)
  const sent = slot.send(f.pixels),
    rejected = expect(sent).rejects.toThrow('timeout')
  await vi.advanceTimersByTimeAsync(5000)
  await rejected
  const next = f.target.reservePixels(f.grant)
  next.cancel()
  f.owner.dispose()
})
it('settles an unspent reservation after withdrawal or disposal without publishing stale pixels', async () => {
  const f = fixture(),
    slot = f.target.reservePixels(f.grant)
  f.target.publishGrant(undefined)
  await expect(slot.send(f.pixels)).rejects.toThrow('stale')
  expect(f.messages).toHaveLength(0)
  f.target.publishGrant(f.grant)
  const closed = f.target.reservePixels(f.grant)
  f.owner.dispose()
  await expect(closed.send(f.pixels)).rejects.toThrow('closed')
})
it('rejects malformed exact-layout payloads and returns reservation credit', async () => {
  const f = fixture()
  for (const change of [
    { stride: 260 },
    { bytes: new Uint8Array(8191) },
    { bytes: new Uint8Array(new SharedArrayBuffer(8192)) },
  ]) {
    const slot = f.target.reservePixels(f.grant)
    await expect(slot.send({ ...f.pixels, ...change })).rejects.toThrow('bound')
  }
  const slots = Array.from({ length: 3 }, () => f.target.reservePixels(f.grant))
  for (const slot of slots) slot.cancel()
  f.owner.dispose()
})
