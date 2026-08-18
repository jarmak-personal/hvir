// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TabStrip } from '../src/renderer/src/viewer/TabStrip'
import type { ViewerTab } from '../src/renderer/src/viewer/tab-state'
import { localPath } from '../src/shared'

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

describe('dirty viewer tab close confirmation', () => {
  it('keeps a dirty tab on cancel and closes it only after destructive confirmation', () => {
    const onClose = vi.fn()
    renderStrip(tab(true), onClose)

    act(() => closeButton().click())
    expect(onClose).not.toHaveBeenCalled()
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain(
      'Close notes.md without saving?',
    )
    expect(button('Cancel')).toBe(document.activeElement)
    expect(button('Close without saving').className).toContain(
      'confirmation-action-destructive',
    )

    act(() => button('Cancel').click())
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()

    act(() => closeButton().click())
    act(() => button('Close without saving').click())
    expect(onClose).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledWith('tab-notes')
  })

  it('cancels with Escape and closes a clean tab without prompting', () => {
    const onClose = vi.fn()
    renderStrip(tab(true), onClose)
    act(() => closeButton().click())
    act(() => {
      button('Cancel').dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      )
    })
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()

    renderStrip(tab(false), onClose)
    act(() => closeButton().click())
    expect(onClose).toHaveBeenCalledWith('tab-notes')
    expect(host.querySelector('[role="dialog"]')).toBeNull()
  })
})

describe('viewer tab middle-click close', () => {
  it('closes an inactive clean file tab without activating it and suppresses auxiliary defaults', () => {
    const onActivate = vi.fn()
    const onClose = vi.fn()
    renderStrip(tab(false), onClose, { activeId: undefined, onActivate })

    const events = middleClick(viewerTab())

    expect(events.mouseDown.defaultPrevented).toBe(true)
    expect(events.auxClick.defaultPrevented).toBe(true)
    expect(onClose).toHaveBeenCalledWith('tab-notes')
    expect(onActivate).not.toHaveBeenCalled()
    expect(host.querySelector('[role="dialog"]')).toBeNull()
  })

  it('routes dirty secondary tabs through the existing confirmation', () => {
    const onActivate = vi.fn()
    const onClose = vi.fn()
    renderStrip({ ...tab(true), pane: 'secondary' }, onClose, {
      pane: 'secondary',
      activeId: undefined,
      onActivate,
    })

    const events = middleClick(viewerTab())

    expect(events.auxClick.defaultPrevented).toBe(true)
    expect(onActivate).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain(
      'Close notes.md without saving?',
    )

    act(() => button('Close without saving').click())
    expect(onClose).toHaveBeenCalledWith('tab-notes')
  })

  it('uses the existing Git-history and web-pane close owners without activation', () => {
    const onActivateGraph = vi.fn()
    const onCloseGraph = vi.fn()
    const onActivateWeb = vi.fn()
    const onCloseWeb = vi.fn()
    renderStrip(tab(false), vi.fn(), {
      graphOpen: true,
      onActivateGraph,
      onCloseGraph,
      webTabs: [{ id: 'web-1', title: 'localhost:3000' }],
      onActivateWeb,
      onCloseWeb,
    })

    const graphEvents = middleClick(requiredElement('.git-graph-tab'))
    const webEvents = middleClick(requiredElement('.web-pane-tab'))

    expect(graphEvents.auxClick.defaultPrevented).toBe(true)
    expect(webEvents.auxClick.defaultPrevented).toBe(true)
    expect(onCloseGraph).toHaveBeenCalledOnce()
    expect(onCloseWeb).toHaveBeenCalledWith('web-1')
    expect(onActivateGraph).not.toHaveBeenCalled()
    expect(onActivateWeb).not.toHaveBeenCalled()
  })

  it('leaves left activation and double-click pinning unchanged', () => {
    const onActivate = vi.fn()
    const onPin = vi.fn()
    renderStrip(tab(false), vi.fn(), { onActivate, onPin })

    act(() => {
      requiredElement<HTMLButtonElement>('.tab-main').click()
      viewerTab().dispatchEvent(
        new MouseEvent('dblclick', { button: 0, bubbles: true, cancelable: true }),
      )
    })

    expect(onActivate).toHaveBeenCalledWith('tab-notes')
    expect(onPin).toHaveBeenCalledWith('tab-notes')
  })
})

function renderStrip(
  openTab: ViewerTab,
  onClose: (id: string) => void,
  overrides: Partial<{
    readonly pane: 'primary' | 'secondary'
    readonly activeId: string
    readonly onActivate: (id: string) => void
    readonly onPin: (id: string) => void
    readonly graphOpen: boolean
    readonly onActivateGraph: () => void
    readonly onCloseGraph: () => void
    readonly webTabs: readonly { readonly id: string; readonly title: string }[]
    readonly onActivateWeb: (id: string) => void
    readonly onCloseWeb: (id: string) => void
  }> = {},
): void {
  act(() => {
    root.render(
      <TabStrip
        tabs={[openTab]}
        pane={overrides.pane ?? 'primary'}
        activeId={'activeId' in overrides ? overrides.activeId : openTab.id}
        onActivate={overrides.onActivate ?? vi.fn()}
        onClose={onClose}
        onPin={overrides.onPin ?? vi.fn()}
        onReorder={vi.fn()}
        onMoveToPane={vi.fn()}
        split={false}
        onSplit={vi.fn()}
        graphOpen={overrides.graphOpen ?? false}
        graphActive={false}
        onActivateGraph={overrides.onActivateGraph ?? vi.fn()}
        onCloseGraph={overrides.onCloseGraph ?? vi.fn()}
        webTabs={overrides.webTabs}
        onActivateWeb={overrides.onActivateWeb}
        onCloseWeb={overrides.onCloseWeb}
      />,
    )
  })
}

function tab(dirty: boolean): ViewerTab {
  const path = localPath('/repo/notes.md')
  return {
    id: 'tab-notes',
    path,
    pane: 'primary',
    pinned: true,
    mode: 'source',
    diffBase: 'head',
    position: { mode: 'source', line: 1, scrollTop: 0 },
    file: { path, content: 'draft', size: 5, mtimeMs: 1, binary: false },
    loading: false,
    dirty,
    conflict: false,
  }
}

function closeButton(): HTMLButtonElement {
  const match = host.querySelector<HTMLButtonElement>('[aria-label="Close notes.md"]')
  if (!match) throw new Error('Missing viewer close button')
  return match
}

function button(label: string): HTMLButtonElement {
  const match = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  )
  if (!match) throw new Error(`Missing button '${label}'`)
  return match
}

function viewerTab(): HTMLDivElement {
  return requiredElement('.viewer-tab:not(.git-graph-tab):not(.web-pane-tab)')
}

function requiredElement<T extends Element = HTMLDivElement>(selector: string): T {
  const match = host.querySelector<T>(selector)
  if (!match) throw new Error(`Missing element '${selector}'`)
  return match
}

function middleClick(target: Element): {
  readonly mouseDown: MouseEvent
  readonly auxClick: MouseEvent
} {
  const mouseDown = new MouseEvent('mousedown', {
    button: 1,
    bubbles: true,
    cancelable: true,
  })
  const auxClick = new MouseEvent('auxclick', {
    button: 1,
    bubbles: true,
    cancelable: true,
  })
  act(() => {
    target.dispatchEvent(mouseDown)
    target.dispatchEvent(auxClick)
  })
  return { mouseDown, auxClick }
}
