// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TerminalFitController } from '../src/renderer/src/terminal/ghostty-terminal-fit'

class ObservedResize {
  static readonly instances: ObservedResize[] = []

  readonly observe = vi.fn()
  readonly unobserve = vi.fn()
  readonly disconnect = vi.fn()

  constructor(private readonly callback: ResizeObserverCallback) {
    ObservedResize.instances.push(this)
  }

  emit(): void {
    this.callback([], this)
  }
}

describe('TerminalFitController presentation lifecycle', () => {
  let frames: Map<number, FrameRequestCallback>
  let nextFrame: number

  beforeEach(() => {
    vi.useFakeTimers()
    ObservedResize.instances.splice(0)
    frames = new Map()
    nextFrame = 1
    vi.stubGlobal('ResizeObserver', ObservedResize)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = nextFrame++
      frames.set(id, callback)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    document.body.replaceChildren()
  })

  it('keeps initialization fitting available while observation is suspended', () => {
    const fixture = terminalFixture(900, 400)
    const controller = new TerminalFitController(fixture.terminal)

    controller.fit()

    expect(fixture.resize).toHaveBeenCalledExactlyOnceWith(90, 20)
    expect(ObservedResize.instances).toHaveLength(0)
  })

  it('coalesces visible geometry into one settled fit and completion', () => {
    const fixture = terminalFixture(800, 480)
    const controller = new TerminalFitController(fixture.terminal)
    const settled = vi.fn()

    controller.resume(settled)
    const observer = ObservedResize.instances[0]!
    expect(observer.observe).toHaveBeenCalledExactlyOnceWith(fixture.element)
    setElementSize(fixture.element, 900, 400)
    observer.emit()
    observer.emit()

    vi.advanceTimersByTime(75)
    expect(frames).toHaveLength(1)
    runOnlyFrame(frames)

    expect(fixture.resize).toHaveBeenCalledExactlyOnceWith(90, 20)
    expect(settled).toHaveBeenCalledOnce()

    setElementSize(fixture.element, 1_000, 400)
    observer.emit()
    vi.advanceTimersByTime(75)
    runOnlyFrame(frames)

    expect(fixture.resize).toHaveBeenLastCalledWith(100, 20)
    expect(settled).toHaveBeenCalledOnce()
  })

  it('disconnects and rejects stale timer or frame work after suspension', () => {
    const fixture = terminalFixture(900, 400)
    const controller = new TerminalFitController(fixture.terminal)
    const settled = vi.fn()

    controller.resume(settled)
    const observer = ObservedResize.instances[0]!
    vi.advanceTimersByTime(75)
    const staleFrame = [...frames.values()][0]!

    controller.suspend()
    expect(observer.disconnect).toHaveBeenCalledOnce()
    expect(frames).toHaveLength(0)

    observer.emit()
    staleFrame(0)
    vi.advanceTimersByTime(1_000)

    expect(fixture.resize).not.toHaveBeenCalled()
    expect(settled).not.toHaveBeenCalled()
    expect(frames).toHaveLength(0)
  })

  it('creates a fresh observation and fit generation after resumption', () => {
    const fixture = terminalFixture(900, 400)
    const controller = new TerminalFitController(fixture.terminal)

    controller.resume()
    controller.suspend()
    controller.resume()

    expect(ObservedResize.instances).toHaveLength(2)
    vi.advanceTimersByTime(75)
    runOnlyFrame(frames)
    expect(fixture.resize).toHaveBeenCalledExactlyOnceWith(90, 20)

    controller.dispose()
    expect(ObservedResize.instances[1]?.disconnect).toHaveBeenCalledOnce()
  })
})

function terminalFixture(width: number, height: number) {
  const element = document.createElement('div')
  document.body.append(element)
  setElementSize(element, width, height)
  const resize = vi.fn((cols: number, rows: number) => {
    terminal.cols = cols
    terminal.rows = rows
  })
  const terminal = {
    cols: 80,
    rows: 24,
    element,
    renderer: { getMetrics: () => ({ width: 10, height: 20 }) },
    resize,
  }
  return { element, resize, terminal }
}

function setElementSize(element: HTMLElement, width: number, height: number): void {
  Object.defineProperties(element, {
    clientWidth: { configurable: true, value: width },
    clientHeight: { configurable: true, value: height },
  })
}

function runOnlyFrame(frames: Map<number, FrameRequestCallback>): void {
  expect(frames).toHaveLength(1)
  const [id, callback] = [...frames.entries()][0]!
  frames.delete(id)
  callback(0)
}
