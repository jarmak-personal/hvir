// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PRESENTATION_COLORS } from '../src/shared/presentation/tokens'

type Message = { kind: string; presentation?: unknown }
function fixture(reference = false) {
  document.body.innerHTML = reference
    ? readFileSync('packages/extension-reference/index.html', 'utf8')
        .split(/<body[^>]*>/)[1]!
        .split('</body>')[0]!
    : '<div id="list" role="listbox"></div>'
  const subscribers = new Set<(message: Message) => void>()
  const send = vi.fn()
  const bridge = {
    send,
    onMessage: vi.fn((callback: (message: Message) => void) => {
      subscribers.add(callback)
      return () => subscribers.delete(callback)
    }),
  }
  Object.assign(window, { hvirExtension: bridge })
  const context = createContext({ window, document, AbortController })
  runInContext(readFileSync('src/shared/presentation/guest-ui.js', 'utf8'), context)
  return { context, bridge, subscribers, send }
}

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('browser-local guest UI ownership', () => {
  it('owns one visible clock timer and cannot restart it after page teardown', () => {
    vi.useFakeTimers()
    const data = fixture(true)
    vi.spyOn(window, 'fetch').mockImplementation(() => new Promise(() => {}))
    runInContext(
      readFileSync('packages/extension-reference/reference.js', 'utf8'),
      data.context,
    )
    const callbacks = [...data.subscribers]
    for (const callback of callbacks)
      callback({ kind: 'context', context: { visible: true } } as Message)
    const clock = document.getElementById('clock-time') as HTMLTimeElement
    const first = clock.dateTime
    expect(first).toBeTruthy()
    expect(runInContext('timers.size', data.context)).toBe(1)
    for (const callback of callbacks)
      callback({ kind: 'context', context: { visible: true } } as Message)
    expect(runInContext('timers.size', data.context)).toBe(1)
    for (const callback of callbacks)
      callback({ kind: 'context', context: { visible: false } } as Message)
    expect(runInContext('timers.size', data.context)).toBe(0)
    const stopped = clock.dateTime
    window.dispatchEvent(new Event('pagehide'))
    for (const callback of callbacks)
      callback({ kind: 'context', context: { visible: true } } as Message)
    vi.advanceTimersByTime(3000)
    expect(clock.dateTime).toBe(stopped)
    expect(runInContext('timers.size', data.context)).toBe(0)
    expect(data.subscribers.size).toBe(0)
  })
  it('releases presentation subscriptions and rejects late DOM updates', () => {
    const data = fixture()
    const dispose = runInContext(
      'window.hvirUI.bindPresentation(window.hvirExtension)',
      data.context,
    ) as () => void
    const late = [...data.subscribers][0]!
    late({
      kind: 'presentation',
      presentation: {
        appearance: 'light',
        colors: PRESENTATION_COLORS.light,
        fontFamily: 'system-ui',
        monospaceFontFamily: 'monospace',
        interfaceScale: 1.2,
      },
    })
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(
      document.documentElement.style.getPropertyValue('--hvir-interface-scale'),
    ).toBe('1.2')
    dispose()
    dispose()
    expect(data.subscribers.size).toBe(0)
    late({ kind: 'presentation', presentation: { appearance: 'dark', colors: {} } })
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('navigates only owned enabled visible list rows and removes handlers', () => {
    const data = fixture()
    const list = document.getElementById('list')!
    list.innerHTML =
      '<button role="option" id="first">First</button><button role="option" disabled>Disabled</button><button role="option" hidden>Hidden</button><button role="option" style="display:none">Invisible</button><div><button role="option">Nested</button></div><button role="option" id="last">Last</button>'
    const select = vi.fn()
    Object.assign(window, { select })
    const binding = runInContext(
      'window.hvirUI.bindList(document.getElementById("list"), window.select)',
      data.context,
    ) as { dispose(): void; refresh(): void }
    const first = document.getElementById('first')!
    const last = document.getElementById('last')!
    first.focus()
    const styleReads = vi.spyOn(window, 'getComputedStyle')
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(styleReads.mock.calls.filter(([element]) => element === list)).toHaveLength(1)
    expect(styleReads.mock.calls.filter(([element]) => element === first)).toHaveLength(1)
    expect(document.activeElement).toBe(last)
    expect(last.getAttribute('aria-selected')).toBe('true')
    expect(select).toHaveBeenCalledOnce()
    list
      .querySelector(':scope > div > button')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(select).toHaveBeenCalledOnce()
    list
      .querySelector(':scope > div > button')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    list
      .querySelector('button:disabled')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    list.style.display = 'none'
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    expect(select).toHaveBeenCalledOnce()
    list.style.display = ''
    binding.dispose()
    binding.dispose()
    binding.refresh()
    first.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    expect(select).toHaveBeenCalledOnce()
    expect(last.getAttribute('aria-selected')).toBe('true')
  })

  it('aborts superseded catalog loads and preserves truthful error state after searching', async () => {
    const data = fixture(true)
    const pending: {
      signal: AbortSignal
      resolve(value: unknown): void
      reject(reason: unknown): void
    }[] = []
    vi.spyOn(window, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((resolve, reject) => {
          pending.push({
            signal: init!.signal!,
            resolve,
            reject,
          })
        }),
    )
    runInContext(
      readFileSync('packages/extension-reference/reference.js', 'utf8'),
      data.context,
    )
    document.getElementById('catalog-reload')!.click()
    expect(pending[0]!.signal.aborted).toBe(true)
    pending[1]!.resolve({
      ok: true,
      json: () => Promise.resolve([{ id: 'one', title: 'One', detail: 'Detail' }]),
    })
    await vi.waitFor(() =>
      expect(document.querySelectorAll('#catalog-list button')).toHaveLength(1),
    )
    document.getElementById('catalog-reload')!.click()
    pending[2]!.reject(new Error('Cannot load examples'))
    await vi.waitFor(() =>
      expect(document.getElementById('catalog-state')!.dataset.state).toBe('error'),
    )
    document
      .getElementById('catalog-search')!
      .dispatchEvent(new Event('input', { bubbles: true }))
    expect(document.querySelectorAll('#catalog-list button')).toHaveLength(0)
    expect(document.getElementById('catalog-state')!.dataset.state).toBe('error')
    document.getElementById('catalog-reload')!.click()
    const late = pending.at(-1)!
    window.dispatchEvent(new Event('pagehide'))
    expect(late.signal.aborted).toBe(true)
    expect(data.subscribers.size).toBe(0)
    late.resolve({
      ok: true,
      json: () => Promise.resolve([{ id: 'late', title: 'Late', detail: 'Late' }]),
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(document.querySelectorAll('#catalog-list button')).toHaveLength(0)
  })

  it('cleans native request admission failures and completes disposal even when cancel throws', async () => {
    const data = fixture(true)
    vi.spyOn(window, 'fetch').mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    } as Response)
    runInContext(
      readFileSync('packages/extension-reference/reference.js', 'utf8'),
      data.context,
    )
    const count = data.subscribers.size
    data.bridge.onMessage.mockImplementationOnce(() => {
      throw new Error('Subscription limit')
    })
    await expect(
      runInContext('nativeRequest("connector.execute", {})', data.context),
    ).rejects.toThrow('Subscription limit')
    expect(data.subscribers.size).toBe(count)
    data.send.mockImplementationOnce(() => {
      throw new Error('Send limit')
    })
    await expect(
      runInContext('nativeRequest("connector.execute", {})', data.context),
    ).rejects.toThrow('Send limit')
    expect(data.subscribers.size).toBe(count)
    const waiting = runInContext(
      'nativeRequest("connector.execute", {})',
      data.context,
    ) as Promise<unknown>
    const rejection = expect(waiting).rejects.toThrow('closed')
    data.send.mockImplementation(() => {
      throw new Error('Cancel limit')
    })
    window.dispatchEvent(new Event('pagehide'))
    await rejection
    expect(data.subscribers.size).toBe(0)
    expect(runInContext('requests.size', data.context)).toBe(0)
  })
})
