import { describe, expect, it, vi } from 'vitest'
import {
  NativeTerminalPresentationReceiver,
  type NativeTerminalCanvasPort,
} from '../src/preload/native-terminal-presentation'
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
function fixture(retaining = false) {
  const suspend = vi.fn()
  const canvas = {
    draw: vi.fn(),
    pixels: vi.fn(),
    dispose: vi.fn(),
    ...(retaining ? { suspendForRefit: suspend } : {}),
  }
  const create = vi.fn(
    (_id: string, _lost: () => void): NativeTerminalCanvasPort | undefined => canvas,
  )
  const drawn = vi.fn()
  const failed = vi.fn()
  const receiver = new NativeTerminalPresentationReceiver(create, failed, drawn)
  const frame = { close: vi.fn() }
  const texture = { getVideoFrame: vi.fn(() => frame), release: vi.fn() }
  const metadata = {
    nativeTerminal: { ...grant },
    screen: 0 as const,
    colorSpace: 1,
    origin: 1,
  }
  return { receiver, canvas, create, frame, texture, metadata, drawn, failed, suspend }
}
describe('isolated native presentation routing', () => {
  it('preserves frame cleanup when smoke timing fails, including an original close error', () => {
    vi.stubGlobal('__HVIR_SMOKE_BUILD__', true)
    vi.spyOn(performance, 'now').mockImplementationOnce(() => {
      throw new Error('clock unavailable')
    })
    const measure = vi.spyOn(performance, 'measure').mockImplementation(() => {
      throw new Error('measurement unavailable')
    })
    vi.spyOn(performance, 'clearMeasures').mockImplementation(() => {
      throw new Error('measurement cleanup unavailable')
    })
    try {
      const f = fixture()
      f.receiver.mount(grant.viewId, 'retained-terminal')
      f.receiver.grant({ viewId: grant.viewId, grant })
      f.receiver.receive(f.texture, f.metadata)
      expect(f.drawn).toHaveBeenCalledOnce()
      expect(f.frame.close).toHaveBeenCalledOnce()
      expect(f.texture.release).toHaveBeenCalledOnce()
      expect(measure).toHaveBeenCalled()
      const original = new Error('frame close failed')
      f.frame.close.mockImplementationOnce(() => {
        throw original
      })
      expect(() => f.receiver.receive(f.texture, f.metadata)).toThrow(original)
      expect(f.texture.release).toHaveBeenCalledTimes(2)
    } finally {
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
    }
  })
  it('reports geometry readiness only after a successful current draw', () => {
    const f = fixture()
    f.receiver.mount(grant.viewId, 'retained-terminal')
    f.receiver.grant({ viewId: grant.viewId, grant })
    f.canvas.draw.mockImplementationOnce(() => {
      expect(f.drawn).not.toHaveBeenCalled()
    })
    f.receiver.receive(f.texture, f.metadata)
    expect(f.drawn).toHaveBeenCalledExactlyOnceWith(f.metadata)
    f.canvas.draw.mockImplementationOnce(() => {
      throw new Error('canvas draw refused')
    })
    f.receiver.receive(f.texture, f.metadata)
    expect(f.drawn).toHaveBeenCalledOnce()
  })
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

describe('visible refit canvas resource lifetime', () => {
  const refit = { attachment: grant.attachment, nativeEpoch: grant.nativeEpoch }
  const begin = (f: ReturnType<typeof fixture>, initial = grant) => {
    f.receiver.mount(grant.viewId, 'pane')
    f.receiver.grant({ viewId: grant.viewId, grant: initial })
    f.receiver.receive(f.texture, { ...f.metadata, nativeTerminal: initial })
  }

  it('retains only the eligible canvas across a grantless gap and rejects GPU/pixel delivery before opening frames', () => {
    const f = fixture(true),
      next = { ...grant, geometrySerial: 3 }
    begin(f)
    f.receiver.grant({ viewId: grant.viewId, refit })
    expect(f.suspend).toHaveBeenCalledOnce()
    f.receiver.receive(f.texture, f.metadata)
    f.receiver.receive(f.texture, { ...f.metadata, nativeTerminal: next })
    expect(
      f.receiver.pixels({
        ...f.metadata,
        bytes: new Uint8Array(64 * 32 * 4),
        stride: 256,
        premultiplied: false,
      }),
    ).toBe(false)
    expect(f.texture.getVideoFrame).toHaveBeenCalledOnce()
    expect(f.texture.release).toHaveBeenCalledTimes(3)
    expect(f.canvas.draw).toHaveBeenCalledOnce()
    expect(f.drawn).toHaveBeenCalledOnce()
    expect(f.canvas.dispose).not.toHaveBeenCalled()
    f.receiver.grant({ viewId: grant.viewId, grant: next })
    f.receiver.receive(f.texture, f.metadata)
    f.receiver.receive(f.texture, { ...f.metadata, nativeTerminal: next })
    expect(f.create).toHaveBeenCalledOnce()
    expect(f.canvas.draw).toHaveBeenCalledTimes(2)
    expect(f.drawn).toHaveBeenLastCalledWith({ ...f.metadata, nativeTerminal: next })
  })

  it('sets the resume floor from the highest issued geometry even if it was never drawn', () => {
    const f = fixture(true),
      third = { ...grant, geometrySerial: 3 },
      fourth = { ...grant, geometrySerial: 4 }
    begin(f)
    f.receiver.grant({ viewId: grant.viewId, refit })
    f.receiver.grant({ viewId: grant.viewId, grant: third })
    f.receiver.grant({ viewId: grant.viewId, refit })
    f.receiver.grant({ viewId: grant.viewId, refit })
    for (const stale of [grant, third]) {
      f.receiver.grant({ viewId: grant.viewId, grant: stale })
      f.receiver.receive(f.texture, { ...f.metadata, nativeTerminal: stale })
    }
    expect(f.texture.getVideoFrame).toHaveBeenCalledOnce()
    f.receiver.grant({ viewId: grant.viewId, grant: fourth })
    f.receiver.receive(f.texture, { ...f.metadata, nativeTerminal: fourth })
    expect(f.create).toHaveBeenCalledOnce()
    expect(f.canvas.draw).toHaveBeenCalledTimes(2)
    expect(f.canvas.dispose).not.toHaveBeenCalled()
  })

  it.each(['default', 'unmount', 'remount', 'dispose', 'failure'] as const)(
    'disposes an already grantless retained canvas at %s',
    (boundary) => {
      const f = fixture(true)
      begin(f)
      f.receiver.grant({ viewId: grant.viewId, refit })
      if (boundary === 'default') f.receiver.grant({ viewId: grant.viewId })
      if (boundary === 'unmount') f.receiver.unmount(grant.viewId)
      if (boundary === 'remount') f.receiver.mount(grant.viewId, 'replacement')
      if (boundary === 'dispose') f.receiver.dispose()
      if (boundary === 'failure')
        f.receiver.status({
          viewId: grant.viewId,
          mode: 'unavailable',
          reason: 'native-lost',
        })
      f.receiver.receive(f.texture, f.metadata)
      f.receiver.dispose()
      expect(f.canvas.dispose).toHaveBeenCalledOnce()
      expect(f.canvas.draw).toHaveBeenCalledOnce()
      expect(f.texture.getVideoFrame).toHaveBeenCalledOnce()
    },
  )

  it.each([
    undefined,
    { ...refit, attachment: 2 },
    { ...refit, nativeEpoch: 'cccccccc-cccc-cccc-cccc-cccccccccccc' },
    { ...refit, extra: true },
  ])('defaults to disposal for an absent/malformed/foreign refit hint %j', (hint) => {
    const f = fixture(true)
    begin(f)
    f.receiver.grant({ viewId: grant.viewId, refit: hint })
    expect(f.suspend).not.toHaveBeenCalled()
    expect(f.canvas.dispose).toHaveBeenCalledOnce()
  })

  it('disposes a compatibility canvas that has no GPU suspension capability', () => {
    const f = fixture()
    begin(f)
    f.receiver.grant({ viewId: grant.viewId, refit })
    expect(f.canvas.dispose).toHaveBeenCalledOnce()
  })

  it.each([{ attachment: 2 }, { nativeEpoch: 'cccccccc-cccc-cccc-cccc-cccccccccccc' }])(
    'disposes retained resources when scope is replaced by %j',
    (change) => {
      const f = fixture(true),
        replacement = fixture(true).canvas,
        next = { ...grant, ...change, geometrySerial: 3 }
      f.create.mockReturnValueOnce(f.canvas).mockReturnValueOnce(replacement)
      begin(f)
      f.receiver.grant({ viewId: grant.viewId, refit })
      f.receiver.grant({ viewId: grant.viewId, grant: next })
      expect(f.canvas.dispose).toHaveBeenCalledOnce()
      f.receiver.receive(f.texture, { ...f.metadata, nativeTerminal: next })
      expect(f.create).toHaveBeenCalledTimes(2)
      expect(replacement.draw).toHaveBeenCalledOnce()
    },
  )

  it('latches context loss in a refit gap and acknowledges only a strictly newer issued grant without enabling drawing', () => {
    const f = fixture(true),
      third = { ...grant, geometrySerial: 3 },
      fourth = { ...grant, geometrySerial: 4 }
    const status = vi.fn()
    f.receiver.onStatus(status)
    begin(f)
    const lost = f.create.mock.calls[0]![1]
    f.receiver.grant({ viewId: grant.viewId, refit })
    lost()
    expect(f.canvas.dispose).toHaveBeenCalledOnce()
    expect(f.failed).not.toHaveBeenCalled()
    expect(status).toHaveBeenLastCalledWith({
      viewId: grant.viewId,
      mode: 'unavailable',
      reason: 'renderer-lost',
    })
    f.receiver.grant({ viewId: grant.viewId, grant })
    expect(f.failed).not.toHaveBeenCalled()
    f.receiver.grant({ viewId: grant.viewId, grant: third })
    expect(f.failed).toHaveBeenCalledExactlyOnceWith(third)
    f.receiver.receive(f.texture, { ...f.metadata, nativeTerminal: third })
    f.receiver.grant({ viewId: grant.viewId, grant: third })
    expect(f.failed).toHaveBeenCalledOnce()
    f.receiver.grant({ viewId: grant.viewId, grant: fourth })
    expect(f.failed).toHaveBeenCalledTimes(2)
    expect(f.texture.getVideoFrame).toHaveBeenCalledOnce()
    expect(f.create).toHaveBeenCalledOnce()
    expect(f.drawn).toHaveBeenCalledOnce()
  })

  it('routes loss of a reused canvas through the newly issued grant rather than its first frame metadata', () => {
    const f = fixture(true),
      next = { ...grant, geometrySerial: 3 }
    begin(f)
    const lost = f.create.mock.calls[0]![1]
    f.receiver.grant({ viewId: grant.viewId, refit })
    f.receiver.grant({ viewId: grant.viewId, grant: next })
    f.receiver.receive(f.texture, { ...f.metadata, nativeTerminal: next })
    lost()
    expect(f.failed).toHaveBeenCalledExactlyOnceWith(next)
    expect(f.canvas.dispose).toHaveBeenCalledOnce()
    f.receiver.receive(f.texture, { ...f.metadata, nativeTerminal: next })
    expect(f.canvas.draw).toHaveBeenCalledTimes(2)
  })

  it('ignores a disposed canvas callback after attachment replacement', () => {
    const f = fixture(true),
      replacement = fixture(true).canvas,
      next = { ...grant, attachment: 2, geometrySerial: 3 }
    f.create.mockReturnValueOnce(f.canvas).mockReturnValueOnce(replacement)
    begin(f)
    const oldLost = f.create.mock.calls[0]![1]
    f.receiver.grant({ viewId: grant.viewId, grant: next })
    f.receiver.receive(f.texture, { ...f.metadata, nativeTerminal: next })
    oldLost()
    f.receiver.receive(f.texture, { ...f.metadata, nativeTerminal: next })
    expect(f.failed).not.toHaveBeenCalled()
    expect(replacement.dispose).not.toHaveBeenCalled()
    expect(replacement.draw).toHaveBeenCalledTimes(2)
  })

  it('invalidates a factory-era binding before a reentrant remount and disposes its late returned canvas', () => {
    const f = fixture(true),
      replacement = fixture(true).canvas,
      next = { ...grant, geometrySerial: 3 }
    f.receiver.mount(grant.viewId, 'pane')
    f.receiver.grant({ viewId: grant.viewId, grant })
    f.create
      .mockImplementationOnce(() => {
        f.receiver.mount(grant.viewId, 'replacement')
        f.receiver.grant({ viewId: grant.viewId, grant: next })
        return f.canvas
      })
      .mockReturnValueOnce(replacement)
    f.receiver.receive(f.texture, f.metadata)
    expect(f.canvas.dispose).toHaveBeenCalledOnce()
    expect(f.texture.getVideoFrame).not.toHaveBeenCalled()
    f.receiver.receive(f.texture, { ...f.metadata, nativeTerminal: next })
    f.create.mock.calls[0]![1]()
    expect(f.failed).not.toHaveBeenCalled()
    expect(replacement.draw).toHaveBeenCalledOnce()
  })

  it('does not open a frame if its canvas loses context during construction', () => {
    const f = fixture(true)
    f.receiver.mount(grant.viewId, 'pane')
    f.receiver.grant({ viewId: grant.viewId, grant })
    f.create.mockImplementationOnce((_id, lost) => {
      lost()
      return f.canvas
    })
    f.receiver.receive(f.texture, f.metadata)
    expect(f.canvas.dispose).toHaveBeenCalledOnce()
    expect(f.failed).toHaveBeenCalledExactlyOnceWith(grant)
    expect(f.texture.getVideoFrame).not.toHaveBeenCalled()
    expect(f.texture.release).toHaveBeenCalledOnce()
  })

  it('closes an already opened frame without drawing when its grant is revoked reentrantly', () => {
    const f = fixture(true)
    begin(f)
    f.texture.getVideoFrame.mockImplementationOnce(() => {
      f.receiver.grant({ viewId: grant.viewId, refit })
      return f.frame
    })
    f.receiver.receive(f.texture, f.metadata)
    expect(f.canvas.draw).toHaveBeenCalledOnce()
    expect(f.drawn).toHaveBeenCalledOnce()
    expect(f.frame.close).toHaveBeenCalledTimes(2)
    expect(f.texture.release).toHaveBeenCalledTimes(2)
    expect(f.canvas.dispose).not.toHaveBeenCalled()
  })
  it.each(['revoke', 'replace', 'loss'] as const)(
    'returns a truthful rejected pixel acknowledgement when drawing triggers %s',
    (boundary) => {
      const f = fixture(true),
        next = { ...grant, attachment: 2, geometrySerial: 3 }
      begin(f)
      f.canvas.pixels.mockImplementationOnce(() => {
        if (boundary === 'revoke') f.receiver.grant({ viewId: grant.viewId, refit })
        if (boundary === 'replace')
          f.receiver.grant({ viewId: grant.viewId, grant: next })
        if (boundary === 'loss') f.create.mock.calls[0]![1]()
      })
      expect(
        f.receiver.pixels({
          ...f.metadata,
          bytes: new Uint8Array(64 * 32 * 4),
          stride: 256,
          premultiplied: false,
        }),
      ).toBe(false)
      expect(f.canvas.pixels).toHaveBeenCalledOnce()
      expect(f.drawn).toHaveBeenCalledOnce()
      if (boundary === 'revoke') expect(f.canvas.dispose).not.toHaveBeenCalled()
      else expect(f.canvas.dispose).toHaveBeenCalledOnce()
    },
  )

  it('does not fail a replacement binding when the previous suspended port replaces itself and then throws', () => {
    const f = fixture(true),
      replacement = fixture(true).canvas,
      next = { ...grant, attachment: 2, geometrySerial: 3 }
    f.create.mockReturnValueOnce(f.canvas).mockReturnValueOnce(replacement)
    begin(f)
    f.suspend.mockImplementationOnce(() => {
      f.receiver.grant({ viewId: grant.viewId, grant: next })
      f.receiver.receive(f.texture, { ...f.metadata, nativeTerminal: next })
      throw new Error('Retired suspended port failed')
    })
    f.receiver.grant({ viewId: grant.viewId, refit })
    f.receiver.receive(f.texture, { ...f.metadata, nativeTerminal: next })
    expect(f.failed).not.toHaveBeenCalled()
    expect(f.canvas.dispose).toHaveBeenCalledOnce()
    expect(replacement.dispose).not.toHaveBeenCalled()
    expect(replacement.draw).toHaveBeenCalledTimes(2)
  })

  it.each(['dispose', 'status'] as const)(
    'still reports the current failure grant when %s throws and preserves that error',
    (boundary) => {
      const f = fixture(true),
        error = new Error('Failure boundary refused'),
        status = vi.fn()
      begin(f)
      if (boundary === 'dispose')
        f.canvas.dispose.mockImplementationOnce(() => {
          throw error
        })
      f.receiver.onStatus((value) => {
        status(value)
        if (boundary === 'status') throw error
      })
      expect(() => f.create.mock.calls[0]![1]()).toThrow(error)
      expect(f.failed).toHaveBeenCalledExactlyOnceWith(grant)
      expect(status).toHaveBeenCalledExactlyOnceWith({
        viewId: grant.viewId,
        mode: 'unavailable',
        reason: 'renderer-lost',
      })
      expect(f.canvas.dispose).toHaveBeenCalledOnce()
      f.receiver.receive(f.texture, f.metadata)
      expect(f.texture.getVideoFrame).toHaveBeenCalledOnce()
    },
  )

  it('retains each failure if cleanup, local notification, and main notification all throw', () => {
    const f = fixture(true),
      cleanup = new Error('Cleanup refused'),
      local = new Error('Local notification refused'),
      main = new Error('Main notification refused')
    begin(f)
    f.canvas.dispose.mockImplementationOnce(() => {
      throw cleanup
    })
    f.receiver.onStatus(() => {
      throw local
    })
    f.failed.mockImplementationOnce(() => {
      throw main
    })
    let observed: unknown
    try {
      f.create.mock.calls[0]![1]()
    } catch (error) {
      observed = error
    }
    expect(observed).toBeInstanceOf(AggregateError)
    expect((observed as AggregateError).errors).toEqual([cleanup, local, main])
    expect(f.failed).toHaveBeenCalledOnce()
    expect(f.canvas.dispose).toHaveBeenCalledOnce()
  })
  it('revokes the old grant before replacement disposal can reenter delivery and throw', () => {
    const f = fixture(true),
      next = { ...grant, attachment: 2, geometrySerial: 3 },
      error = new Error('Replacement disposal refused')
    begin(f)
    const oldLost = f.create.mock.calls[0]![1]
    f.canvas.dispose.mockImplementationOnce(() => {
      f.receiver.receive(f.texture, f.metadata)
      oldLost()
      throw error
    })
    expect(() => f.receiver.grant({ viewId: grant.viewId, grant: next })).toThrow(error)
    f.receiver.receive(f.texture, f.metadata)
    f.receiver.receive(f.texture, { ...f.metadata, nativeTerminal: next })
    expect(f.texture.getVideoFrame).toHaveBeenCalledOnce()
    expect(f.canvas.draw).toHaveBeenCalledOnce()
    expect(f.create).toHaveBeenCalledOnce()
    expect(f.failed).not.toHaveBeenCalled()
    expect(f.canvas.dispose).toHaveBeenCalledOnce()
    expect(f.texture.release).toHaveBeenCalledTimes(4)
  })
  it.each(['geometry-failed', 'pixel-bound'] as const)(
    'permits a fresh strictly newer grant after main reports %s without forgiving local loss',
    (reason) => {
      const f = fixture(true),
        replacement = fixture(true).canvas,
        next = { ...grant, geometrySerial: 3 }
      f.create.mockReturnValueOnce(f.canvas).mockReturnValueOnce(replacement)
      begin(f)
      const oldLost = f.create.mock.calls[0]![1]
      f.receiver.status({ viewId: grant.viewId, mode: 'unavailable', reason })
      expect(f.canvas.dispose).toHaveBeenCalledOnce()
      f.receiver.grant({ viewId: grant.viewId, grant })
      f.receiver.receive(f.texture, f.metadata)
      expect(f.create).toHaveBeenCalledOnce()
      f.receiver.grant({ viewId: grant.viewId, grant: next })
      f.receiver.receive(f.texture, { ...f.metadata, nativeTerminal: next })
      oldLost()
      expect(f.create).toHaveBeenCalledTimes(2)
      expect(replacement.draw).toHaveBeenCalledOnce()
      expect(f.failed).not.toHaveBeenCalled()
      f.create.mock.calls[1]![1]()
      f.receiver.status({ viewId: grant.viewId, mode: 'unavailable', reason })
      f.receiver.status({ viewId: grant.viewId, mode: 'native-gpu' })
      const later = { ...next, geometrySerial: 4 }
      f.receiver.grant({ viewId: grant.viewId, grant: later })
      f.receiver.receive(f.texture, { ...f.metadata, nativeTerminal: later })
      expect(f.create).toHaveBeenCalledTimes(2)
      expect(replacement.dispose).toHaveBeenCalledOnce()
      expect(replacement.draw).toHaveBeenCalledOnce()
      expect(f.failed).toHaveBeenLastCalledWith(later)
    },
  )
  it.each(['throwing-port', 'missing-port'] as const)(
    'retires an abandoned same-scope factory binding before %s cleanup or a late lost callback',
    (result) => {
      const f = fixture(true),
        replacement = fixture(true).canvas,
        start = { ...grant, geometrySerial: 3 },
        next = { ...grant, geometrySerial: 4 }
      let oldLost!: () => void
      f.receiver.mount(grant.viewId, 'pane')
      f.receiver.grant({ viewId: grant.viewId, grant: start })
      f.create
        .mockImplementationOnce((_id, lost) => {
          oldLost = lost
          f.receiver.grant({ viewId: grant.viewId, grant: next })
          if (result === 'missing-port') return undefined
          f.canvas.dispose.mockImplementationOnce(() => {
            lost()
            throw new Error('Abandoned port cleanup refused')
          })
          return f.canvas
        })
        .mockReturnValueOnce(replacement)
      f.receiver.receive(f.texture, { ...f.metadata, nativeTerminal: start })
      oldLost()
      if (result === 'throwing-port') expect(f.canvas.dispose).toHaveBeenCalledOnce()
      else expect(f.canvas.dispose).not.toHaveBeenCalled()
      expect(f.failed).not.toHaveBeenCalled()
      expect(f.texture.getVideoFrame).not.toHaveBeenCalled()
      expect(f.texture.release).toHaveBeenCalledOnce()
      expect(f.drawn).not.toHaveBeenCalled()
      f.receiver.receive(f.texture, { ...f.metadata, nativeTerminal: next })
      expect(f.create).toHaveBeenCalledTimes(2)
      expect(replacement.draw).toHaveBeenCalledOnce()
      expect(replacement.dispose).not.toHaveBeenCalled()
      expect(f.frame.close).toHaveBeenCalledOnce()
      expect(f.texture.release).toHaveBeenCalledTimes(2)
      expect(f.failed).not.toHaveBeenCalled()
      expect(f.drawn).toHaveBeenCalledExactlyOnceWith({
        ...f.metadata,
        nativeTerminal: next,
      })
    },
  )
})
