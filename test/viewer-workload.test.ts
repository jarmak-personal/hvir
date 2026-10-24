import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SmokeFailureCheckpoint } from '../src/main/smoke/failure-evidence.mts'
import { localPath } from '../src/shared'
import { verifyViewerWorkload } from '../src/main/smoke/viewer-workload'
import { DEFAULT_VIEWER_POSITION_OPERATION_TIMING } from '../src/main/smoke/viewer-position-operation'

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})
function windowBoundary(executeJavaScript: ReturnType<typeof vi.fn>) {
  const sendInputEvent = vi.fn()
  const window = {
    isDestroyed: () => false,
    webContents: { executeJavaScript, sendInputEvent },
  } as unknown as BrowserWindow
  return { window, sendInputEvent }
}

describe('dense viewer smoke operation lifetime', () => {
  it('bounds an unresponsive renderer in main and stops native input on timeout', async () => {
    const { window, sendInputEvent } = windowBoundary(
      vi.fn(() => new Promise(() => undefined)),
    )
    const checkpoint = vi.fn<(checkpoint: SmokeFailureCheckpoint) => void>()
    const operation = verifyViewerWorkload(window, localPath('/repo'), checkpoint)
    const rejection = expect(operation).rejects.toThrow(
      'viewer-position-workload-awaiting timed out',
    )
    await vi.advanceTimersByTimeAsync(
      DEFAULT_VIEWER_POSITION_OPERATION_TIMING.operationTimeoutMs,
    )
    await rejection
    expect(checkpoint.mock.calls.map(([value]) => value)).toEqual([
      'viewer-position-workload-awaiting',
    ])
    expect(sendInputEvent).toHaveBeenCalled()
    const calls = sendInputEvent.mock.calls.length
    await vi.advanceTimersByTimeAsync(1000)
    expect(sendInputEvent).toHaveBeenCalledTimes(calls)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('records completion and releases input after a successful renderer observation', async () => {
    const { window } = windowBoundary(vi.fn().mockResolvedValue([]))
    const checkpoint = vi.fn<(checkpoint: SmokeFailureCheckpoint) => void>()
    await verifyViewerWorkload(window, localPath('/repo'), checkpoint)
    expect(checkpoint.mock.calls.map(([value]) => value)).toEqual([
      'viewer-position-workload-awaiting',
      'viewer-position-workload-ready',
    ])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases native input after partial startup failure', async () => {
    const { window } = windowBoundary(
      vi.fn(() => {
        throw new Error('renderer destroyed')
      }),
    )
    const checkpoint = vi.fn<(checkpoint: SmokeFailureCheckpoint) => void>()
    await expect(
      verifyViewerWorkload(window, localPath('/repo'), checkpoint),
    ).rejects.toThrow('renderer destroyed')
    expect(checkpoint.mock.calls.map(([value]) => value)).toEqual([
      'viewer-position-workload-awaiting',
    ])
    expect(vi.getTimerCount()).toBe(0)
  })
})
