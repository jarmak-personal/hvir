import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
afterEach(() => vi.useRealTimers())
it('uses newest visibility, resumes current time and disposes all ordinary refresh work', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  const listeners = new Set<(message: unknown) => void>()
  const events = new Map<string, () => void>()
  const clock = { textContent: '', dateTime: '' },
    status = { textContent: '' }
  const unbind = vi.fn()
  const emit = (message: unknown) => {
    for (const listener of listeners) listener(message)
  }
  runInNewContext(readFileSync('packages/extension-authoring/clock/clock.js', 'utf8'), {
    window: {
      hvirExtension: {
        send: vi.fn(),
        onMessage: (listener: (message: unknown) => void) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
      hvirUI: { bindPresentation: () => unbind },
      setInterval,
      clearInterval,
      addEventListener: (name: string, callback: () => void) =>
        events.set(name, callback),
      removeEventListener: (name: string) => events.delete(name),
    },
    document: { getElementById: (id: string) => (id === 'clock' ? clock : status) },
    Date,
  })
  emit({ kind: 'hello', contract: '1.0' })
  emit({ kind: 'context', context: { visible: false } })
  emit({ kind: 'result', id: 'clock-context', ok: true, value: { visible: true } })
  expect(vi.getTimerCount()).toBe(0)
  expect(clock.dateTime).toBe('')
  emit({ kind: 'context', context: { visible: true } })
  expect(clock.dateTime).toBe('2026-01-01T00:00:00.000Z')
  await vi.advanceTimersByTimeAsync(1000)
  expect(clock.dateTime).toBe('2026-01-01T00:00:01.000Z')
  emit({ kind: 'context', context: { visible: false } })
  await vi.advanceTimersByTimeAsync(5000)
  expect(clock.dateTime).toBe('2026-01-01T00:00:01.000Z')
  emit({ kind: 'context', context: { visible: true } })
  expect(clock.dateTime).toBe('2026-01-01T00:00:06.000Z')
  emit({ kind: 'revoked' })
  emit({ kind: 'context', context: { visible: true } })
  expect(vi.getTimerCount()).toBe(0)
  expect(listeners.size).toBe(0)
  expect(events.size).toBe(0)
  expect(unbind).toHaveBeenCalledTimes(1)
})
