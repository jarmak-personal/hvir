import { describe, expect, it, vi } from 'vitest'

import {
  HarnessUsageReadScheduler,
  MAX_CONCURRENT_HARNESS_USAGE_READS,
  MAX_QUEUED_HARNESS_USAGE_READS,
} from '../src/main/harness/harness-usage-read-scheduler'

describe('HarnessUsageReadScheduler', () => {
  it('bounds concurrent reads and drains its bounded queue', async () => {
    const scheduler = new HarnessUsageReadScheduler()
    const releases: Array<() => void> = []
    let running = 0
    let peak = 0
    const tasks = Array.from({ length: 20 }, (_, index) =>
      scheduler.schedule(new AbortController().signal, async () => {
        running += 1
        peak = Math.max(peak, running)
        await new Promise<void>((resolve) => releases.push(resolve))
        running -= 1
        return index
      }),
    )

    await vi.waitFor(() =>
      expect(releases).toHaveLength(MAX_CONCURRENT_HARNESS_USAGE_READS),
    )
    let released = 0
    while (released < tasks.length) {
      await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0))
      const batch = releases.splice(0)
      released += batch.length
      for (const release of batch) release()
    }

    await expect(Promise.all(tasks)).resolves.toHaveLength(20)
    expect(peak).toBe(MAX_CONCURRENT_HARNESS_USAGE_READS)
  })

  it('rejects overflow rather than retaining an unbounded queue', async () => {
    const scheduler = new HarnessUsageReadScheduler()
    const releases: Array<() => void> = []
    const tasks = Array.from(
      { length: MAX_CONCURRENT_HARNESS_USAGE_READS + MAX_QUEUED_HARNESS_USAGE_READS },
      () =>
        scheduler.schedule(
          new AbortController().signal,
          () => new Promise<void>((resolve) => releases.push(resolve)),
        ),
    )
    await expect(
      scheduler.schedule(new AbortController().signal, () => Promise.resolve()),
    ).rejects.toThrow('queue is full')
    let released = 0
    while (released < tasks.length) {
      await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0))
      const batch = releases.splice(0)
      released += batch.length
      for (const release of batch) release()
    }
    await Promise.all(tasks)
  })

  it('releases an aborted queued read before active work completes', async () => {
    const scheduler = new HarnessUsageReadScheduler()
    const releases: Array<() => void> = []
    const active = Array.from({ length: MAX_CONCURRENT_HARNESS_USAGE_READS }, () =>
      scheduler.schedule(
        new AbortController().signal,
        () => new Promise<void>((resolve) => releases.push(resolve)),
      ),
    )
    const controller = new AbortController()
    const queuedRead = vi.fn(() => Promise.resolve())
    const queued = scheduler.schedule(controller.signal, queuedRead)
    controller.abort()

    await expect(queued).rejects.toBeDefined()
    expect(queuedRead).not.toHaveBeenCalled()
    for (const release of releases) release()
    await Promise.all(active)
  })
})
