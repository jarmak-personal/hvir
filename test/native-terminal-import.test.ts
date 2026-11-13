import type {
  ImportSharedTextureOptions,
  SharedTexture,
  SharedTextureImported,
  WebFrameMain,
} from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Receipt } from '../packages/native-terminal/resource'
import { NativeTerminalFrameImports } from '../src/main/terminal/native-terminal-import'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function source() {
  return {
    metadata: {
      lease: '1',
      streamSequence: 7,
      geometrySerial: 2,
      kind: 1,
      width: 16,
      height: 16,
      colorSpace: 2,
      origin: 1,
      premultiplied: true,
    },
    assertCurrent: vi.fn(),
    transfer: vi.fn(() => Promise.resolve()),
    release: vi.fn(() => Promise.resolve()),
    retire: vi.fn(() => Promise.resolve()),
  }
}
function receipt(ticket: string, extra: Partial<Receipt> = {}): Receipt {
  return {
    ticket,
    kind: 1,
    width: 16,
    height: 16,
    fourcc: 0x42475241,
    colorSpace: 2,
    origin: 1,
    premultiplied: true,
    modifier: 0n,
    planeCount: 0,
    planes: [],
    surface: Buffer.alloc(8),
    ...extra,
  }
}
function fixture(extra: Partial<Receipt> = {}) {
  const options: ImportSharedTextureOptions[] = []
  const imported: SharedTextureImported[] = []
  const edge = {
    receive: vi.fn((ticket: string) => Promise.resolve(receipt(ticket, extra))),
    release: vi.fn(),
  }
  const textures = {
    importSharedTexture: vi.fn((value: ImportSharedTextureOptions) => {
      options.push(value)
      const texture = { release: vi.fn() } as unknown as SharedTextureImported
      imported.push(texture)
      return texture
    }),
    sendSharedTexture: vi.fn(() => Promise.resolve()),
  } satisfies Pick<SharedTexture, 'importSharedTexture' | 'sendSharedTexture'>
  const live = { current: true, dead: false }
  const target = {
    ready: true,
    isCurrent: () => live.current,
    frame: { isDestroyed: () => live.dead } as WebFrameMain,
  }
  return {
    edge,
    textures,
    options,
    imported,
    live,
    target,
    owner: new NativeTerminalFrameImports(edge, textures),
  }
}

afterEach(() => vi.useRealTimers())
describe('native terminal main imports', () => {
  it('keeps both resource owners until Electron releases every reference, independently of send acknowledgement', async () => {
    const f = fixture(),
      native = source()
    const value = await f.owner.acquire(native, f.target)
    expect(f.options[0]!.textureInfo).toMatchObject({
      pixelFormat: 'bgra',
      colorSpace: { primaries: 'p3', transfer: 'srgb', matrix: 'rgb', range: 'full' },
    })
    await value.send()
    value.release()
    expect(f.imported[0]!.release).toHaveBeenCalledTimes(1)
    expect(f.edge.release).not.toHaveBeenCalled()
    expect(native.release).not.toHaveBeenCalled()
    f.options[0]!.allReferencesReleased?.()
    f.options[0]!.allReferencesReleased?.()
    await value.released
    expect(f.edge.release).toHaveBeenCalledTimes(1)
    expect(native.release).toHaveBeenCalledTimes(1)
    expect(f.textures.sendSharedTexture).toHaveBeenCalledWith(
      { frame: f.target.frame, importedSharedTexture: f.imported[0]! },
      expect.objectContaining({ origin: 1, geometrySerial: 2, streamSequence: 7 }),
    )
  })

  it('serializes both transfer and receive settlement before another shared endpoint handshake', async () => {
    const f = fixture(),
      first = source(),
      second = source()
    const incoming = deferred<Receipt>(),
      transfer = deferred<void>(),
      entered = deferred<void>()
    f.edge.receive.mockImplementationOnce(() => incoming.promise)
    vi.mocked(first.transfer).mockImplementation(() => {
      entered.resolve()
      return transfer.promise
    })
    const a = f.owner.acquire(first, f.target)
    const failed = expect(a).rejects.toThrow('transfer-failed')
    const b = f.owner.acquire(second, f.target)
    await entered.promise
    transfer.reject(new Error('transfer-failed'))
    expect(f.edge.receive).toHaveBeenCalledTimes(1)
    expect(second.transfer).not.toHaveBeenCalled()
    incoming.resolve(receipt(f.edge.receive.mock.calls[0]![0]))
    await failed
    const acquired = await b
    expect(first.release).toHaveBeenCalledTimes(1)
    expect(f.edge.release).toHaveBeenCalledTimes(1)
    expect(second.transfer).toHaveBeenCalledTimes(1)
    acquired.release()
    f.options[0]!.allReferencesReleased?.()
    await acquired.released
  })

  it.each([
    { width: 17 },
    { origin: 2 },
    { colorSpace: 1 },
    { premultiplied: false },
    { fourcc: 0 },
    { surface: Buffer.alloc(4) },
    { ticket: 'foreign' },
  ])(
    'rejects malformed or foreign resource metadata before import: %j',
    async (extra) => {
      const f = fixture(extra),
        native = source()
      await expect(f.owner.acquire(native, f.target)).rejects.toThrow(/native-resource/)
      expect(f.textures.importSharedTexture).not.toHaveBeenCalled()
      expect(f.edge.release).toHaveBeenCalledTimes(1)
      expect(native.release).toHaveBeenCalledTimes(1)
    },
  )

  it('rechecks authority after transfer and before import', async () => {
    const f = fixture(),
      native = source()
    vi.mocked(native.transfer).mockImplementation(() => {
      f.live.current = false
      return Promise.resolve()
    })
    await expect(f.owner.acquire(native, f.target)).rejects.toThrow(
      'native-import-target-stale',
    )
    expect(f.textures.importSharedTexture).not.toHaveBeenCalled()
    expect(f.edge.release).toHaveBeenCalledTimes(1)
    expect(native.release).toHaveBeenCalledTimes(1)
  })

  it('refuses an unready receiver before opening a transfer and releases failed imports', async () => {
    const f = fixture(),
      unready = source()
    f.target.ready = false
    await expect(f.owner.acquire(unready, f.target)).rejects.toThrow(
      'native-import-target-stale',
    )
    expect(f.edge.receive).not.toHaveBeenCalled()
    expect(unready.release).toHaveBeenCalledTimes(1)
    f.target.ready = true
    const failed = source()
    f.textures.importSharedTexture.mockImplementation(() => {
      throw new Error('import-failed')
    })
    await expect(f.owner.acquire(failed, f.target)).rejects.toThrow('import-failed')
    expect(f.edge.release).toHaveBeenCalledTimes(1)
    expect(failed.release).toHaveBeenCalledTimes(1)
  })

  it('counts pending endpoint handshakes against the three-resource bound', async () => {
    const f = fixture(),
      incoming = deferred<Receipt>(),
      entered = deferred<void>()
    f.edge.receive.mockImplementationOnce(() => {
      entered.resolve()
      return incoming.promise
    })
    const pending = [source(), source(), source()].map((native) =>
      f.owner.acquire(native, f.target),
    )
    await entered.promise
    await expect(f.owner.acquire(source(), f.target)).rejects.toThrow(
      'native-import-bound',
    )
    expect(f.edge.receive).toHaveBeenCalledTimes(1)
    incoming.resolve(receipt(f.edge.receive.mock.calls[0]![0]))
    const completed = await Promise.all(pending)
    for (const [index, value] of completed.entries()) {
      value.release()
      f.options[index]!.allReferencesReleased?.()
      await value.released
    }
  })

  it('rechecks source and receiver before sending and safely discards an unsent import', async () => {
    const f = fixture(),
      native = source()
    const acquired = await f.owner.acquire(native, f.target)
    vi.mocked(native.assertCurrent).mockImplementation(() => {
      throw new Error('native-frame-stale')
    })
    await expect(acquired.send()).rejects.toThrow('native-frame-stale')
    expect(f.textures.sendSharedTexture).not.toHaveBeenCalled()
    expect(f.imported[0]!.release).toHaveBeenCalledTimes(1)
    f.options[0]!.allReferencesReleased?.()
    await acquired.released
  })

  it('bounds pending plus physically retained resources at three and recovers after final release', async () => {
    const f = fixture()
    const values = await Promise.all(
      [source(), source(), source()].map((value) => f.owner.acquire(value, f.target)),
    )
    const refused = source()
    await expect(f.owner.acquire(refused, f.target)).rejects.toThrow(
      'native-import-bound',
    )
    expect(refused.release).toHaveBeenCalledTimes(1)
    values[0]!.release()
    await expect(f.owner.acquire(source(), f.target)).rejects.toThrow(
      'native-import-bound',
    )
    f.options[0]!.allReferencesReleased?.()
    await values[0]!.released
    const replacement = await f.owner.acquire(source(), f.target)
    for (const [index, value] of [...values.slice(1), replacement].entries()) {
      value.release()
      f.options[index + 1]!.allReferencesReleased?.()
      await value.released
    }
  })

  it('preserves Linux modifier precision and bottom origin while validating safe plane sizes', async () => {
    const f = fixture({
      kind: 2,
      fourcc: 0x34324241,
      surface: undefined,
      colorSpace: 1,
      origin: 2,
      modifier: 0x123456789abcdef0n,
      planeCount: 1,
      planes: [{ fd: 9, stride: 64, offset: 0, size: 4096n }],
    })
    const native = source()
    Object.assign(native.metadata, { kind: 2, colorSpace: 1, origin: 2 })
    const value = await f.owner.acquire(native, f.target)
    expect(f.options[0]!.textureInfo).toMatchObject({
      pixelFormat: 'rgba',
      colorSpace: { primaries: 'bt709' },
      handle: {
        nativePixmap: {
          modifier: '1311768467463790320',
          planes: [{ fd: 9, stride: 64, offset: 0, size: 4096 }],
        },
      },
    })
    expect(value.metadata.origin).toBe(2)
    value.release()
    f.options[0]!.allReferencesReleased?.()
    await value.released
  })

  it('refuses unsafe Linux allocation sizes without losing either owner', async () => {
    const f = fixture({
      kind: 2,
      fourcc: 0x34325241,
      surface: undefined,
      planeCount: 1,
      planes: [{ fd: 9, stride: 64, offset: 0, size: 1n << 60n }],
    })
    const native = source()
    Object.assign(native.metadata, { kind: 2 })
    await expect(f.owner.acquire(native, f.target)).rejects.toThrow(
      'native-resource-plane',
    )
    expect(f.edge.release).toHaveBeenCalledTimes(1)
    expect(native.release).toHaveBeenCalledTimes(1)
  })

  it('quarantines an indeterminate late send until both source retirement and receiver destruction', async () => {
    vi.useFakeTimers()
    const f = fixture(),
      native = source(),
      retirement = deferred<void>(),
      acknowledgement = deferred<void>()
    f.textures.sendSharedTexture.mockReturnValue(acknowledgement.promise)
    vi.mocked(native.retire).mockReturnValue(retirement.promise)
    const value = await f.owner.acquire(native, f.target)
    const sent = value.send()
    value.release()
    expect(f.imported[0]!.release).not.toHaveBeenCalled()
    acknowledgement.reject(new Error('send-timeout'))
    await expect(sent).rejects.toThrow('send-timeout')
    expect(native.retire).toHaveBeenCalledTimes(1)
    value.release()
    f.live.dead = true
    await vi.advanceTimersByTimeAsync(50)
    expect(f.imported[0]!.release).not.toHaveBeenCalled()
    retirement.resolve()
    await vi.advanceTimersByTimeAsync(50)
    expect(f.imported[0]!.release).toHaveBeenCalledTimes(1)
    expect(f.edge.release).not.toHaveBeenCalled()
    expect(native.release).not.toHaveBeenCalled()
    f.options[0]!.allReferencesReleased?.()
    await value.released
    expect(f.edge.release).toHaveBeenCalledTimes(1)
    expect(native.release).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
