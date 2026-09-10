import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { DocumentReviewDriver } from '../src/main/smoke/document-review-driver'

function fixture(timeoutMs = 80) {
  const events = new EventEmitter()
  const executeJavaScript = vi
    .fn<(script: string) => Promise<unknown>>()
    .mockResolvedValue({ ok: true })
  const webContents = Object.assign(events, {
    executeJavaScript,
    isDestroyed: () => false,
  })
  const window = { webContents, reload: vi.fn(), destroy: vi.fn() }
  const checkpoint = vi.fn()
  const driver = new DocumentReviewDriver(
    window as unknown as BrowserWindow,
    checkpoint,
    timeoutMs,
  )
  const signals = ['SIGHUP', 'SIGINT', 'SIGTERM'] as const
  const initialListeners = signals.map((signal) => process.listenerCount(signal))
  const expectReleased = () => {
    expect(events.eventNames()).toEqual([])
    expect(signals.map((signal) => process.listenerCount(signal))).toEqual(
      initialListeners,
    )
  }
  return { events, executeJavaScript, window, driver, checkpoint, expectReleased }
}

describe('document review smoke observations', () => {
  it('samples pending state until the named outcome and releases its lifetime', async () => {
    const f = fixture()
    f.executeJavaScript
      .mockResolvedValueOnce({ pending: true })
      .mockResolvedValueOnce({ ok: true, value: 42 })
    await expect(f.driver.evaluate('fixture-open', '({ ok: true })')).resolves.toBe(42)
    expect(f.checkpoint).toHaveBeenCalledWith('document-review: fixture-open')
    expect(f.executeJavaScript).toHaveBeenCalledTimes(2)
    f.expectReleased()
  })

  it('bounds a stalled renderer and makes a late sample inert', async () => {
    const f = fixture(20)
    f.executeJavaScript.mockReturnValue(new Promise(() => undefined))
    await expect(
      f.driver.evaluate('fixture-open', '(() => { act(); return { ok: true } })()'),
    ).rejects.toThrow('deadline exceeded: fixture-open')
    const act = vi.fn()
    runInNewContext(f.executeJavaScript.mock.calls[0]![0], {
      Date: { now: () => Number.MAX_SAFE_INTEGER },
      act,
    })
    expect(act).not.toHaveBeenCalled()
    f.expectReleased()
  })

  it.each(['destroyed', 'render-process-gone'] as const)(
    'rejects %s during an evaluation and releases listeners',
    async (event) => {
      const f = fixture()
      f.executeJavaScript.mockReturnValue(new Promise(() => undefined))
      const pending = f.driver.evaluate('prepared body wait', '({ pending: true })')
      const rejected = expect(pending).rejects.toThrow(
        'renderer exited: prepared body wait',
      )
      await Promise.resolve()
      f.events.emit(event)
      await rejected
      f.expectReleased()
    },
  )

  it('interrupts a wait without retaining process or renderer listeners', async () => {
    const f = fixture()
    f.executeJavaScript.mockReturnValue(new Promise(() => undefined))
    const before = new Set(process.listeners('SIGTERM'))
    const pending = f.driver.evaluate('fixture-open', '({ pending: true })')
    const rejected = expect(pending).rejects.toThrow('interrupted: fixture-open')
    for (const listener of process.listeners('SIGTERM'))
      if (!before.has(listener)) listener('SIGTERM')
    await rejected
    f.expectReleased()
  })

  it('keeps renderer error text out of diagnostic errors', async () => {
    const f = fixture()
    f.executeJavaScript.mockResolvedValue({
      ok: false,
      error: '/private/path SECRET=review-text',
    })
    await expect(f.driver.evaluate('fixture-open', '({ ok: true })')).rejects.toThrow(
      'document review condition failed: fixture-open',
    )
    f.expectReleased()
  })

  it('subscribes before reload and destruction and removes event waits after timeout', async () => {
    const f = fixture(20)
    f.window.reload.mockImplementation(() => {
      f.events.emit('did-finish-load')
    })
    await f.driver.reload()
    f.expectReleased()
    await expect(f.driver.destroy()).rejects.toThrow(
      'deadline exceeded: renderer-destroyed',
    )
    f.expectReleased()
    f.window.destroy.mockImplementation(() => {
      f.events.emit('destroyed')
    })
    await f.driver.destroy()
    f.expectReleased()
  })
})
