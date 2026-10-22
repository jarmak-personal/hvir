import type { BrowserWindow } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { focusSmokeWindow } from '../src/main/smoke/window-focus'

vi.mock('electron', () => ({ app: { focus: vi.fn() } }))
afterEach(() => vi.useRealTimers())

function windowWithGuestFocus() {
  let nativeFocus = false
  let documentFocus = false
  const webContents = {
    executeJavaScript: vi.fn(() => Promise.resolve(documentFocus)),
    focus: vi.fn(() => {
      documentFocus = true
    }),
  }
  const win = {
    show: vi.fn(),
    isVisible: () => true,
    isFocused: () => nativeFocus,
    isMinimized: () => false,
    focus: vi.fn(() => {
      nativeFocus = true
    }),
    webContents,
  }
  return { win, asWindow: win as unknown as BrowserWindow }
}

it('acquires native foreground without stealing focus from the embedded guest', async () => {
  const { win, asWindow } = windowWithGuestFocus()
  await focusSmokeWindow(asWindow, 'window')
  expect(win.isFocused()).toBe(true)
  expect(win.webContents.focus).not.toHaveBeenCalled()
  expect(win.webContents.executeJavaScript).not.toHaveBeenCalled()
})

it('retains the default parent Chromium focus required by existing clipboard callers', async () => {
  const { win, asWindow } = windowWithGuestFocus()
  await focusSmokeWindow(asWindow)
  expect(win.webContents.focus).toHaveBeenCalledOnce()
  expect(await win.webContents.executeJavaScript()).toBe(true)
})

it('refuses a native window that never acquires foreground within the existing bound', async () => {
  vi.useFakeTimers()
  const { win, asWindow } = windowWithGuestFocus()
  win.focus.mockImplementation(() => undefined)
  const outcome = expect(focusSmokeWindow(asWindow, 'window')).rejects.toThrow(
    'did not acquire focus',
  )
  await vi.advanceTimersByTimeAsync(5050)
  await outcome
  expect(vi.getTimerCount()).toBe(0)
})
