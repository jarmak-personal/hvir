// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NativeTerminalSurface } from '../src/renderer/src/terminal/native-terminal-surface'
import { TerminalSurfaceAttachment } from '../src/renderer/src/terminal/terminal-surface-attachment'
import type {
  NativeTerminalPresentationApi,
  NativeTerminalPresentationStatus,
} from '../src/shared/native-terminal-presentation'

const viewId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
let width: number
let height: number
let nextFrame: number
let frames: Map<number, FrameRequestCallback>
const surfaces: NativeTerminalSurface[] = []
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept
    reject = refuse
  })
  return { promise, resolve, reject }
}
function fixture(useAttachment = false) {
  let status!: (value: NativeTerminalPresentationStatus) => void
  const unsubscribe = vi.fn()
  const api = {
    mount: vi.fn<NativeTerminalPresentationApi['mount']>(),
    unmount: vi.fn<NativeTerminalPresentationApi['unmount']>(),
    onStatus: vi.fn<NativeTerminalPresentationApi['onStatus']>((listener) => {
      status = listener
      return unsubscribe
    }),
  }
  const port = {
    update: vi
      .fn<ConstructorParameters<typeof NativeTerminalSurface>[2]['update']>()
      .mockResolvedValue({}),
    demand: vi
      .fn<ConstructorParameters<typeof NativeTerminalSurface>[2]['demand']>()
      .mockResolvedValue(),
    detach: vi
      .fn<ConstructorParameters<typeof NativeTerminalSurface>[2]['detach']>()
      .mockResolvedValue(),
  }
  const workspace = document.createElement('div')
  const detail = document.createElement('div')
  document.body.append(workspace, detail)
  const surface = new NativeTerminalSurface(viewId, api, port)
  surfaces.push(surface)
  let attachment: TerminalSurfaceAttachment | undefined
  if (useAttachment) {
    attachment = new TerminalSurfaceAttachment()
    attachment.attach(workspace, 'visible')
    attachment.mountPane(surface, workspace)
    attachment.synchronize('visible')
  } else surface.mount(workspace)
  const element = workspace.firstElementChild as HTMLElement
  const message = element.querySelector('[role="status"]')!
  return {
    surface,
    api,
    port,
    workspace,
    detail,
    element,
    message,
    status,
    unsubscribe,
    attachment,
  }
}
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}
async function frame(): Promise<void> {
  const scheduled = [...frames]
  for (const [id, callback] of scheduled) {
    frames.delete(id)
    callback(16)
  }
  await flush()
}
beforeEach(() => {
  vi.useFakeTimers()
  width = 640
  height = 400
  nextFrame = 0
  frames = new Map()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(1)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    return new DOMRect(0, 0, this.isConnected ? width : 0, this.isConnected ? height : 0)
  })
})
afterEach(async () => {
  for (const surface of surfaces.splice(0)) surface.dispose()
  await flush()
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('retained native terminal surface adapter', () => {
  it('requests visible geometry and demand on animation frames while retaining one mount', async () => {
    const f = fixture()
    expect(f.port.update).not.toHaveBeenCalled()
    f.surface.setPresentation('visible')
    expect(f.port.demand).not.toHaveBeenCalled()
    await frame()
    expect(f.port.update).toHaveBeenCalledExactlyOnceWith(viewId, {
      width: 640,
      height: 400,
      backingScale: 1,
      visible: true,
    })
    expect(f.port.demand).toHaveBeenCalledExactlyOnceWith(viewId)
    await frame()
    expect(f.port.update).toHaveBeenCalledTimes(1)
    expect(f.port.demand).toHaveBeenCalledTimes(2)
    expect(f.api.mount).toHaveBeenCalledExactlyOnceWith(viewId, f.element.id)
  })

  it('coalesces layout changes while one visible geometry update is pending', async () => {
    const f = fixture()
    const pending = deferred<unknown>()
    f.port.update.mockReturnValueOnce(pending.promise)
    f.surface.setPresentation('visible')
    await frame()
    width = 720
    await frame()
    await frame()
    expect(f.port.update).toHaveBeenCalledTimes(1)
    expect(f.port.demand).not.toHaveBeenCalled()
    pending.resolve({})
    await flush()
    await frame()
    expect(f.port.update).toHaveBeenCalledTimes(2)
    expect(f.port.update).toHaveBeenLastCalledWith(viewId, {
      width: 720,
      height: 400,
      backingScale: 1,
      visible: true,
    })
  })

  it('keeps a single pending demand even when visibility is requested again', async () => {
    const f = fixture()
    const pending = deferred<void>()
    f.port.demand.mockReturnValueOnce(pending.promise)
    f.surface.setPresentation('visible')
    await frame()
    f.surface.setPresentation('visible')
    await frame()
    await frame()
    expect(f.port.demand).toHaveBeenCalledTimes(1)
    pending.resolve()
    await flush()
    await frame()
    expect(f.port.demand).toHaveBeenCalledTimes(2)
  })

  it('does not revive demand from a geometry completion after hiding', async () => {
    const f = fixture()
    const pending = deferred<unknown>()
    f.port.update.mockReturnValueOnce(pending.promise)
    f.surface.setPresentation('visible')
    await frame()
    f.surface.setPresentation('hidden')
    expect(f.port.update).toHaveBeenLastCalledWith(viewId, {
      width: 640,
      height: 400,
      backingScale: 1,
      visible: false,
    })
    pending.resolve({})
    await flush()
    await frame()
    expect(f.port.demand).not.toHaveBeenCalled()
    expect(frames.size).toBe(0)
  })

  it('revokes before moving the retained node and ignores a rejected old visible update', async () => {
    const f = fixture()
    const pending = deferred<unknown>()
    const revokedAt: (Element | null)[] = []
    f.port.update.mockImplementation((_id, geometry) => {
      if (!geometry.visible) revokedAt.push(f.element.parentElement)
      return geometry.visible && f.port.update.mock.calls.length === 1
        ? pending.promise
        : Promise.resolve({})
    })
    f.surface.setPresentation('visible')
    await frame()
    f.surface.reparent(f.detail)
    expect(revokedAt).toEqual([f.workspace])
    expect(f.detail.firstElementChild).toBe(f.element)
    f.surface.setPresentation('visible')
    pending.reject(new Error('retired geometry'))
    await flush()
    await frame()
    expect(f.message.textContent).toBe('')
    expect(f.port.demand).toHaveBeenCalledExactlyOnceWith(viewId)
    expect(f.api.mount).toHaveBeenCalledTimes(1)
  })

  it('ignores rejection of an old hidden update after the attachment becomes visible', async () => {
    const f = fixture()
    f.surface.setPresentation('visible')
    await frame()
    const pending = deferred<unknown>()
    f.port.update.mockReturnValueOnce(pending.promise)
    f.surface.setPresentation('hidden')
    f.surface.setPresentation('visible')
    pending.reject(new Error('retired hide'))
    await flush()
    await frame()
    expect(f.message.textContent).toBe('')
    expect(f.port.demand).toHaveBeenCalledTimes(2)
  })

  it('keeps its identity across Workspace/Sessions leases, DPR changes and equal extents', async () => {
    const f = fixture(true)
    const attachment = f.attachment!
    await frame()
    vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(2)
    await frame()
    expect(f.port.update).toHaveBeenLastCalledWith(viewId, {
      width: 640,
      height: 400,
      backingScale: 2,
      visible: true,
    })
    const lease = attachment.acquireLease()!
    expect(attachment.attachLease(lease, f.detail, 'visible')).toBe(true)
    await frame()
    expect(f.detail.firstElementChild).toBe(f.element)
    expect(f.port.update).toHaveBeenLastCalledWith(viewId, {
      width: 640,
      height: 400,
      backingScale: 2,
      visible: true,
    })
    const beforeRestore = f.port.update.mock.calls.length
    expect(attachment.releaseLease(lease)).toBe(true)
    await frame()
    expect(f.workspace.firstElementChild).toBe(f.element)
    expect(f.port.update.mock.calls.length).toBeGreaterThan(beforeRestore)
    expect(f.api.mount.mock.calls.every(([id]) => id === viewId)).toBe(true)
    expect(f.api.mount).toHaveBeenCalledTimes(1)
    expect(f.workspace.children).toHaveLength(1)
    expect(attachment.releaseLease(lease)).toBe(false)
    attachment.dispose()
  })

  it('preserves the last usable extent when hidden layout collapses to zero', async () => {
    const f = fixture()
    f.surface.setPresentation('visible')
    await frame()
    width = 0
    height = 0
    await frame()
    expect(f.port.update).toHaveBeenCalledTimes(1)
    expect(f.port.demand).toHaveBeenCalledTimes(1)
    f.surface.setPresentation('hidden')
    expect(f.port.update).toHaveBeenLastCalledWith(viewId, {
      width: 640,
      height: 400,
      backingScale: 1,
      visible: false,
    })
    expect(
      f.port.update.mock.calls.every(([, g]) => g.width >= 32 && g.height >= 32),
    ).toBe(true)
    expect(frames.size).toBe(0)
  })

  it('shows compatibility/unavailable status only for its view and stops local demand', async () => {
    const f = fixture()
    f.surface.setPresentation('visible')
    await frame()
    f.status({ viewId: 'other-view', mode: 'unavailable' })
    expect(f.message.textContent).toBe('')
    f.status({ viewId, mode: 'native-pixels' })
    expect(f.message.textContent).toBe('Compatibility rendering')
    f.status({ viewId, mode: 'unavailable' })
    expect(f.message.textContent).toBe('Terminal unavailable')
    const count = f.port.demand.mock.calls.length
    await frame()
    await frame()
    expect(f.port.demand).toHaveBeenCalledTimes(count)
    expect(frames.size).toBe(0)
  })

  it('makes local port failure visible and stops animation demand', async () => {
    const f = fixture()
    f.port.demand.mockRejectedValueOnce(new Error('native unavailable'))
    f.surface.setPresentation('visible')
    await frame()
    expect(f.message.textContent).toBe('Terminal unavailable')
    expect(frames.size).toBe(0)
  })

  it('disposes idempotently and ignores a late geometry result after unmount', async () => {
    const f = fixture()
    const pending = deferred<unknown>()
    f.port.update.mockReturnValueOnce(pending.promise)
    f.surface.setPresentation('visible')
    await frame()
    f.surface.dispose()
    f.surface.dispose()
    expect(f.unsubscribe).toHaveBeenCalledOnce()
    expect(f.api.unmount).toHaveBeenCalledExactlyOnceWith(viewId)
    expect(f.port.detach).toHaveBeenCalledExactlyOnceWith(viewId)
    expect(f.element.isConnected).toBe(false)
    pending.resolve({})
    await flush()
    await frame()
    expect(f.port.demand).not.toHaveBeenCalled()
    expect(frames.size).toBe(0)
    expect(() => f.surface.mount(f.detail)).toThrow('native-surface-closed')
  })
})
