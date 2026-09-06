import { createContext, runInContext } from 'node:vm'

import type { BrowserWindow } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { verifyCapacityLivePresentationUpdate } from '../src/main/smoke/capacity-live-presentation'
import type { PtySupervisor } from '../src/main/pty/pty-supervisor'

afterEach(() => vi.useRealTimers())

function fixture(suspendRendererTimers = false) {
  class Element {}
  class Canvas extends Element {}
  class Button extends Element {
    click() {
      throw new Error('private callback payload must not escape')
    }
  }
  const stats = {
    fontLigatures: true,
    renderFrames: 1,
    cols: 80,
    lastFrame: { shapedRuns: 0, shapedCells: 0, maxRunCells: 0 },
  }
  const surfaces = Array.from({ length: 12 }, (_, index) => {
    const canvas = new Canvas()
    const engine = Object.assign(new Element(), {
      __hvirTerminalCursor: { defaults: {} },
      __hvirTerminalPerformance: stats,
      querySelector: () => canvas,
    })
    return Object.assign(new Element(), {
      index,
      querySelector: () => engine,
      getAttribute: () => String(index),
    })
  })
  const clearRendererTimer = vi.fn(clearTimeout)
  const document = {
    visibilityState: 'visible',
    hasFocus: () => true,
    querySelectorAll: () => surfaces,
    querySelector: () => new Button(),
  }
  const context = createContext({
    Date,
    setTimeout: suspendRendererTimers ? vi.fn(() => 99) : setTimeout,
    clearTimeout: clearRendererTimer,
    HTMLElement: Element,
    HTMLCanvasElement: Canvas,
    HTMLButtonElement: Button,
    getComputedStyle: (surface: { index: number }) => ({
      visibility: surface.index === 0 ? 'visible' : 'hidden',
    }),
    document,
  })
  const executeJavaScript = vi.fn((script: string) =>
    Promise.resolve(runInContext(script, context)),
  )
  const win = {
    webContents: { executeJavaScript } as unknown as BrowserWindow['webContents'],
  }
  const supervisor = {
    list: () => Array.from({ length: 12 }, (_, id) => ({ id, ownerId: 1 })),
    write: vi.fn(),
  } as unknown as Pick<PtySupervisor, 'list' | 'write'>
  return {
    stats,
    context,
    document,
    executeJavaScript,
    win,
    supervisor,
    clearRendererTimer,
  }
}

describe('capacity live presentation failure ownership', () => {
  it('rejects a scheduled callback exception at its fixed phase and drains its timers', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const result = verifyCapacityLivePresentationUpdate(f.win, f.supervisor)
    const rejected = expect(result).rejects.toThrow(
      '"phase":"shaping","category":"callback-failed"',
    )
    Object.assign(f.stats.lastFrame, { shapedRuns: 1, shapedCells: 3, maxRunCells: 3 })
    await vi.advanceTimersByTimeAsync(20)
    await rejected
    expect(f.supervisor.write).toHaveBeenCalledTimes(12)
    expect(f.context.__hvirCapacityLivePresentation).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
    await expect(result).rejects.not.toThrow('private callback payload')
  })

  it('bounds a responsive renderer probe and cancels polls after the unchanged outer deadline', async () => {
    vi.useFakeTimers()
    const f = fixture(true)
    const result = verifyCapacityLivePresentationUpdate(f.win, f.supervisor)
    const rejected = expect(result).rejects.toThrow(
      '"phase":"shaping","category":"pending","visible":true,"focused":true,"surfaces":12',
    )
    await vi.advanceTimersByTimeAsync(22_000)
    await rejected
    expect(f.clearRendererTimer).toHaveBeenCalledWith(99)
    expect(f.context.__hvirCapacityLivePresentation).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds diagnostic execution when neither the scenario nor the renderer probe responds', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.executeJavaScript.mockImplementation(() => new Promise(() => undefined))
    const rejected = expect(
      verifyCapacityLivePresentationUpdate(f.win, f.supervisor),
    ).rejects.toThrow('"category":"renderer-unavailable"')
    await vi.advanceTimersByTimeAsync(23_000)
    await rejected
    expect(f.executeJavaScript).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('drains renderer polls even when collecting probe observations throws', async () => {
    vi.useFakeTimers()
    const f = fixture(true)
    f.document.hasFocus = () => {
      throw new Error('private observation')
    }
    const rejected = expect(
      verifyCapacityLivePresentationUpdate(f.win, f.supervisor),
    ).rejects.toThrow('"category":"renderer-unavailable"')
    await vi.advanceTimersByTimeAsync(22_000)
    await rejected
    expect(f.clearRendererTimer).toHaveBeenCalledWith(99)
    expect(f.context.__hvirCapacityLivePresentation).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('discards unreviewed renderer probe fields and values', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.executeJavaScript
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce({
        phase: 'private phase',
        category: 'private category',
        visible: 'private visibility',
        focused: false,
        surfaces: 1000,
        body: 'private body',
      })
    const rejected = expect(
      verifyCapacityLivePresentationUpdate(f.win, f.supervisor),
    ).rejects.toThrow(
      '"phase":null,"category":"renderer-unavailable","visible":null,"focused":false,"surfaces":null',
    )
    await vi.advanceTimersByTimeAsync(22_000)
    await rejected
    expect(vi.getTimerCount()).toBe(0)
  })
})
