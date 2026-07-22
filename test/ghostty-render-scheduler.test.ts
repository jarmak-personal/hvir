import { afterEach, describe, expect, it, vi } from 'vitest'

import { Terminal } from 'ghostty-web'

type FrameCallback = (timestamp: number) => void

interface SchedulerHarness {
  isDisposed: boolean
  isOpen: boolean
  renderPaused: boolean
  forceFullRender: boolean
  parsedWrites: number
  renderRequests: number
  renderFrames: number
  fullRenderFrames: number
  animationFrameId?: number
  scrollAnimationFrame?: number
  scrollAnimationStartTime?: number
  scrollAnimationStartY?: number
  scrollbarHideTimeout?: number
  scrollbarVisible: boolean
  scrollbarOpacity: number
  viewportY: number
  lastCursorY: number
  renderer: { render: ReturnType<typeof vi.fn> }
  wasmTerm: { getCursor(): { y: number } }
  cursorMoveEmitter: { fire: ReturnType<typeof vi.fn> }
  requestRender(forceAll?: boolean): void
  setRenderPaused(paused: boolean): void
  getRenderStats(): {
    parsedWrites: number
    renderRequests: number
    renderFrames: number
    fullRenderFrames: number
    paused: boolean
    pendingFrame: boolean
  }
}

function createHarness(): SchedulerHarness {
  return Object.assign(Object.create(Terminal.prototype) as object, {
    isDisposed: false,
    isOpen: true,
    renderPaused: false,
    forceFullRender: false,
    parsedWrites: 7,
    renderRequests: 0,
    renderFrames: 0,
    fullRenderFrames: 0,
    animationFrameId: undefined,
    scrollAnimationFrame: undefined,
    scrollbarVisible: false,
    scrollbarOpacity: 0,
    viewportY: 0,
    lastCursorY: 0,
    renderer: { render: vi.fn() },
    wasmTerm: { getCursor: () => ({ y: 0 }) },
    cursorMoveEmitter: { fire: vi.fn() },
  }) as SchedulerHarness
}

describe('ghostty demand render scheduler patch', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('coalesces visible requests and preserves a requested full repaint', () => {
    const callbacks = new Map<number, FrameCallback>()
    let nextFrame = 1
    vi.stubGlobal('requestAnimationFrame', (callback: FrameCallback) => {
      const id = nextFrame++
      callbacks.set(id, callback)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id))
    const terminal = createHarness()

    terminal.requestRender()
    terminal.requestRender(true)

    expect(callbacks.size).toBe(1)
    expect(terminal.getRenderStats()).toEqual({
      parsedWrites: 7,
      renderRequests: 2,
      renderFrames: 0,
      fullRenderFrames: 0,
      paused: false,
      pendingFrame: true,
    })

    const [id, callback] = [...callbacks][0]!
    callbacks.delete(id)
    callback(0)

    expect(terminal.renderer.render).toHaveBeenCalledOnce()
    expect(terminal.renderer.render).toHaveBeenCalledWith(
      terminal.wasmTerm,
      true,
      0,
      terminal,
      0,
    )
    expect(terminal.getRenderStats().renderFrames).toBe(1)
    expect(terminal.getRenderStats().fullRenderFrames).toBe(1)
    expect(callbacks.size).toBe(0)
  })

  it('cancels presentation while hidden and schedules exactly one full reveal frame', () => {
    const callbacks = new Map<number, FrameCallback>()
    let nextFrame = 1
    const cancelAnimationFrame = vi.fn((id: number) => callbacks.delete(id))
    vi.stubGlobal('requestAnimationFrame', (callback: FrameCallback) => {
      const id = nextFrame++
      callbacks.set(id, callback)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame)
    const terminal = createHarness()

    terminal.requestRender()
    terminal.setRenderPaused(true)
    terminal.requestRender()
    terminal.requestRender()

    expect(cancelAnimationFrame).toHaveBeenCalledOnce()
    expect(callbacks.size).toBe(0)
    expect(terminal.getRenderStats()).toMatchObject({
      renderRequests: 3,
      renderFrames: 0,
      fullRenderFrames: 0,
      paused: true,
      pendingFrame: false,
    })

    terminal.setRenderPaused(false)

    expect(callbacks.size).toBe(1)
    const [id, callback] = [...callbacks][0]!
    callbacks.delete(id)
    callback(0)

    expect(terminal.renderer.render).toHaveBeenCalledOnce()
    expect(terminal.renderer.render).toHaveBeenCalledWith(
      terminal.wasmTerm,
      true,
      0,
      terminal,
      0,
    )
    expect(terminal.getRenderStats()).toMatchObject({
      renderRequests: 4,
      renderFrames: 1,
      fullRenderFrames: 1,
      paused: false,
      pendingFrame: false,
    })
  })

  it('cancels a pending frame on disposal and ignores late requests', () => {
    const callbacks = new Map<number, FrameCallback>()
    let nextFrame = 1
    const cancelAnimationFrame = vi.fn((id: number) => callbacks.delete(id))
    vi.stubGlobal('requestAnimationFrame', (callback: FrameCallback) => {
      const id = nextFrame++
      callbacks.set(id, callback)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame)
    const terminal = createHarness()
    const disposable = { dispose: vi.fn() }
    Object.assign(terminal, {
      addons: [],
      cleanupComponents: vi.fn(),
      dataEmitter: disposable,
      resizeEmitter: disposable,
      bellEmitter: disposable,
      selectionChangeEmitter: disposable,
      keyEmitter: disposable,
      titleChangeEmitter: disposable,
      scrollEmitter: disposable,
      renderEmitter: disposable,
      cursorMoveEmitter: disposable,
    })

    terminal.requestRender()
    ;(terminal as unknown as Terminal).dispose()
    terminal.requestRender(true)

    expect(cancelAnimationFrame).toHaveBeenCalledOnce()
    expect(callbacks.size).toBe(0)
    expect(terminal.isDisposed).toBe(true)
    expect(terminal.isOpen).toBe(false)
    expect(terminal.renderer.render).not.toHaveBeenCalled()
    expect(terminal.renderRequests).toBe(1)
  })
})
