import type { BrowserWindow } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { measureCapacityReflow } from '../src/main/smoke/capacity-reflow'

describe('capacity reflow measurement lifecycle', () => {
  afterEach(() => vi.useRealTimers())

  it('completes a finite geometry sequence and restores the original window', async () => {
    vi.useFakeTimers()
    const window = fakeWindow()
    const measured = measureCapacityReflow(window.port)
    await vi.runAllTimersAsync()
    const report = await measured
    expect(report.samplesMs).toHaveLength(12)
    expect(new Set(report.columns).size).toBe(2)
    expect(window.size()).toEqual([1100, 800])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds an unresponsive renderer from main and restores geometry', async () => {
    vi.useFakeTimers()
    const window = fakeWindow()
    window.read.mockImplementation(() => new Promise(() => undefined))
    const failure = expect(measureCapacityReflow(window.port)).rejects.toThrow(
      'renderer did not respond',
    )
    await vi.advanceTimersByTimeAsync(5000)
    await failure
    expect(window.size()).toEqual([1100, 800])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves a renderer failure and clears the pending deadline', async () => {
    vi.useFakeTimers()
    const window = fakeWindow()
    window.read.mockRejectedValueOnce(new Error('renderer destroyed'))
    await expect(measureCapacityReflow(window.port)).rejects.toThrow('renderer destroyed')
    expect(vi.getTimerCount()).toBe(0)
  })
})

function fakeWindow() {
  let size = [1100, 800]
  const read = vi.fn(() => Promise.resolve(Math.floor(size[0]! / 10)))
  return {
    read,
    size: () => size,
    port: {
      webContents: { executeJavaScript: read },
      getContentSize: () => [...size],
      setContentSize: (width: number, height: number) => {
        size = [width, height]
      },
      isDestroyed: () => false,
    } as unknown as BrowserWindow,
  }
}
