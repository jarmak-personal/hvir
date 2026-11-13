import { afterEach, describe, expect, it, vi } from 'vitest'
import { NATIVE_TERMINAL_LIMITS } from '../src/shared/native-terminal'
import {
  NativeTerminalGpuImportUnavailable,
  NativeTerminalImportQuarantined,
} from '../src/main/terminal/native-terminal-import'
import {
  nativeTerminalPresenterFixture as fixture,
  deferred,
} from './fixtures/native-terminal-presenter'

type Fixture = ReturnType<typeof fixture>
function supply(f: Fixture, kind: 2 | 3) {
  const source = f.source()
  Object.assign(source.metadata, {
    kind,
    colorSpace: 1,
    origin: 2,
    resource: {
      fourcc: kind === 2 ? 0x34324241 : 0,
      modifier: '0',
      planes:
        kind === 2
          ? [
              {
                stride: source.metadata.width * 4,
                offset: 0,
                size: source.metadata.width * source.metadata.height * 4,
              },
            ]
          : [],
    },
  })
  f.host.takeFrame.mockResolvedValueOnce(source)
  return source
}
async function visible(f: Fixture) {
  const id = await f.owner.attach('state', f.session, f.target)
  await f.owner.update(id, { width: 64, height: 32, backingScale: 1, visible: true })
  return id
}
afterEach(() => vi.useRealTimers())

describe('same-state Linux native compatibility', () => {
  it('holds the DMA lease through mode admission, releases it, then waits for actual pixels', async () => {
    const f = fixture('auto'),
      id = await visible(f)
    const old = supply(f, 2),
      admitted = deferred<void>()
    f.imports.acquire.mockRejectedValue(
      new NativeTerminalGpuImportUnavailable(new Error('safe preflight')),
    )
    f.host.presentationMode.mockReturnValueOnce(admitted.promise)
    const pending = f.owner.demand(id)
    await vi.waitFor(() =>
      expect(f.host.presentationMode).toHaveBeenLastCalledWith(
        'state',
        1,
        1,
        1,
        'pixels',
      ),
    )
    expect(old.release).not.toHaveBeenCalled()
    expect(old.copyPixels).not.toHaveBeenCalled()
    admitted.resolve()
    await expect(pending).resolves.toBe(false)
    expect(old.release).toHaveBeenCalledOnce()
    const stale = supply(f, 2)
    await expect(f.owner.demand(id)).resolves.toBe(false)
    expect(stale.release).toHaveBeenCalledOnce()
    expect(stale.copyPixels).not.toHaveBeenCalled()
    const current = supply(f, 3)
    await expect(f.owner.demand(id)).resolves.toBe(true)
    expect(current.copyPixels).toHaveBeenCalledOnce()
    expect(current.release).toHaveBeenCalledOnce()
    expect(f.imports.acquire).toHaveBeenCalledOnce()
    expect(f.target.publishStatus).toHaveBeenLastCalledWith({
      viewId: id,
      mode: 'native-pixels',
      reason: 'import-unavailable',
    })
  })
  it('forces initial pixels without importing DMA and preserves that selection across attachment', async () => {
    const f = fixture('pixels'),
      id = await visible(f)
    const old = supply(f, 2)
    await expect(f.owner.demand(id)).resolves.toBe(false)
    expect(old.copyPixels).not.toHaveBeenCalled()
    const pixels = supply(f, 3)
    await expect(f.owner.demand(id)).resolves.toBe(true)
    expect(pixels.copyPixels).toHaveBeenCalledOnce()
    expect(f.imports.acquire).not.toHaveBeenCalled()
    await f.owner.detach(id)
    await f.owner.attach('state', f.session, f.target)
    expect(f.host.presentationMode.mock.calls.map((call) => call.at(-1))).toEqual([
      'pixels',
      'pixels',
    ])
  })
  it('retries auto only on a fresh valid attachment and never reopens quarantined state', async () => {
    const f = fixture('auto'),
      id = await visible(f)
    const old = supply(f, 2)
    f.imports.acquire.mockRejectedValue(
      new NativeTerminalImportQuarantined(new Error('unknown GPU ownership')),
    )
    await expect(f.owner.demand(id)).rejects.toThrow('native-import-quarantined')
    const replacement = await f.owner.attach('state', f.session, f.target)
    expect(f.host.presentationMode).toHaveBeenCalledOnce()
    expect(old.release).not.toHaveBeenCalled()
    await expect(f.owner.demand(replacement)).resolves.toBe(false)
    const healthy = fixture('auto'),
      first = await visible(healthy)
    await healthy.owner.detach(first)
    await healthy.owner.attach('state', healthy.session, healthy.target)
    expect(healthy.host.presentationMode.mock.calls.map((call) => call.at(-1))).toEqual([
      'auto',
      'auto',
    ])
  })
  it('rejects a known over-bound pixel geometry before acquiring or copying a frame', async () => {
    const f = fixture('pixels'),
      id = await visible(f)
    await f.owner.update(id, {
      width: 1025,
      height: 1024,
      backingScale: 2,
      visible: true,
    })
    await expect(f.owner.demand(id)).rejects.toThrow('native-pixel-bound')
    expect(f.host.takeFrame).not.toHaveBeenCalled()
    expect(f.target.publishStatus).toHaveBeenLastCalledWith({
      viewId: id,
      mode: 'unavailable',
      reason: 'pixel-bound',
    })
  })
  it('bounds an unapplied transition but keeps a quiet, already observed pixel terminal usable', async () => {
    vi.useFakeTimers()
    const pending = fixture('pixels'),
      id = await visible(pending)
    pending.host.takeFrame.mockResolvedValue(undefined)
    await expect(pending.owner.demand(id)).resolves.toBe(false)
    await vi.advanceTimersByTimeAsync(NATIVE_TERMINAL_LIMITS.requestMs)
    await expect(pending.owner.demand(id)).rejects.toThrow(
      'native-presentation-unavailable',
    )
    const quiet = fixture('pixels'),
      current = await visible(quiet)
    supply(quiet, 3)
    await expect(quiet.owner.demand(current)).resolves.toBe(true)
    quiet.host.takeFrame.mockResolvedValue(undefined)
    await vi.advanceTimersByTimeAsync(NATIVE_TERMINAL_LIMITS.requestMs + 1)
    await expect(quiet.owner.demand(current)).resolves.toBe(false)
    expect(quiet.owner.isInputCurrent(current)).toBe(true)
  })
  it('starts a fresh visible deadline after intentional occlusion', async () => {
    vi.useFakeTimers()
    const f = fixture('pixels'),
      id = await visible(f)
    f.host.takeFrame.mockResolvedValue(undefined)
    await expect(f.owner.demand(id)).resolves.toBe(false)
    await f.owner.update(id, { width: 64, height: 32, backingScale: 1, visible: false })
    await vi.advanceTimersByTimeAsync(NATIVE_TERMINAL_LIMITS.requestMs + 1)
    await f.owner.update(id, { width: 64, height: 32, backingScale: 1, visible: true })
    await expect(f.owner.demand(id)).resolves.toBe(false)
    expect(f.owner.isInputCurrent(id)).toBe(true)
    await vi.advanceTimersByTimeAsync(NATIVE_TERMINAL_LIMITS.requestMs)
    await expect(f.owner.demand(id)).rejects.toThrow('native-presentation-unavailable')
  })
  it('does not charge geometry acknowledgement time to a superseded pixel grant', async () => {
    vi.useFakeTimers()
    const f = fixture('pixels'),
      id = await visible(f)
    f.host.takeFrame.mockResolvedValue(undefined)
    await f.owner.demand(id)
    const geometry = deferred<ReturnType<typeof f.status>>()
    f.host.resize.mockReturnValueOnce(geometry.promise)
    const updated = f.owner.update(id, {
      width: 64,
      height: 32,
      backingScale: 1,
      visible: true,
    })
    await vi.advanceTimersByTimeAsync(NATIVE_TERMINAL_LIMITS.requestMs * 2)
    await expect(f.owner.demand(id)).resolves.toBe(false)
    geometry.resolve({ ...f.status(), geometry: { ...f.status().geometry, serial: 3 } })
    await updated
    await expect(f.owner.demand(id)).resolves.toBe(false)
    expect(f.owner.isInputCurrent(id)).toBe(true)
  })
  it('rejects a stale mode completion without starting a hidden transition deadline', async () => {
    vi.useFakeTimers()
    const f = fixture('auto'),
      id = await visible(f),
      mode = deferred<void>()
    supply(f, 2)
    f.imports.acquire.mockRejectedValue(
      new NativeTerminalGpuImportUnavailable(new Error('safe preflight')),
    )
    f.host.presentationMode.mockReturnValueOnce(mode.promise)
    const pending = f.owner.demand(id)
    await vi.waitFor(() =>
      expect(f.host.presentationMode).toHaveBeenLastCalledWith(
        'state',
        1,
        1,
        1,
        'pixels',
      ),
    )
    await f.owner.update(id, { width: 64, height: 32, backingScale: 1, visible: false })
    await vi.advanceTimersByTimeAsync(NATIVE_TERMINAL_LIMITS.requestMs * 2)
    await f.owner.update(id, { width: 64, height: 32, backingScale: 1, visible: true })
    mode.resolve()
    await expect(pending).resolves.toBe(false)
    supply(f, 3)
    await expect(f.owner.demand(id)).resolves.toBe(false)
    supply(f, 3)
    await expect(f.owner.demand(id)).resolves.toBe(true)
    expect(f.owner.isInputCurrent(id)).toBe(true)
  })
})
