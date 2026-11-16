import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import {
  EXTENSION_GUEST_REQUEST_MS,
  requestExtensionGuest,
} from '../src/main/smoke/extension-guest-request'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function guest(
  evaluate: (script: string) => Promise<unknown> = () => new Promise(() => undefined),
) {
  const events = new EventEmitter()
  let destroyed = false
  const port = {
    isDestroyed: () => destroyed,
    executeJavaScript: vi.fn(evaluate),
    once: events.once.bind(events),
    removeListener: events.removeListener.bind(events),
  } as unknown as Pick<
    WebContents,
    'executeJavaScript' | 'isDestroyed' | 'once' | 'removeListener'
  >
  return {
    port,
    events,
    destroy: () => {
      destroyed = true
      events.emit('destroyed')
    },
  }
}

describe('public extension smoke request lifetime', () => {
  it('settles a never-running guest evaluation at the existing two-second budget', async () => {
    expect(EXTENSION_GUEST_REQUEST_MS).toBe(2000)
    const g = guest()
    const outcome = requestExtensionGuest(g.port, 'top-context', 'context.read').catch(
      (error: unknown) => error,
    )
    await vi.advanceTimersByTimeAsync(EXTENSION_GUEST_REQUEST_MS - 1)
    expect(g.events.listenerCount('destroyed')).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await outcome).toMatchObject({
      message: 'Public extension request timed out: top-context',
    })
    expect(g.events.listenerCount('destroyed')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('rejects destruction immediately and releases the caller timer and listener', async () => {
    const g = guest()
    const outcome = requestExtensionGuest(g.port, 'top-context', 'context.read').catch(
      (error: unknown) => error,
    )
    g.destroy()
    expect(await outcome).toMatchObject({
      message: 'Public extension guest ended: top-context',
    })
    expect(g.events.listenerCount('destroyed')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('does not dispatch into an already destroyed guest', async () => {
    const g = guest()
    g.destroy()
    await expect(
      requestExtensionGuest(g.port, 'top-context', 'context.read'),
    ).rejects.toThrow('guest ended')
    expect(g.port.executeJavaScript).not.toHaveBeenCalled()
    expect(g.events.listenerCount('destroyed')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('rejects destruction before a fulfilled evaluation resumes in the caller', async () => {
    const g = guest(() => Promise.resolve({ ok: true }))
    const outcome = requestExtensionGuest(g.port, 'top-context', 'context.read').catch(
      (error: unknown) => error,
    )
    g.destroy()
    expect(await outcome).toMatchObject({
      message: 'Public extension guest ended: top-context',
    })
    expect(g.events.listenerCount('destroyed')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('preserves a successful result and ignores late completion after timeout', async () => {
    const value = { ok: true, value: { visible: true } }
    const accepted = guest(() => Promise.resolve(value))
    await expect(
      requestExtensionGuest(accepted.port, 'top-context', 'context.read'),
    ).resolves.toEqual(value)
    expect(accepted.events.listenerCount('destroyed')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    let complete: (value: unknown) => void = () => undefined
    const late = guest(
      () =>
        new Promise((resolve) => {
          complete = resolve
        }),
    )
    const outcome = requestExtensionGuest(late.port, 'top-context', 'context.read').catch(
      (error: unknown) => error,
    )
    await vi.advanceTimersByTimeAsync(EXTENSION_GUEST_REQUEST_MS)
    const failure: unknown = await outcome
    complete(value)
    expect(await outcome).toBe(failure)
    expect(failure).toBeInstanceOf(Error)
    expect(late.events.listenerCount('destroyed')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['reply', 'timeout', 'send-failure'])(
    'cleans the actual guest script subscription on %s',
    async (mode) => {
      let listener: (message: unknown) => void = () => undefined
      const unsubscribe = vi.fn()
      const g = guest(
        (script) =>
          runInNewContext(script, {
            window: {
              hvirExtension: {
                onMessage: (next: typeof listener) => {
                  listener = next
                  return unsubscribe
                },
                send: () => {
                  if (mode === 'send-failure') throw new Error('fixture send failed')
                  if (mode === 'reply')
                    listener({ kind: 'result', id: 'top-context', ok: true })
                },
              },
            },
            setTimeout,
            clearTimeout,
          }) as Promise<unknown>,
      )
      const outcome = requestExtensionGuest(g.port, 'top-context', 'context.read').catch(
        (error: unknown) => error,
      )
      if (mode === 'timeout')
        await vi.advanceTimersByTimeAsync(EXTENSION_GUEST_REQUEST_MS)
      const result: unknown = await outcome
      if (mode === 'reply') expect(result).toMatchObject({ ok: true })
      else expect(result).toHaveProperty('message')
      expect(unsubscribe).toHaveBeenCalledOnce()
      expect(g.events.listenerCount('destroyed')).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    },
  )
})
