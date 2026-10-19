import { expect, it, vi } from 'vitest'
import { fixture } from './fixtures/extension-guest'

it.each(['disabled', 'unknown', 'disposed', 'updater'] as const)(
  'diagnoses %s before allocating an extension guest',
  async (kind) => {
    const prepare = vi.fn(() => Promise.resolve())
    const f = fixture({ prepare })
    if (kind === 'disabled') f.active.clear()
    if (kind === 'disposed') await f.owner.dispose()
    try {
      await expect(
        f.owner.open(
          f.renderer,
          'installation',
          kind === 'unknown' ? 'missing' : 'reference',
          () => undefined,
          { updater: kind === 'updater' },
        ),
      ).rejects.toThrow(
        kind === 'disabled'
          ? 'Enable this extension'
          : kind === 'unknown'
            ? 'declares no view named missing'
            : kind === 'disposed'
              ? 'Extension views are unavailable'
              : 'declares no updater',
      )
      expect(prepare).not.toHaveBeenCalled()
      expect(f.owner.snapshot(f.renderer)).toEqual([])
      expect(f.publish).not.toHaveBeenCalled()
    } finally {
      await f.owner.dispose()
    }
  },
)
