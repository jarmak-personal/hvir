// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { SessionRenameTarget } from '../src/renderer/src/terminal/SessionRenameTarget'

let container: HTMLDivElement
let root: Root
let invoke: ReturnType<
  typeof vi.fn<(channel: string, request: unknown) => Promise<unknown>>
>
let activate: ReturnType<typeof vi.fn<() => void>>
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  invoke = vi.fn(() => Promise.resolve({ ok: true }))
  activate = vi.fn()
  Object.defineProperty(window, 'hvir', { configurable: true, value: { invoke } })
  act(() =>
    root.render(
      <SessionRenameTarget
        id="inactive-terminal"
        customName="Existing name"
        nameRevision={4}
      >
        <button onClick={activate}>Terminal title</button>
      </SessionRenameTarget>,
    ),
  )
})
afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function button(text: string) {
  const result = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent === text,
  )
  if (!result) throw new Error(`Missing ${text}`)
  return result
}
function open(keyboard = false) {
  const target = button('Terminal title')
  act(() => {
    target.dispatchEvent(
      keyboard
        ? new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true })
        : new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
    )
  })
  expect(document.querySelector('[role="menu"]')).not.toBeNull()
  act(() => button('Rename…').click())
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
}
function input(value: string) {
  const field = document.querySelector<HTMLInputElement>('input')!
  act(() => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it.each([false, true])(
  'opens Rename through pointer/keyboard without activating and cancels without saving (%s)',
  (keyboard) => {
    open(keyboard)
    expect(document.querySelector<HTMLInputElement>('input')?.value).toBe('Existing name')
    input('Discarded')
    act(() => button('Cancel').click())
    expect(invoke).not.toHaveBeenCalled()
    expect(activate).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  },
)

it('saves an exact target and supports clearing through the same control', async () => {
  open(true)
  input('   ')
  await act(() => {
    button('Save name').click()
    return Promise.resolve()
  })
  expect(invoke).toHaveBeenCalledExactlyOnceWith('terminal:rename', {
    id: 'inactive-terminal',
    customName: '   ',
    expectedNameRevision: 4,
  })
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(activate).not.toHaveBeenCalled()
})

it('shows persistence feedback, keeps the dialog open, and rejects duplicate submissions', async () => {
  let resolve!: (result: unknown) => void
  invoke.mockImplementationOnce(
    () =>
      new Promise((accept) => {
        resolve = accept
      }),
  )
  open()
  input('New name')
  act(() => {
    button('Save name').click()
    button('Save name').click()
  })
  expect(invoke).toHaveBeenCalledOnce()
  await act(() => {
    resolve({ ok: false, error: 'Disk full. Try again.' })
    return Promise.resolve()
  })
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    'Disk full. Try again.',
  )
  expect(document.querySelector<HTMLInputElement>('input')?.value).toBe('New name')
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
})

it('discards completion after the target is removed', async () => {
  let resolve!: (result: unknown) => void
  invoke.mockImplementationOnce(
    () =>
      new Promise((accept) => {
        resolve = accept
      }),
  )
  open()
  act(() => button('Save name').click())
  act(() => root.render(<button>Other session</button>))
  await act(() => {
    resolve({ ok: false, error: 'Late failure' })
    return Promise.resolve()
  })
  expect(document.body.textContent).toBe('Other session')
})
