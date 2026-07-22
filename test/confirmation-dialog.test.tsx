// @vitest-environment happy-dom

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConfirmationDialog } from '../src/renderer/src/workbench/ConfirmationDialog'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ConfirmationDialog', () => {
  it('focuses the safest action, contains Tab, handles Escape, and marks intent', () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    act(() => {
      root.render(
        <ConfirmationDialog
          labelledBy="confirmation-title"
          actions={[
            { label: 'Cancel', kind: 'cancel', onSelect: onCancel },
            { label: 'Remove item', kind: 'destructive', onSelect: onConfirm },
          ]}
        >
          <h2 id="confirmation-title">Remove the item?</h2>
        </ConfirmationDialog>,
      )
    })

    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!
    const cancel = button('Cancel')
    const remove = button('Remove item')
    exposeForFocus(dialog, cancel, remove)
    expect(document.activeElement).toBe(cancel)
    expect(remove.classList.contains('confirmation-action-destructive')).toBe(true)

    act(() => {
      remove.focus()
      keydown(remove, 'Tab')
    })
    expect(document.activeElement).toBe(cancel)

    act(() => {
      cancel.focus()
      keydown(cancel, 'Tab', true)
    })
    expect(document.activeElement).toBe(remove)

    act(() => keydown(remove, 'Escape'))
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('locks actions synchronously and disables dismissal while feature work is busy', () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()

    function BusyConfirmation() {
      const [busy, setBusy] = useState(false)
      return (
        <ConfirmationDialog
          labelledBy="busy-title"
          busy={busy}
          actions={[
            { label: 'Cancel', kind: 'cancel', onSelect: onCancel },
            {
              label: 'Continue',
              kind: 'primary',
              onSelect: () => {
                onConfirm()
                setBusy(true)
              },
            },
          ]}
        >
          <h2 id="busy-title">Continue?</h2>
        </ConfirmationDialog>
      )
    }

    act(() => root.render(<BusyConfirmation />))
    const proceed = button('Continue')
    act(() => {
      proceed.click()
      proceed.click()
    })

    expect(onConfirm).toHaveBeenCalledOnce()
    expect(button('Cancel').disabled).toBe(true)
    expect(proceed.disabled).toBe(true)
    act(() => keydown(proceed, 'Escape'))
    expect(onCancel).not.toHaveBeenCalled()
  })
})

function button(label: string): HTMLButtonElement {
  const match = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  )
  if (!match) throw new Error(`Missing button '${label}'`)
  return match
}

function exposeForFocus(parent: HTMLElement, ...elements: HTMLElement[]): void {
  for (const element of elements) {
    Object.defineProperty(element, 'offsetParent', { configurable: true, value: parent })
  }
}

function keydown(target: HTMLElement, key: string, shiftKey = false): void {
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }),
  )
}
