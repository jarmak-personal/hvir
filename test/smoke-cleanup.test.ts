import { describe, expect, it, onTestFinished, vi } from 'vitest'

import { SmokeCleanup } from '../src/main/smoke/cleanup'

describe('SmokeCleanup', () => {
  it('disposes in reverse order and is idempotent', async () => {
    const order: string[] = []
    const cleanup = new SmokeCleanup()
    cleanup.defer('first', () => {
      order.push('first')
    })
    cleanup.defer('second', async () => {
      await Promise.resolve()
      order.push('second')
    })

    await cleanup.run()
    await cleanup.run()

    expect(order).toEqual(['second', 'first'])
  })

  it('continues cleanup after a disposer fails', async () => {
    const survivor = vi.fn()
    const cleanup = new SmokeCleanup()
    cleanup.defer('survivor', survivor)
    cleanup.defer('failure', () => {
      throw new Error('fixture failure')
    })

    await expect(cleanup.run()).rejects.toThrow('Electron smoke cleanup failed')
    expect(survivor).toHaveBeenCalledOnce()
  })

  it('reports only resources whose disposal completed', async () => {
    const disposed: string[] = []
    const cleanup = new SmokeCleanup((name) => disposed.push(name))
    cleanup.defer('completed', () => undefined)
    cleanup.defer('failed', () => {
      throw new Error('fixture failure')
    })

    await expect(cleanup.run()).rejects.toThrow('Electron smoke cleanup failed')
    expect(disposed).toEqual(['completed'])
  })

  it('bounds a stalled disposer and continues through remaining cleanup', async () => {
    vi.useFakeTimers()
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const survivor = vi.fn()
    const failed: string[] = []
    const cleanup = new SmokeCleanup(undefined, {
      taskTimeoutMs: 25,
      onFailure: (name) => failed.push(name),
    })
    cleanup.defer('survivor', survivor)
    cleanup.defer('stalled', () => new Promise<void>(() => undefined))
    const result = cleanup.run()
    const failure = expect(result).rejects.toThrow('Electron smoke cleanup failed')

    await vi.advanceTimersByTimeAsync(25)

    await failure
    expect(failed).toEqual(['stalled'])
    expect(survivor).toHaveBeenCalledOnce()
  })
})
