// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TerminalSearch } from '../src/renderer/src/terminal/TerminalSearch'
import type {
  TerminalPane,
  TerminalRetainedBufferRange,
} from '../src/renderer/src/terminal/terminal-pane'
import { TerminalSearchController } from '../src/renderer/src/terminal/terminal-search-controller'

let host: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
})

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('terminal search surface', () => {
  it('keeps the exact current result and surface when clipboard writing fails', async () => {
    const match = range(7, 3, 8, 2)
    const pane = paneFixture(match, 'e\u0301🙂\nwrapped')
    const controller = new TerminalSearchController(vi.fn(), vi.fn())
    controller.bind(pane)
    const root = createRoot(host)
    let rejectWrite: (reason: Error) => void = () => undefined
    const writeText = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectWrite = reject
        }),
    )
    act(() =>
      root.render(
        <TerminalSearch controller={controller} canCopyRegion writeText={writeText} />,
      ),
    )
    act(() => {
      controller.open()
      controller.setQuery('wrapped')
    })
    await act(async () => {
      await vi.waitFor(() => expect(controller.snapshot().matchCount).toBe(1))
    })

    act(() => {
      button('Copy Match').click()
    })
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledOnce())
    await act(() => {
      rejectWrite(new Error('denied'))
      return Promise.resolve()
    })

    expect(writeText).toHaveBeenCalledWith('e\u0301🙂\nwrapped')
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(
      /Could not copy/,
    )
    expect(document.querySelector('[role="search"]')).not.toBeNull()
    expect(controller.snapshot()).toMatchObject({
      open: true,
      query: 'wrapped',
      matchCount: 1,
      matchIndex: 0,
    })
    act(() => root.unmount())
  })

  it('copies an exact region as plain text and Escape closes with focus restoration', async () => {
    const pane = paneFixture(range(1, 0, 1, 2), 'hit')
    const restoreFocus = vi.fn()
    const controller = new TerminalSearchController(restoreFocus, () =>
      Promise.resolve('prompt\n$ cmd\n'),
    )
    controller.bind(pane)
    const root = createRoot(host)
    const writeText = vi.fn(() => Promise.resolve())
    act(() =>
      root.render(
        <TerminalSearch controller={controller} canCopyRegion writeText={writeText} />,
      ),
    )
    act(() => {
      controller.open()
    })

    await act(async () => {
      button('Copy Region').click()
      await vi.waitFor(() => expect(writeText).toHaveBeenCalledOnce())
    })
    expect(writeText).toHaveBeenCalledWith('prompt\n$ cmd\n')

    act(() => {
      document
        .querySelector<HTMLInputElement>('[aria-label="Find in terminal"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(controller.snapshot().open).toBe(false)
    expect(restoreFocus).toHaveBeenCalledOnce()
    act(() => root.unmount())
  })

  it('leaves Enter activation owned by copy, navigation, and close controls', async () => {
    const pane = paneFixture(range(2, 0, 2, 3), 'hit')
    const restoreFocus = vi.fn()
    const controller = new TerminalSearchController(restoreFocus, vi.fn())
    const navigate = vi.spyOn(controller, 'navigate')
    const writeText = vi.fn(() => Promise.resolve())
    controller.bind(pane)
    const root = createRoot(host)
    act(() =>
      root.render(
        <TerminalSearch controller={controller} canCopyRegion writeText={writeText} />,
      ),
    )
    act(() => {
      controller.open()
      controller.setQuery('hit')
    })
    await act(async () => {
      await vi.waitFor(() => expect(controller.snapshot().matchCount).toBe(1))
    })

    await act(async () => {
      activateWithEnter(button('Copy Match'))
      await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('hit'))
    })
    expect(navigate).not.toHaveBeenCalled()

    navigate.mockClear()
    act(() => activateWithEnter(ariaButton('Previous terminal match')))
    expect(navigate).toHaveBeenCalledExactlyOnceWith('previous')

    navigate.mockClear()
    act(() => activateWithEnter(ariaButton('Close terminal search')))
    expect(navigate).not.toHaveBeenCalled()
    expect(controller.snapshot().open).toBe(false)
    expect(restoreFocus).toHaveBeenCalledOnce()
    act(() => root.unmount())
  })
})

function button(label: string): HTMLButtonElement {
  const candidate = [...document.querySelectorAll('button')].find(
    (element) => element.textContent?.trim() === label,
  )
  if (!candidate) throw new Error(`Missing ${label} button`)
  return candidate
}

function ariaButton(label: string): HTMLButtonElement {
  const candidate = document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)
  if (!candidate) throw new Error(`Missing ${label} button`)
  return candidate
}

function activateWithEnter(control: HTMLButtonElement): void {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
  })
  if (control.dispatchEvent(event)) control.click()
}

function range(
  startRow: number,
  startColumn: number,
  endRow: number,
  endColumn: number,
): TerminalRetainedBufferRange {
  return {
    start: { row: startRow, column: startColumn },
    end: { row: endRow, column: endColumn },
  }
}

function paneFixture(match: TerminalRetainedBufferRange, text: string): TerminalPane {
  const listen = () => () => undefined
  return {
    mount: vi.fn(),
    reparent: vi.fn(),
    dispose: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    setTheme: vi.fn(),
    setTypography: vi.fn(),
    setPresentation: vi.fn(),
    redraw: vi.fn(),
    resolveEventProvenance: vi.fn(() => undefined),
    activeEventScreen: vi.fn(() => 'normal' as const),
    revealEventLocation: vi.fn(() => true),
    searchRetainedBuffer: vi.fn<TerminalPane['searchRetainedBuffer']>((query, options) =>
      Promise.resolve({
        query,
        caseSensitive: options.caseSensitive,
        matches: [match],
        reveal: (candidate: TerminalRetainedBufferRange) => candidate === match,
        extract: (candidate: TerminalRetainedBufferRange) =>
          candidate === match ? text : undefined,
        dispose: vi.fn(),
      }),
    ),
    cancelRetainedBufferSearch: vi.fn(),
    captureRetainedBufferBoundary: vi.fn(() => undefined),
    extractRetainedBufferRange: vi.fn(() => Promise.resolve('')),
    cancelRetainedBufferExtraction: vi.fn(),
    hasSelection: vi.fn(() => false),
    getSelection: vi.fn(() => ''),
    paste: vi.fn(),
    selectAll: vi.fn(),
    clear: vi.fn(),
    reset: vi.fn(),
    focus: vi.fn(),
    events: {
      onData: listen,
      onClipboardPaste: listen,
      onEvent: listen,
      onResize: listen,
      onLink: listen,
    },
  }
}
