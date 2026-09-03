import { describe, expect, it, vi } from 'vitest'

import type { SmokeFailureCheckpoint } from '../src/main/smoke/failure-evidence.mts'
import {
  collectViewerPositionFailureState,
  runViewerPositionOperation,
  type ViewerPositionOperationTiming,
} from '../src/main/smoke/viewer-position-operation'

const timing: ViewerPositionOperationTiming = {
  operationTimeoutMs: 50,
  diagnosisTimeoutMs: 20,
}

describe('viewer-position operation lifecycle', () => {
  it('publishes awaiting and ready around a completed operation', async () => {
    const checkpoints: SmokeFailureCheckpoint[] = []

    await expect(
      runViewerPositionOperation({
        awaiting: 'viewer-position-virtualization-awaiting',
        ready: 'viewer-position-virtualization-ready',
        checkpoint: (checkpoint) => checkpoints.push(checkpoint),
        execute: () => 'complete',
        timing,
      }),
    ).resolves.toBe('complete')

    expect(checkpoints).toEqual([
      'viewer-position-virtualization-awaiting',
      'viewer-position-virtualization-ready',
    ])
  })

  it('fails a pending operation at its awaiting checkpoint', async () => {
    vi.useFakeTimers()
    try {
      const checkpoints: SmokeFailureCheckpoint[] = []
      const operation = runViewerPositionOperation({
        awaiting: 'viewer-position-refresh-awaiting',
        ready: 'viewer-position-refresh-ready',
        checkpoint: (checkpoint) => checkpoints.push(checkpoint),
        execute: () => new Promise<never>(() => undefined),
        timing,
      })
      const rejection = expect(operation).rejects.toThrow(
        'viewer-position-refresh-awaiting timed out after 50ms',
      )

      await vi.advanceTimersByTimeAsync(timing.operationTimeoutMs)

      await rejection
      expect(checkpoints).toEqual(['viewer-position-refresh-awaiting'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds an unavailable renderer failure-state read', async () => {
    vi.useFakeTimers()
    try {
      const state = collectViewerPositionFailureState(
        () => new Promise<never>(() => undefined),
        timing,
      )

      await vi.advanceTimersByTimeAsync(timing.diagnosisTimeoutMs)

      await expect(state).resolves.toEqual({ unavailable: true })
    } finally {
      vi.useRealTimers()
    }
  })
})
