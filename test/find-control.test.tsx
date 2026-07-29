// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FindControl } from '../src/renderer/src/viewer/FindControl'
import {
  normalizeFindIndex,
  type ViewerFindQuery,
  type ViewerFindResult,
  type ViewerFindTarget,
} from '../src/renderer/src/viewer/viewer-find'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    callback(0)
    return 1
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

describe('FindControl', () => {
  it('updates counts, wraps navigation, toggles case, and restores focus', () => {
    const previous = document.createElement('button')
    document.body.append(previous)
    previous.focus()
    const target = findTarget(3)
    const onRequestHandled = vi.fn()

    act(() => {
      root.render(
        <FindControl
          requestSerial={1}
          target={target.value}
          boundedPreview={false}
          onRequestHandled={onRequestHandled}
        />,
      )
    })
    const input = host.querySelector<HTMLInputElement>('[role="search"] > input')
    expect(document.activeElement).toBe(input)
    expect(onRequestHandled).toHaveBeenCalledWith(1)

    setInput(input, 'needle')
    expect(target.update).toHaveBeenLastCalledWith(
      { text: 'needle', caseSensitive: false },
      0,
    )
    expect(host.querySelector('[role="status"]')?.textContent).toBe('1 of 3')

    act(() => {
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(host.querySelector('[role="status"]')?.textContent).toBe('2 of 3')
    act(() => {
      input?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }),
      )
    })
    expect(host.querySelector('[role="status"]')?.textContent).toBe('1 of 3')

    const matchCase = host.querySelector<HTMLInputElement>('[type="checkbox"]')
    act(() => matchCase?.click())
    expect(target.update).toHaveBeenLastCalledWith(
      { text: 'needle', caseSensitive: true },
      0,
    )

    matchCase?.focus()
    act(() => {
      matchCase?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      )
    })
    expect(host.querySelector('[role="search"]')).toBeNull()
    expect(target.clear).toHaveBeenCalled()
    expect(document.activeElement).toBe(previous)
    previous.remove()
  })

  it('keeps unavailable representations explicit and keyboard-dismissible', () => {
    act(() => {
      root.render(
        <FindControl
          requestSerial={1}
          unavailable="In-file find is unavailable in live rendered HTML"
          boundedPreview={false}
          onRequestHandled={vi.fn()}
        />,
      )
    })
    const input = host.querySelector<HTMLInputElement>('[role="search"] > input')
    expect(input?.readOnly).toBe(true)
    expect(host.querySelector('[role="status"]')?.textContent).toContain(
      'unavailable in live rendered HTML',
    )
    act(() => {
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(host.querySelector('[role="search"]')).toBeNull()
  })

  it('discloses bounded large-file search', () => {
    act(() => {
      root.render(
        <FindControl
          requestSerial={1}
          target={findTarget(0).value}
          boundedPreview
          onRequestHandled={vi.fn()}
        />,
      )
    })
    expect(host.textContent).toContain('Loaded preview only')
  })
})

function setInput(input: HTMLInputElement | null, value: string): void {
  act(() => {
    if (!input) return
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
      input,
      value,
    )
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function findTarget(total: number): {
  readonly value: ViewerFindTarget
  readonly update: ReturnType<typeof vi.fn>
  readonly clear: ReturnType<typeof vi.fn>
} {
  const update = vi.fn(
    (_query: ViewerFindQuery, requestedIndex: number): ViewerFindResult => ({
      current: total === 0 ? 0 : normalizeFindIndex(requestedIndex, total) + 1,
      total,
    }),
  )
  const clear = vi.fn()
  return {
    value: {
      update,
      clear,
      subscribe: vi.fn(() => () => undefined),
    },
    update,
    clear,
  }
}
