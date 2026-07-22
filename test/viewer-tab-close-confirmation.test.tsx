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

function renderStrip(openTab: ViewerTab, onClose: (id: string) => void): void {
  act(() => {
    root.render(
      <TabStrip
        tabs={[openTab]}
        pane="primary"
        activeId={openTab.id}
        onActivate={vi.fn()}
        onClose={onClose}
        onPin={vi.fn()}
        onReorder={vi.fn()}
        onMoveToPane={vi.fn()}
        split={false}
        onSplit={vi.fn()}
        graphOpen={false}
        graphActive={false}
        onActivateGraph={vi.fn()}
        onCloseGraph={vi.fn()}
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
