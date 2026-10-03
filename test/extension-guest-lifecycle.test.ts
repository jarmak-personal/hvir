import { describe, expect, it, vi } from 'vitest'
import { ExtensionGuestLifecycle } from '../src/main/extensions/guest-lifecycle'

function deferred() {
  let resolve!: () => void
  let reject!: (reason: Error) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe('bounded extension engine lifecycle', () => {
  it('retains initial hidden visibility and coalesces rapid changes behind one engine operation', async () => {
    const first = deferred()
    const apply = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined)
    const active = vi.fn()
    const failed = vi.fn()
    const lifecycle = new ExtensionGuestLifecycle(apply, active, failed)
    lifecycle.setVisible(false)
    for (let index = 0; index < 100; index++) lifecycle.setVisible(index % 2 === 0)
    lifecycle.setVisible(true)
    expect(apply.mock.calls).toEqual([['frozen']])
    expect(lifecycle.isActive).toBe(false)
    first.resolve()
    await vi.waitFor(() => expect(lifecycle.isActive).toBe(true))
    expect(apply.mock.calls).toEqual([['frozen'], ['active']])
    expect(active).toHaveBeenCalledTimes(1)
    expect(failed).not.toHaveBeenCalled()
    lifecycle.dispose()
  })

  it.each(['resolve', 'reject'] as const)(
    'close/disable during a pending transition ignores late %s and schedules no successor',
    async (completion) => {
      const pending = deferred()
      const apply = vi.fn(() => pending.promise)
      const active = vi.fn()
      const failed = vi.fn()
      const lifecycle = new ExtensionGuestLifecycle(apply, active, failed)
      lifecycle.setVisible(true)
      lifecycle.setVisible(false)
      lifecycle.dispose()
      lifecycle.dispose()
      lifecycle.setVisible(true)
      if (completion === 'resolve') pending.resolve()
      else pending.reject(new Error('Guest disappeared'))
      await Promise.resolve()
      await Promise.resolve()
      expect(lifecycle.isActive).toBe(false)
      expect(apply).toHaveBeenCalledTimes(1)
      expect(active).not.toHaveBeenCalled()
      expect(failed).not.toHaveBeenCalled()
    },
  )

  it('uses the same engine driver for finite hidden work and freezes after its final admission ends', async () => {
    const apply = vi.fn(() => Promise.resolve())
    const lifecycle = new ExtensionGuestLifecycle(apply, vi.fn(), vi.fn())
    lifecycle.setVisible(false)
    await vi.waitFor(() => expect(apply).toHaveBeenLastCalledWith('frozen'))
    lifecycle.setAdmittedWork(true)
    await vi.waitFor(() => expect(lifecycle.isActive).toBe(true))
    lifecycle.setVisible(false)
    await vi.waitFor(() => expect(lifecycle.isActive).toBe(true))
    lifecycle.setAdmittedWork(false)
    await vi.waitFor(() => expect(apply).toHaveBeenLastCalledWith('frozen'))
    expect(lifecycle.isActive).toBe(false)
    lifecycle.dispose()
    lifecycle.setAdmittedWork(true)
    expect(lifecycle.isActive).toBe(false)
  })

  it.each(['refusal', 'timeout'] as const)(
    'fails closed on engine %s',
    async (condition) => {
      vi.useFakeTimers()
      try {
        const pending = deferred()
        const failed = vi.fn()
        const lifecycle = new ExtensionGuestLifecycle(
          () => pending.promise,
          vi.fn(),
          failed,
        )
        lifecycle.setVisible(true)
        if (condition === 'refusal')
          pending.reject(new Error('Unsupported engine command'))
        await vi.advanceTimersByTimeAsync(10_001)
        expect(failed).toHaveBeenCalledTimes(1)
        expect(failed).toHaveBeenCalledWith(
          condition === 'timeout' ? 'timeout' : 'refusal',
        )
        expect(lifecycle.isActive).toBe(false)
        lifecycle.setVisible(true)
        pending.resolve()
        await Promise.resolve()
        expect(failed).toHaveBeenCalledTimes(1)
      } finally {
        vi.useRealTimers()
      }
    },
  )

  it('does not classify an external refusal as the owned transition timeout', async () => {
    const failed = vi.fn()
    const lifecycle = new ExtensionGuestLifecycle(
      () => Promise.reject(new Error('Guest lifecycle timed out')),
      vi.fn(),
      failed,
    )
    lifecycle.setVisible(true)
    await vi.waitFor(() => expect(failed).toHaveBeenCalledWith('refusal'))
    expect(lifecycle.isActive).toBe(false)
  })
})

describe('engine visibility invalidation', () => {
  it('reapplies an unchanged target after a native lifecycle event without retaining a queue', async () => {
    const pending = deferred()
    const apply = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(undefined)
    const lifecycle = new ExtensionGuestLifecycle(apply, vi.fn(), vi.fn())
    lifecycle.setVisible(false)
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    lifecycle.setVisible(false)
    for (let index = 0; index < 100; index++) lifecycle.setVisible(false)
    expect(apply).toHaveBeenCalledTimes(2)
    pending.resolve()
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(3))
    expect(apply.mock.calls).toEqual([['frozen'], ['frozen'], ['frozen']])
    lifecycle.dispose()
  })
})
