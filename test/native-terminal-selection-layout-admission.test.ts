import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { nativeSelectionBrowser } from '../src/main/smoke/native-terminal-selection-browser'
import type { ManagedPty } from '../src/main/pty/pty-supervisor'
import type { NativeTerminalApplication } from '../src/main/terminal/native-terminal-application'
import { NativeTerminalAdmissionError } from '../src/shared/native-terminal'
import { nativeTerminalStatus } from './fixtures/native-terminal-host'

vi.mock('electron', () => ({ clipboard: {} }))
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

function fixture() {
  const managed = {
    id: 'session',
    instanceId: 'instance',
    ownerId: 7,
    ownerGeneration: 3,
  }
  let record = {
    handle: 'handle',
    retiring: false,
    unavailable: false,
    session: {
      sessionId: managed.id,
      instanceId: managed.instanceId,
      ownerId: managed.ownerId,
      ownerGeneration: managed.ownerGeneration,
    },
  }
  const inspect = vi.fn<NativeTerminalApplication['inspectRetained']>(() =>
    Promise.resolve(nativeTerminalStatus()),
  )
  const sendInputEvent = vi.fn()
  const bounds = {
    x: 0,
    y: 0,
    width: 32,
    height: 32,
    viewId: 'view',
    canvasWidth: 32,
    canvasHeight: 32,
    canvasCssWidth: 32,
    canvasCssHeight: 32,
    dpr: 1,
  }
  const executeJavaScript = vi.fn((script: string): Promise<unknown> =>
    Promise.resolve(script.startsWith('!document.querySelector') ? true : bounds),
  )
  const capturePage = vi.fn(() =>
    Promise.resolve({
      toBitmap: () =>
        Buffer.from(Array.from({ length: 64 }, () => [255, 0, 0, 255]).flat()),
    }),
  )
  const win = {
    webContents: {
      capturePage,
      executeJavaScript,
      sendInputEvent,
      getZoomFactor: () => 1,
    },
  }
  const native = { inspectRetained: inspect, sessions: { get: () => record } }
  const browser = nativeSelectionBrowser(
    win as unknown as BrowserWindow,
    native as unknown as NativeTerminalApplication,
    managed as ManagedPty,
  )
  return {
    browser,
    capturePage,
    inspect,
    sendInputEvent,
    executeJavaScript,
    replace: (change: Partial<typeof record>) => {
      record = { ...record, ...change }
    },
    record: () => record,
  }
}

describe('native smoke readonly layout admission before a gesture', () => {
  it('waits only for typed known-unsent inspection then sends one finite menu gesture', async () => {
    const f = fixture()
    f.inspect.mockRejectedValueOnce(
      new NativeTerminalAdmissionError('native-command-bound'),
    )
    const menu = f.browser.menu('Clear Screen and Scrollback')
    void menu.catch(() => undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.inspect).toHaveBeenCalledOnce()
    expect(f.sendInputEvent).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(25)
    await menu
    expect(f.inspect).toHaveBeenCalledTimes(2)
    expect(
      f.sendInputEvent.mock.calls.map(([event]) => (event as { type: string }).type),
    ).toEqual(['mouseDown', 'mouseUp', 'mouseDown', 'mouseUp'])
  })

  it('keeps painted polling in its outer budget and samples only admitted geometry', async () => {
    const f = fixture()
    f.inspect.mockRejectedValueOnce(
      new NativeTerminalAdmissionError('native-command-bound'),
    )
    const painted = f.browser.painted()
    void painted.catch(() => undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.capturePage).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(25)
    await painted
    expect(f.inspect).toHaveBeenCalledTimes(2)
    expect(f.capturePage).toHaveBeenCalledOnce()
    expect(f.sendInputEvent).not.toHaveBeenCalled()
  })

  it.each(['menu', 'painted', 'readiness'] as const)(
    'preserves an untyped same-message failure in %s without observation or gesture replay',
    async (operation) => {
      const f = fixture(),
        failure = new Error('native-command-bound')
      f.inspect.mockRejectedValueOnce(failure)
      const pending =
        operation === 'menu'
          ? f.browser.menu('Clear Screen and Scrollback')
          : operation === 'painted'
            ? f.browser.painted()
            : f.browser.layoutWhenReady()
      await expect(pending).rejects.toBe(failure)
      expect(f.inspect).toHaveBeenCalledOnce()
      expect(f.executeJavaScript).not.toHaveBeenCalled()
      expect(f.capturePage).not.toHaveBeenCalled()
      expect(f.sendInputEvent).not.toHaveBeenCalled()
    },
  )

  it.each(['handle', 'instance', 'owner'] as const)(
    'refuses a replacement %s during known-unsent admission wait',
    async (kind) => {
      const f = fixture()
      f.inspect.mockRejectedValueOnce(
        new NativeTerminalAdmissionError('native-command-bound'),
      )
      const menu = f.browser.menu('Clear Screen and Scrollback')
      const rejected = expect(menu).rejects.toThrow('native-selection-layout-owner')
      void rejected.catch(() => undefined)
      await vi.advanceTimersByTimeAsync(0)
      const old = f.record()
      f.replace(
        kind === 'handle'
          ? { handle: 'replacement' }
          : {
              session: {
                ...old.session,
                ...(kind === 'instance'
                  ? { instanceId: 'replacement' }
                  : { ownerGeneration: 4 }),
              },
            },
      )
      await vi.advanceTimersByTimeAsync(25)
      await rejected
      expect(f.inspect).toHaveBeenCalledOnce()
      expect(f.executeJavaScript).not.toHaveBeenCalled()
      expect(f.sendInputEvent).not.toHaveBeenCalled()
    },
  )

  it('revalidates the captured state after admitted inspection before reading DOM or gesturing', async () => {
    const f = fixture()
    f.inspect.mockImplementationOnce(() => {
      f.replace({ handle: 'replacement' })
      return Promise.resolve(nativeTerminalStatus())
    })
    await expect(f.browser.menu('Clear Screen and Scrollback')).rejects.toThrow(
      'native-selection-layout-owner',
    )
    expect(f.executeJavaScript).not.toHaveBeenCalled()
    expect(f.sendInputEvent).not.toHaveBeenCalled()
  })

  it('bounds the pregesture admission wait to the existing fifteen seconds', async () => {
    const f = fixture()
    f.inspect.mockRejectedValue(new NativeTerminalAdmissionError('native-command-bound'))
    const pending = f.browser.menu('Clear Screen and Scrollback')
    const rejected = expect(pending).rejects.toThrow(
      'native-selection-point-layout-timeout',
    )
    void rejected.catch(() => undefined)
    await vi.advanceTimersByTimeAsync(15000)
    await rejected
    expect(Date.now()).toBe(15000)
    expect(f.inspect).toHaveBeenCalledTimes(600)
    expect(f.executeJavaScript).not.toHaveBeenCalled()
    expect(f.sendInputEvent).not.toHaveBeenCalled()
  })

  it('does not extend an outer readiness deadline when admission is refused on its last observation', async () => {
    const f = fixture()
    f.inspect.mockRejectedValue(new NativeTerminalAdmissionError('native-command-bound'))
    const pending = f.browser.wait(
      async () => Date.now() >= 14975 && !!(await f.browser.layoutWhenReady()),
      'outer-readiness',
    )
    const rejected = expect(pending).rejects.toThrow(
      'native-selection-outer-readiness-timeout',
    )
    void rejected.catch(() => undefined)
    await vi.advanceTimersByTimeAsync(15000)
    await rejected
    expect(Date.now()).toBe(15000)
    expect(f.inspect).toHaveBeenCalledOnce()
    expect(f.sendInputEvent).not.toHaveBeenCalled()
  })
})
