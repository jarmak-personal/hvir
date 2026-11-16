import { describe, expect, it, vi } from 'vitest'
import { NativeTerminalPresentationReceiver } from '../src/preload/native-terminal-presentation'

function fixture() {
  const grant = {
    viewId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    nativeEpoch: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    attachment: 1,
    geometrySerial: 1,
    width: 64,
    height: 32,
    backingScale: 1,
  }
  const canvas = { draw: vi.fn(), pixels: vi.fn(), dispose: vi.fn() }
  const lost: (() => void)[] = []
  const create = vi.fn((_element: string, callback: () => void) => {
    lost.push(callback)
    return canvas
  })
  const failed = vi.fn()
  const drawn = vi.fn()
  const receiver = new NativeTerminalPresentationReceiver(create, failed, drawn)
  const frame = { close: vi.fn() }
  const texture = { getVideoFrame: vi.fn(() => frame), release: vi.fn() }
  const metadata = (serial = 1) => ({
    nativeTerminal: { ...grant, geometrySerial: serial },
    screen: 0 as const,
    origin: 1,
    colorSpace: 1,
  })
  const issue = (serial: number) =>
    receiver.grant({ viewId: grant.viewId, grant: metadata(serial).nativeTerminal })
  receiver.mount(grant.viewId, 'terminal')
  issue(1)
  return {
    receiver,
    grant,
    canvas,
    lost,
    create,
    failed,
    drawn,
    frame,
    texture,
    metadata,
    issue,
  }
}

describe('local native presentation eligibility', () => {
  it('distinguishes an exact locally withdrawn pixel upload from malformed or genuinely failed uploads', () => {
    const f = fixture()
    const pixels = {
      ...f.metadata(),
      bytes: new Uint8Array(64 * 32 * 4),
      stride: 64 * 4,
      premultiplied: false as const,
    }
    f.receiver.setEligible(f.grant.viewId, false)
    expect(f.receiver.pixels(pixels)).toBe('local-ineligible')
    expect(f.receiver.pixels({ ...pixels, bytes: new Uint8Array(1) })).toBe(false)
    expect(
      f.receiver.pixels({ ...pixels, nativeTerminal: { ...f.grant, geometrySerial: 2 } }),
    ).toBe(false)
    expect(f.canvas.pixels).not.toHaveBeenCalled()
    expect(f.drawn).not.toHaveBeenCalled()
    f.receiver.setEligible(f.grant.viewId, true)
    f.issue(2)
    f.receiver.receive(f.texture, f.metadata(2))
    f.lost.at(-1)!()
    f.receiver.setEligible(f.grant.viewId, false)
    expect(f.receiver.pixels({ ...pixels, ...f.metadata(2) })).toBe(false)
  })

  it('withdraws a queued frame before DOM detachment and requires a newer main grant', () => {
    const f = fixture()
    f.receiver.receive(f.texture, f.metadata())
    f.receiver.setEligible(f.grant.viewId, false)
    f.receiver.receive(f.texture, f.metadata())
    f.issue(2) // An already queued main grant while the target is hidden.
    f.receiver.setEligible(f.grant.viewId, true)
    f.receiver.receive(f.texture, f.metadata(2))
    f.issue(2)
    f.receiver.receive(f.texture, f.metadata(2))
    expect(f.canvas.draw).toHaveBeenCalledOnce()
    expect(f.texture.release).toHaveBeenCalledTimes(4)
    expect(f.canvas.dispose).toHaveBeenCalledOnce()
    f.issue(3)
    f.receiver.receive(f.texture, f.metadata(3))
    f.lost[0]!() // Callback from the disposed binding cannot revoke replacement.
    expect(f.canvas.draw).toHaveBeenCalledTimes(2)
    expect(f.failed).not.toHaveBeenCalled()
  })

  it('closes an acquired frame when hide races frame acquisition without acknowledging draw', () => {
    const f = fixture()
    f.texture.getVideoFrame.mockImplementation(() => {
      f.receiver.setEligible(f.grant.viewId, false)
      return f.frame
    })
    f.receiver.receive(f.texture, f.metadata())
    expect(f.frame.close).toHaveBeenCalledOnce()
    expect(f.texture.release).toHaveBeenCalledOnce()
    expect(f.canvas.draw).not.toHaveBeenCalled()
    expect(f.drawn).not.toHaveBeenCalled()
    expect(f.failed).not.toHaveBeenCalled()
  })

  it('cannot clear genuine loss or accept a factory completing after withdrawal', () => {
    const f = fixture()
    f.create.mockImplementationOnce(() => {
      f.receiver.setEligible(f.grant.viewId, false)
      return f.canvas
    })
    f.receiver.receive(f.texture, f.metadata())
    expect(f.canvas.dispose).toHaveBeenCalledOnce()
    expect(f.canvas.draw).not.toHaveBeenCalled()
    f.receiver.setEligible(f.grant.viewId, true)
    f.issue(2)
    f.receiver.receive(f.texture, f.metadata(2))
    f.lost.at(-1)!()
    f.receiver.setEligible(f.grant.viewId, false)
    f.receiver.setEligible(f.grant.viewId, true)
    f.issue(3)
    f.receiver.receive(f.texture, f.metadata(3))
    expect(f.canvas.draw).toHaveBeenCalledOnce()
    expect(f.failed).toHaveBeenCalledTimes(2)
  })
})
