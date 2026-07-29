import { describe, expect, it, vi } from 'vitest'

import { createSmokeImagePasteFallback } from '../src/main/smoke/image-paste-fallback'

const OWNER = { id: 7, generation: 3 }

describe('smoke image-paste fallback', () => {
  it('forwards an owned native key without acquiring clipboard behavior', async () => {
    const write = vi.fn()
    const fallback = createSmokeImagePasteFallback({
      isOwnedBy: () => true,
      write,
    })

    await fallback.pasteOrForward('terminal-1', OWNER, '\x1b\x16')

    expect(write).toHaveBeenCalledExactlyOnceWith(
      'terminal-1',
      OWNER.id,
      '\x1b\x16',
      OWNER.generation,
    )
  })

  it('drops malformed or stale-owner requests', async () => {
    const write = vi.fn()
    const isOwnedBy = vi.fn(() => false)
    const fallback = createSmokeImagePasteFallback({ isOwnedBy, write })

    await fallback.pasteOrForward('terminal-1', OWNER, 'not-a-paste-key')
    await fallback.pasteOrForward('terminal-1', OWNER, '\x16')

    expect(isOwnedBy).toHaveBeenCalledOnce()
    expect(write).not.toHaveBeenCalled()
  })
})
