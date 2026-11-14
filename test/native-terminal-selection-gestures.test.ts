import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'
import {
  nativeSelectionGestureObserver,
  verifyNativePendingPointer,
  verifyNativeReadonlyPointerBlur,
} from '../src/main/smoke/native-terminal-selection-gestures'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept
    reject = refuse
  })
  return { promise, resolve, reject }
}

it('observes trusted outside pointer facts and actual capture state with a fixed event bound', () => {
  const handlers = new Map<string, (event: object) => void>(),
    input = { tagName: 'TEXTAREA', className: 'native-input', getAttribute: () => null },
    outside = {}
  let captured = false
  const pane = {
    isConnected: true,
    contains: (node: object) => node === input,
    hasPointerCapture: () => captured,
    querySelector: (selector: string) => (selector === 'textarea' ? input : surface),
  }
  const surface = { id: 'native-terminal-view', querySelector: () => ({}) }
  const panel = { getAttribute: () => 's', querySelector: () => pane }
  const document = { querySelectorAll: () => [panel], activeElement: input }
  const window: {
    addEventListener: (type: string, callback: (event: object) => void) => void
    nativeSelectionGestureProbe?: {
      state: () => {
        events: object[]
        pointerId: number
        captured: boolean
        overflow: boolean
        inputActive: boolean
      }
      finish: () => void
      restore: () => void
    }
  } = {
    addEventListener: (type, callback) => {
      handlers.set(type, callback)
    },
  }
  runInNewContext(nativeSelectionGestureObserver('s'), {
    window,
    document,
    AbortController,
  })
  const event = (
    type: string,
    pointerId: number,
    target: object,
    trusted: boolean,
    buttons = 1,
  ) => handlers.get(type)!({ type, pointerId, target, isTrusted: trusted, buttons })
  event('pointerdown', 7, input, true)
  captured = true
  expect(window.nativeSelectionGestureProbe!.state()).toMatchObject({
    pointerId: 7,
    captured: true,
    inputActive: true,
  })
  event('pointermove', 8, outside, true)
  expect(window.nativeSelectionGestureProbe!.state().events).toHaveLength(1)
  event('pointermove', 7, outside, false)
  event('pointerup', 7, outside, true)
  captured = false
  expect(window.nativeSelectionGestureProbe!.state()).toMatchObject({
    captured: false,
    events: [
      { type: 'pointerdown', trusted: true, outside: false, pointerId: 7 },
      { type: 'pointermove', trusted: false, outside: true, pointerId: 7, buttons: 1 },
      { type: 'pointerup', trusted: true, outside: true, pointerId: 7 },
    ],
  })
  event('lostpointercapture', 7, input, true)
  event('focusout', 7, input, true)
  expect(window.nativeSelectionGestureProbe!.state()).toMatchObject({
    activeTag: 'TEXTAREA',
    activeClasses: 'native-input',
  })
  expect(window.nativeSelectionGestureProbe!.state().events.slice(-2)).toMatchObject([
    { type: 'lostpointercapture', captured: false, targetInput: true },
    { type: 'focusout', trusted: true, targetInput: true },
  ])

  for (let i = 0; i < 20; i++) event('pointermove', 7, outside, true)
  expect(window.nativeSelectionGestureProbe!.state().events).toHaveLength(16)
  expect(window.nativeSelectionGestureProbe!.state().overflow).toBe(true)
  window.nativeSelectionGestureProbe!.finish()
  event('pointerup', 7, outside, true)
  expect(window.nativeSelectionGestureProbe!.state().events).toHaveLength(16)
  window.nativeSelectionGestureProbe!.restore()
  expect(window.nativeSelectionGestureProbe).toBeUndefined()
})

it('releases a held real-result delivery and restores the input method when the outside observation fails', async () => {
  const physical = deferred<{ requestedMutation: number }>(),
    started = deferred<void>(),
    outsideEntered = deferred<void>(),
    outsideFailure = deferred<void>()
  const result = { requestedMutation: 17 },
    failure = new Error('actual outside observation failed')
  const original = vi.fn(() => {
    started.resolve()
    return physical.promise
  })
  const native = { input: original } as unknown as Parameters<
    typeof verifyNativePendingPointer
  >[1]
  let pressResult: Promise<unknown> | undefined
  const execute = vi.fn(() => Promise.resolve(true))
  const browser = {
    layout: () => Promise.resolve({ bounds: { x: 100, viewId: 'view' } }),
    clear: () => Promise.resolve(),
    point: () => Promise.resolve({ x: 140, y: 200 }),
    mouse: (type: string) => {
      if (type === 'mouseDown')
        pressResult = native.input(
          'view',
          { id: 1, generation: 1 },
          { kind: 'pointer', x: 40, y: 20, button: 1, action: 1, modifiers: 0 },
        )
    },
    wait: async (check: () => boolean, label: string) => {
      if (label === 'pending-real-press-completion') {
        await physical.promise
        expect(check()).toBe(true)
      } else {
        outsideEntered.resolve()
        await outsideFailure.promise
      }
    },
  } as unknown as Parameters<typeof verifyNativePendingPointer>[3]
  const win = { webContents: { executeJavaScript: execute } } as unknown as Parameters<
    typeof verifyNativePendingPointer
  >[0]
  const managed = { id: 's' } as Parameters<typeof verifyNativePendingPointer>[2]
  const proof = verifyNativePendingPointer(win, native, managed, browser, vi.fn())
  await started.promise
  expect(original).toHaveBeenCalledOnce()
  let acknowledged = false
  const acknowledgement = pressResult!.then((value) => {
    acknowledged = true
    return value
  })
  expect(acknowledged).toBe(false)
  physical.resolve(result)
  await outsideEntered.promise
  expect(acknowledged).toBe(false)
  outsideFailure.reject(failure)
  await expect(proof).rejects.toBe(failure)
  expect(await acknowledgement).toBe(result)
  await expect(
    native.input('view', { id: 1, generation: 1 }, { kind: 'caret' }),
  ).resolves.toBe(result)
  expect(original).toHaveBeenCalledTimes(2)
  expect(Object.getOwnPropertyDescriptor(native, 'input')?.value).toBe(original)
  expect(execute).toHaveBeenLastCalledWith(
    'window.nativeSelectionGestureProbe?.restore();true',
  )
})

it('refuses a claimed readonly proof while a PTY still exists and restores both observation wrappers', async () => {
  const originalInput = vi.fn(),
    originalWrite = vi.fn(),
    ptys = { writeConfirmed: originalWrite, list: () => [{}] }
  const native = { input: originalInput } as unknown as Parameters<
    typeof verifyNativeReadonlyPointerBlur
  >[2]
  const browser = {
    layout: () => Promise.resolve({ bounds: { viewId: 'view' } }),
  } as unknown as Parameters<typeof verifyNativeReadonlyPointerBlur>[4]
  const win = {
    webContents: { executeJavaScript: vi.fn(() => Promise.resolve(true)) },
  } as unknown as Parameters<typeof verifyNativeReadonlyPointerBlur>[0]
  await expect(
    verifyNativeReadonlyPointerBlur(
      win,
      ptys as unknown as Parameters<typeof verifyNativeReadonlyPointerBlur>[1],
      native,
      { id: 's' } as Parameters<typeof verifyNativeReadonlyPointerBlur>[3],
      browser,
      22.9,
      vi.fn(),
    ),
  ).rejects.toThrow('readonly-pty')
  expect(originalInput).not.toHaveBeenCalled()
  expect(originalWrite).not.toHaveBeenCalled()
  expect(Object.getOwnPropertyDescriptor(native, 'input')?.value).toBe(originalInput)
  expect(Object.getOwnPropertyDescriptor(ptys, 'writeConfirmed')?.value).toBe(
    originalWrite,
  )
  await native.input('view', { id: 1, generation: 1 }, { kind: 'caret' })
  ptys.writeConfirmed()
  expect(originalInput).toHaveBeenCalledOnce()
  expect(originalWrite).toHaveBeenCalledOnce()
})
