import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EXTENSION_LIMITS } from '../src/shared/extensions/contract'
import {
  deferred,
  electron,
  fixture,
  owner,
  turn,
  viewFor,
} from './fixtures/extension-electron-surface'

type Fixture = Awaited<ReturnType<typeof fixture>>

function nativeWindow(data: Fixture) {
  let visible = true
  let minimized = false
  let focused = true
  const contents = Object.assign(data.guest, {
    mainFrame: { isDestroyed: () => false, postMessage: vi.fn() },
  })
  const win = Object.assign(new EventEmitter(), {
    webContents: contents,
    isDestroyed: () => false,
    isVisible: () => visible,
    isMinimized: () => minimized,
    isFocused: () => focused,
  })
  electron.windows.set(owner.id, win)
  data.surface.installWindowLifecycle(win as never, () => owner)
  return {
    change(event: 'hide' | 'minimize' | 'blur') {
      if (event === 'hide') visible = false
      if (event === 'minimize') minimized = true
      if (event === 'blur') focused = false
      win.emit(event)
    },
    close: () => win.emit('closed'),
  }
}

async function pendingActivation() {
  const active = deferred<unknown>()
  let throttlingAtDispatch: boolean | undefined
  const data = await fixture((method, parameters) => {
    if (method === 'Page.setWebLifecycleState' && parameters?.state === 'active') {
      throttlingAtDispatch = data.guest.getBackgroundThrottling()
      return active.promise
    }
    return Promise.resolve({ targetInfo: { targetId: 'target', type: 'webview' } })
  })
  const window = nativeWindow(data)
  await turn()
  data.surface.visibility(data.guest.id, true)
  await turn()
  expect(throttlingAtDispatch).toBe(false)
  expect(data.guest.getBackgroundThrottling()).toBe(true)
  return { ...data, active, window }
}

afterEach(() => {
  electron.sessions.clear()
  electron.guests.clear()
  electron.windows.clear()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('Electron guest native drawing restoration', () => {
  it('restores drawing during native dispatch and restores normal throttling before awaiting its result', async () => {
    const data = await pendingActivation()
    expect(data.states()).toEqual(['frozen', 'active'])
    expect(data.guest.setBackgroundThrottling.mock.calls).toEqual([[false], [true]])
    data.active.resolve({})
    await turn()
    expect(data.guest.setBackgroundThrottling.mock.calls).toEqual([[false], [true]])
    expect(data.failed).not.toHaveBeenCalled()
    data.window.close()
    await data.surface.destroy(data.view.id)
    expect(data.guest.setBackgroundThrottling).toHaveBeenCalledTimes(2)
  })

  it.each(['action', 'updater', 'hidden-window'] as const)(
    'does not show %s work or touch its already enabled throttling',
    async (kind) => {
      const view = {
        ...viewFor(),
        role: kind === 'updater' ? ('updater' as const) : ('view' as const),
      }
      const data = await fixture(undefined, false, false, true, view)
      const window = nativeWindow(data)
      if (kind === 'hidden-window') window.change('hide')
      await turn()
      if (kind === 'action') data.surface.runnable(data.guest.id, true)
      else data.surface.visibility(data.guest.id, true)
      await turn()
      expect(data.states().at(-1)).toBe('active')
      expect(data.guest.setBackgroundThrottling).not.toHaveBeenCalled()
      data.surface.runnable(data.guest.id, false)
      data.surface.visibility(data.guest.id, false)
      await turn()
      expect(data.states().at(-1)).toBe('frozen')
      expect(data.guest.setBackgroundThrottling).not.toHaveBeenCalled()
      window.close()
      await data.surface.destroy(data.view.id)
    },
  )

  it.each(['placement', 'hide', 'minimize', 'close'] as const)(
    'retains normal throttling across %s while the native result is pending',
    async (withdrawal) => {
      const data = await pendingActivation()
      let closed: Promise<void> | undefined
      if (withdrawal === 'placement') data.surface.visibility(data.guest.id, false)
      else if (withdrawal === 'close') closed = data.surface.destroy(data.view.id)
      else data.window.change(withdrawal)
      expect(data.guest.getBackgroundThrottling()).toBe(true)
      expect(data.guest.setBackgroundThrottling.mock.calls).toEqual([[false], [true]])
      data.active.resolve({})
      await turn()
      await closed
      expect(data.guest.setBackgroundThrottling).toHaveBeenCalledTimes(2)
      expect(data.failed).not.toHaveBeenCalledWith(data.guest.id, expect.any(String))
      if (withdrawal === 'placement') expect(data.states().at(-1)).toBe('frozen')
      if (withdrawal === 'close') expect(data.guest.close).toHaveBeenCalledTimes(1)
      data.window.close()
      await data.surface.destroy(data.view.id)
    },
  )

  it('keeps ordinary viewer focus policy independent of drawing restoration', async () => {
    const data = await pendingActivation()
    data.window.change('blur')
    expect(data.guest.getBackgroundThrottling()).toBe(true)
    data.active.resolve({})
    await turn()
    expect(data.guest.getBackgroundThrottling()).toBe(true)
    expect(data.states()).toEqual(['frozen', 'active'])
    data.window.close()
    await data.surface.destroy(data.view.id)
  })

  it('keeps normal throttling and closes on the unchanged native command deadline', async () => {
    const report = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const data = await pendingActivation()
    await vi.advanceTimersByTimeAsync(EXTENSION_LIMITS.requestTimeoutMs)
    expect(data.guest.getBackgroundThrottling()).toBe(true)
    await turn()
    expect(data.failed).toHaveBeenCalledWith(
      data.guest.id,
      'Extension engine lifecycle control is unavailable. Close and reopen the view.',
    )
    expect(report).toHaveBeenCalledTimes(1)
    expect(data.guest.close).toHaveBeenCalledTimes(1)
    const calls = data.guest.setBackgroundThrottling.mock.calls.length
    data.active.resolve({})
    await turn()
    expect(data.guest.setBackgroundThrottling).toHaveBeenCalledTimes(calls)
    data.window.close()
    await data.surface.destroy(data.view.id)
  })

  it.each(['acquire', 'partial-acquire', 'restore', 'command', 'sync-command'] as const)(
    'fails the exact guest closed on %s refusal without leaking an issued rejection',
    async (refusal) => {
      const report = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      let rejectActive!: (error: Error) => void
      const active = new Promise<unknown>((_resolve, reject) => {
        rejectActive = reject
      })
      const data = await fixture((method, parameters) => {
        if (method === 'Page.setWebLifecycleState' && parameters?.state === 'active') {
          if (refusal === 'command') return Promise.reject(new Error('Native refusal'))
          if (refusal === 'sync-command') throw new Error('Native dispatch refusal')
          return active
        }
        return Promise.resolve({ targetInfo: { targetId: 'target', type: 'webview' } })
      })
      const window = nativeWindow(data)
      await turn()
      const set = data.guest.setBackgroundThrottling.getMockImplementation()!
      data.guest.setBackgroundThrottling.mockImplementation((allowed) => {
        if (refusal === 'partial-acquire' && !allowed) {
          set(allowed)
          throw new Error('Native acquisition partially failed')
        }
        if ((refusal === 'acquire' && !allowed) || (refusal === 'restore' && allowed))
          throw new Error('Native drawing refusal')
        set(allowed)
      })
      data.surface.visibility(data.guest.id, true)
      await turn()
      expect(data.failed).toHaveBeenCalledWith(
        data.guest.id,
        'Extension engine lifecycle control is unavailable. Close and reopen the view.',
      )
      expect(report).toHaveBeenCalledTimes(1)
      if (refusal === 'restore') {
        // The restoration exception must not leave its already-issued command
        // rejection unobserved, including after exact-guest revocation.
        rejectActive(new Error('Late native command refusal'))
        await turn()
      }
      await data.surface.destroy(data.view.id)
      expect(data.guest.close).toHaveBeenCalledTimes(1)
      if (refusal !== 'restore') expect(data.guest.getBackgroundThrottling()).toBe(true)
      window.close()
    },
  )
})
