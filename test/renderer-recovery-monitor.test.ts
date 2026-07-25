import { describe, expect, it, vi } from 'vitest'

import {
  RendererRecoveryMonitor,
  type RendererRecoveryAttempt,
  type RendererRecoveryFailure,
} from '../src/main/window/renderer-recovery-monitor'

const FIRST = { id: 7, generation: 2 }
const REPLACEMENT = { id: 7, generation: 3 }

function fixture() {
  const scheduled: { task: () => void; canceled: boolean }[] = []
  const succeeded = vi.fn<(attempt: RendererRecoveryAttempt) => void>()
  const failed =
    vi.fn<(attempt: RendererRecoveryAttempt, failure: RendererRecoveryFailure) => void>()
  const monitor = new RendererRecoveryMonitor({
    deadlineMs: 50,
    schedule: (task) => {
      const timer = { task, canceled: false }
      scheduled.push(timer)
      return () => {
        timer.canceled = true
      }
    },
    onSucceeded: succeeded,
    onFailed: failed,
  })
  return { monitor, scheduled, succeeded, failed }
}

describe('RendererRecoveryMonitor', () => {
  it('requires the exact replacement load and readiness handshake', () => {
    const { monitor, scheduled, succeeded } = fixture()
    const attempt = monitor.start(REPLACEMENT)

    monitor.documentLoaded(FIRST)
    monitor.rendererReady(FIRST)
    monitor.rendererReady(REPLACEMENT)
    expect(succeeded).not.toHaveBeenCalled()

    monitor.documentLoaded(REPLACEMENT)
    monitor.documentLoaded(REPLACEMENT)

    expect(succeeded).toHaveBeenCalledOnce()
    expect(succeeded).toHaveBeenCalledWith(attempt)
    expect(scheduled[0]?.canceled).toBe(true)
  })

  it('fails a load, permits a later retry, and rejects old completion', () => {
    const { monitor, failed, succeeded } = fixture()
    const firstAttempt = monitor.start(FIRST)!

    monitor.fail(FIRST, 'document-load-failed')
    expect(failed).toHaveBeenCalledWith(firstAttempt, 'document-load-failed')
    expect(monitor.isFailed(firstAttempt)).toBe(true)

    const retry = monitor.start(REPLACEMENT)
    monitor.documentLoaded(FIRST)
    monitor.rendererReady(FIRST)
    monitor.documentLoaded(REPLACEMENT)
    monitor.rendererReady(REPLACEMENT)

    expect(succeeded).toHaveBeenCalledWith(retry)
    expect(monitor.isFailed(firstAttempt)).toBe(false)
  })

  it('bounds readiness and ignores a stale timer after retry', () => {
    const { monitor, scheduled, failed } = fixture()
    const firstAttempt = monitor.start(FIRST)!
    const firstTimer = scheduled[0]!

    firstTimer.task()
    firstTimer.task()
    expect(failed).toHaveBeenCalledOnce()
    expect(failed).toHaveBeenCalledWith(firstAttempt, 'readiness-timeout')

    monitor.start(REPLACEMENT)
    firstTimer.task()
    expect(failed).toHaveBeenCalledOnce()
  })

  it('cancels pending work idempotently on close and shutdown', () => {
    const { monitor, scheduled, failed, succeeded } = fixture()
    monitor.start(REPLACEMENT)

    monitor.close()
    monitor.close()
    scheduled[0]?.task()
    monitor.documentLoaded(REPLACEMENT)
    monitor.rendererReady(REPLACEMENT)
    monitor.dispose()
    monitor.dispose()

    expect(scheduled[0]?.canceled).toBe(true)
    expect(failed).not.toHaveBeenCalled()
    expect(succeeded).not.toHaveBeenCalled()
    expect(monitor.start(REPLACEMENT)).toBeUndefined()
  })
})
