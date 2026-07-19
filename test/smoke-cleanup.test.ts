import { describe, expect, it, vi } from 'vitest'

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
})
