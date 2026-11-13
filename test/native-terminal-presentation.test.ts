import { describe, expect, it, vi } from 'vitest'
import { NativeTerminalPresentationReceiver } from '../src/preload/native-terminal-presentation'
import type { NativeTerminalViewGrant } from '../src/shared/native-terminal-presentation'

const grant: NativeTerminalViewGrant = {
  viewId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  nativeEpoch: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  attachment: 1,
  geometrySerial: 2,
  width: 64,
  height: 32,
  backingScale: 1,
}
function fixture() {
  const canvas = { draw: vi.fn(), pixels: vi.fn(), dispose: vi.fn() }
  const create = vi.fn((_id: string, _lost: () => void) => canvas)
  const receiver = new NativeTerminalPresentationReceiver(create)
  const frame = { close: vi.fn() }
  const texture = { getVideoFrame: vi.fn(() => frame), release: vi.fn() }
  const metadata = { nativeTerminal: { ...grant }, colorSpace: 1, origin: 1 }
  return { receiver, canvas, create, frame, texture, metadata }
}
describe('isolated native presentation routing', () => {
  it('requires both a local mount and main-issued grant before opening a VideoFrame', () => {
    const f = fixture()
    f.receiver.receive(f.texture, f.metadata)
    f.receiver.mount(grant.viewId, 'retained-terminal')
    f.receiver.receive(f.texture, f.metadata)
    expect(f.texture.getVideoFrame).not.toHaveBeenCalled()
    f.receiver.grant({ viewId: grant.viewId, grant })
    f.receiver.receive(f.texture, f.metadata)
    expect(f.canvas.draw).toHaveBeenCalledWith(f.frame, f.metadata)
    expect(f.frame.close).toHaveBeenCalledOnce()
    expect(f.texture.release).toHaveBeenCalledTimes(3)
  })
  it.each([
    { attachment: 2 },
    { geometrySerial: 1 },
    { geometrySerial: 3 },
    { nativeEpoch: 'cccccccc-cccc-cccc-cccc-cccccccccccc' },
    { backingScale: 2 },
    { width: 128 },
  ])('closes stale delivery instead of drawing %j', (change) => {
    const f = fixture()
    f.receiver.mount(grant.viewId, 'retained-terminal')
    f.receiver.grant({ viewId: grant.viewId, grant })
    f.receiver.receive(f.texture, {
      ...f.metadata,
      nativeTerminal: { ...grant, ...change },
    })
    expect(f.texture.release).toHaveBeenCalledOnce()
    expect(f.texture.getVideoFrame).not.toHaveBeenCalled()
    expect(f.create).not.toHaveBeenCalled()
  })
  it('invalidates old equal-size frames when geometry serial advances', () => {
    const f = fixture()
    f.receiver.mount(grant.viewId, 'retained-terminal')
    f.receiver.grant({ viewId: grant.viewId, grant })
    f.receiver.receive(f.texture, f.metadata)
    f.receiver.grant({ viewId: grant.viewId, grant: { ...grant, geometrySerial: 3 } })
    f.receiver.receive(f.texture, f.metadata)
    expect(f.canvas.draw).toHaveBeenCalledOnce()
    f.receiver.receive(f.texture, {
      ...f.metadata,
      nativeTerminal: { ...grant, geometrySerial: 3 },
    })
    expect(f.canvas.draw).toHaveBeenCalledTimes(2)
  })
  it('multiplexes distinct pane grants without cross-session draws', () => {
    const f = fixture()
    const other = { ...grant, viewId: 'cccccccc-cccc-cccc-cccc-cccccccccccc' }
    f.receiver.mount(grant.viewId, 'workspace')
    f.receiver.mount(other.viewId, 'sessions')
    f.receiver.grant({ viewId: grant.viewId, grant })
    f.receiver.grant({ viewId: other.viewId, grant: other })
    f.receiver.receive(f.texture, f.metadata)
    f.receiver.receive(f.texture, { ...f.metadata, nativeTerminal: other })
    expect(f.create.mock.calls.map(([id]) => id)).toEqual(['workspace', 'sessions'])
  })
  it('releases even when opening, drawing, or closing a frame fails', () => {
    for (const boundary of ['open', 'draw', 'close']) {
      const f = fixture()
      const status = vi.fn()
      f.receiver.onStatus(status)
      f.receiver.mount(grant.viewId, 'pane')
      f.receiver.grant({ viewId: grant.viewId, grant })
      const fail = () => {
        throw new Error('lost')
      }
      if (boundary === 'open') f.texture.getVideoFrame.mockImplementation(fail)
      if (boundary === 'draw') f.canvas.draw.mockImplementation(fail)
      if (boundary === 'close') f.frame.close.mockImplementation(fail)
      if (boundary === 'close')
        expect(() => f.receiver.receive(f.texture, f.metadata)).toThrow()
      else {
        f.receiver.receive(f.texture, f.metadata)
        expect(status).toHaveBeenCalledWith({
          viewId: grant.viewId,
          mode: 'unavailable',
          reason: 'renderer-lost',
        })
      }
      expect(f.texture.release).toHaveBeenCalledOnce()
    }
  })
  it('revokes canvas before late delivery and disposes idempotently', () => {
    const f = fixture()
    f.receiver.mount(grant.viewId, 'pane')
    f.receiver.grant({ viewId: grant.viewId, grant })
    f.receiver.receive(f.texture, f.metadata)
    f.receiver.grant({ viewId: grant.viewId })
    f.receiver.receive(f.texture, f.metadata)
    f.receiver.dispose()
    f.receiver.dispose()
    expect(f.canvas.draw).toHaveBeenCalledOnce()
    expect(f.canvas.dispose).toHaveBeenCalledOnce()
    expect(f.texture.release).toHaveBeenCalledTimes(2)
  })
  it('bounds and validates compatibility bytes, preserving explicit format and origin', () => {
    const f = fixture()
    f.receiver.mount(grant.viewId, 'pane')
    f.receiver.grant({ viewId: grant.viewId, grant })
    const pixels = {
      ...f.metadata,
      bytes: new Uint8Array(64 * 32 * 4),
      stride: 256,
      premultiplied: false as const,
    }
    expect(f.receiver.pixels(pixels)).toBe(true)
    expect(f.canvas.pixels).toHaveBeenCalledWith(pixels)
    expect(f.receiver.pixels({ ...pixels, stride: 1 })).toBe(false)
    expect(f.receiver.pixels({ ...pixels, bytes: new Uint8Array(1) })).toBe(false)
    expect(
      f.receiver.pixels({ ...pixels, nativeTerminal: { ...grant, geometrySerial: 1 } }),
    ).toBe(false)
    expect(f.canvas.pixels).toHaveBeenCalledOnce()
  })
  it('reports context loss only to the routed view', () => {
    let lost!: () => void
    const f = fixture()
    const receiver = new NativeTerminalPresentationReceiver((_id, callback) => {
      lost = callback
      return f.canvas
    })
    const status = vi.fn()
    receiver.onStatus(status)
    receiver.mount(grant.viewId, 'pane')
    receiver.grant({ viewId: grant.viewId, grant })
    receiver.receive(f.texture, f.metadata)
    lost()
    expect(status).toHaveBeenCalledWith({
      viewId: grant.viewId,
      mode: 'unavailable',
      reason: 'renderer-lost',
    })
  })
})
