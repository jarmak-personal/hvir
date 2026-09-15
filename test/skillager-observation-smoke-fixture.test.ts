import { afterEach, expect, it, vi } from 'vitest'
import { skillagerObservationFixture } from '../src/main/smoke/skillager-observation-fixture'

afterEach(() => vi.useRealTimers())

it('holds only the named lane, reports entry, and releases failure for explicit retry', async () => {
  const fixture = skillagerObservationFixture(),
    hold = fixture.holdNext('library')
  try {
    const reading = fixture.wait('library', new AbortController().signal)
    const rejected = expect(reading).rejects.toMatchObject({ reason: 'unavailable' })
    expect(await hold.entered).toBe(true)
    await fixture.wait('project', new AbortController().signal)
    hold.release(true)
    await rejected
    await fixture.wait('library', new AbortController().signal)
  } finally {
    fixture.dispose()
  }
})

it('cancels only the waiter so a replacement read remains held until explicit failure', async () => {
  vi.useFakeTimers()
  const fixture = skillagerObservationFixture(),
    controller = new AbortController()
  const hold = fixture.holdNext('project')
  try {
    const reading = fixture.wait('project', controller.signal)
    const rejected = expect(reading).rejects.toMatchObject({ reason: 'cancelled' })
    expect(await hold.entered).toBe(true)
    controller.abort()
    await rejected
    expect(vi.getTimerCount()).toBe(1)
    let completed = false
    const replacement = fixture.wait('project', new AbortController().signal)
    const replacementRejected = expect(replacement).rejects.toMatchObject({
      reason: 'unavailable',
    })
    void replacement.then(
      () => {
        completed = true
      },
      () => {
        completed = true
      },
    )
    await Promise.resolve()
    expect(completed).toBe(false)
    hold.release(true)
    await replacementRejected
    expect(vi.getTimerCount()).toBe(0)
    await fixture.wait('project', new AbortController().signal)
  } finally {
    fixture.dispose()
  }
})

it('bounds unentered holds and disposes the timer and waiter after an aborted read', async () => {
  vi.useFakeTimers()
  const fixture = skillagerObservationFixture()
  try {
    const abandoned = fixture.holdNext('library')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await abandoned.entered).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    const hold = fixture.holdNext('project')
    await expect(fixture.wait('project', AbortSignal.abort())).rejects.toMatchObject({
      reason: 'cancelled',
    })
    const replacement = fixture.wait('project', new AbortController().signal)
    expect(await hold.entered).toBe(true)
    expect(vi.getTimerCount()).toBe(1)
    fixture.dispose()
    await replacement
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    fixture.dispose()
  }
})
