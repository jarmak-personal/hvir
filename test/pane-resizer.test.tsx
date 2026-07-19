// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PaneResizer } from '../src/renderer/src/layout/PaneResizer'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.className = ''
  vi.restoreAllMocks()
})

describe('PaneResizer action gestures', () => {
  it('leaves a short action press as a button click', () => {
    const action = vi.fn()
    const onDrag = vi.fn()
    const onDragStart = vi.fn()
    renderResizer({ action, onDrag, onDragStart })
    const button = actionButton()

    pointer(button, 'pointerdown', 1, 100, 100)
    pointer(button, 'pointermove', 1, 102, 101)
    pointer(button, 'pointerup', 1, 102, 101)
    act(() => button.click())

    expect(action).toHaveBeenCalledOnce()
    expect(onDragStart).not.toHaveBeenCalled()
    expect(onDrag).not.toHaveBeenCalled()
  })

  it('turns action movement into one drag and suppresses the following click', () => {
    const action = vi.fn()
    const onDrag = vi.fn()
    const onDragStart = vi.fn()
    renderResizer({ action, onDrag, onDragStart })
    const button = actionButton()

    pointer(button, 'pointerdown', 4, 100, 100)
    pointer(button, 'pointermove', 4, 100, 106)

    expect(onDragStart).toHaveBeenCalledOnce()
    expect(onDrag).toHaveBeenLastCalledWith(106)
    expect(document.body.classList.contains('pane-resizing-row')).toBe(true)

    pointer(button, 'pointerup', 4, 100, 106)
    act(() => button.click())

    expect(action).not.toHaveBeenCalled()
    expect(document.body.classList.contains('pane-resizing')).toBe(false)
  })

  it('cleans up an immediately started divider drag on cancellation', () => {
    renderResizer({ action: vi.fn(), onDrag: vi.fn(), onDragStart: vi.fn() })
    const divider = host.querySelector<HTMLElement>('.pane-resizer')
    expect(divider).toBeTruthy()

    pointer(divider!, 'pointerdown', 7, 100, 100)
    expect(document.body.classList.contains('pane-resizing')).toBe(true)

    pointer(divider!, 'pointercancel', 7, 100, 100)
    expect(document.body.classList.contains('pane-resizing')).toBe(false)
    expect(document.body.classList.contains('pane-resizing-row')).toBe(false)
  })

  it('does not leave action clicks suppressed after pointer cancellation', () => {
    const action = vi.fn()
    renderResizer({ action, onDrag: vi.fn(), onDragStart: vi.fn() })
    const button = actionButton()

    pointer(button, 'pointerdown', 9, 100, 100)
    pointer(button, 'pointermove', 9, 100, 106)
    pointer(button, 'pointercancel', 9, 100, 106)
    act(() => button.click())

    expect(action).toHaveBeenCalledOnce()
    expect(document.body.classList.contains('pane-resizing')).toBe(false)
  })
})

function renderResizer({
  action,
  onDrag,
  onDragStart,
}: {
  readonly action: () => void
  readonly onDrag: (position: number) => void
  readonly onDragStart: () => void
}): void {
  act(() => {
    root.render(
      createElement(PaneResizer, {
        orientation: 'horizontal',
        label: 'Resize terminal',
        className: 'terminal-resizer',
        onDrag,
        onDragStart,
        onNudge: vi.fn(),
        onReset: vi.fn(),
        action: createElement(
          'button',
          { type: 'button', 'data-resizer-action': true, onClick: action },
          'Toggle',
        ),
      }),
    )
  })
}

function actionButton(): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>('[data-resizer-action]')
  if (!button) throw new Error('resizer action did not render')
  return button
}

function pointer(
  target: Element,
  type: string,
  pointerId: number,
  clientX: number,
  clientY: number,
): void {
  act(() => {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId,
        isPrimary: true,
        button: 0,
        buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
        clientX,
        clientY,
      }),
    )
  })
}
