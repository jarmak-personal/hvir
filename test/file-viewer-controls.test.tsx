// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FileViewer } from '../src/renderer/src/viewer/FileViewer'
import type { ViewerTab } from '../src/renderer/src/viewer/tab-state'
import { localPath, type ViewMode } from '../src/shared'

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
  vi.restoreAllMocks()
})

describe('FileViewer controls', () => {
  it('floats the visible mode controls inside the viewer without a filename bar', () => {
    const onMode = vi.fn()
    renderViewer(tab({ mode: 'rendered' }), { onMode })

    const body = host.querySelector('.viewer-body')
    const controls = host.querySelector('.viewer-floating-controls')
    const modeButtons = [
      ...host.querySelectorAll<HTMLButtonElement>('.mode-control button'),
    ]

    expect(controls?.parentElement).toBe(body)
    expect(host.querySelector('.viewer-toolbar')).toBeNull()
    expect(host.querySelector('.viewer-title')).toBeNull()
    expect(modeButtons.map((button) => button.textContent)).toEqual([
      'rendered',
      'source',
      'diff',
    ])
    expect(modeButtons[0]?.classList.contains('active')).toBe(true)

    act(() => modeButtons[1]?.click())
    expect(onMode).toHaveBeenCalledWith('source', undefined)

    const compactMode = host.querySelector<HTMLSelectElement>('.mode-select')
    act(() => {
      if (!compactMode) return
      compactMode.value = 'diff'
      compactMode.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onMode).toHaveBeenLastCalledWith('diff', undefined)
  })

  it('keeps conflict, blame, and diff-base actions in the floating controls', () => {
    const onReload = vi.fn()
    const onDiffBase = vi.fn()

    renderViewer(tab({ mode: 'source', conflict: true }), { onReload, onDiffBase })
    const reload = host.querySelector<HTMLButtonElement>('.conflict-badge')
    expect(reload?.textContent).toContain('reload')
    expect(host.querySelector('.blame-toggle')).toBeTruthy()
    act(() => reload?.click())
    expect(onReload).toHaveBeenCalledOnce()

    renderViewer(tab({ mode: 'diff' }), { onReload, onDiffBase })
    const diffBase = host.querySelector<HTMLSelectElement>('.diff-base-select')
    expect(diffBase?.value).toBe('head')
    act(() => {
      if (!diffBase) return
      diffBase.value = 'branch-point'
      diffBase.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onDiffBase).toHaveBeenCalledWith('branch-point')
  })
})

function tab(
  overrides: Partial<Pick<ViewerTab, 'mode' | 'conflict'>> & { mode: ViewMode },
): ViewerTab {
  const path = localPath('/repo/design.md')
  return {
    id: 'tab-1',
    path,
    pane: 'primary',
    pinned: true,
    mode: overrides.mode,
    diffBase: 'head',
    position: { mode: overrides.mode, line: 1, scrollTop: 0 },
    file: { path, content: '# Design', size: 8, mtimeMs: 1, binary: false },
    loading: true,
    dirty: false,
    conflict: overrides.conflict ?? false,
  }
}

function renderViewer(
  activeTab: ViewerTab,
  overrides: {
    readonly onMode?: (mode: ViewMode) => void
    readonly onDiffBase?: (base: 'working-tree' | 'head' | 'branch-point') => void
    readonly onReload?: () => void
  } = {},
): void {
  act(() => {
    root.render(
      <FileViewer
        tab={activeTab}
        onMode={overrides.onMode ?? vi.fn()}
        onDiffBase={overrides.onDiffBase ?? vi.fn()}
        onContent={vi.fn()}
        onSave={vi.fn()}
        onReload={overrides.onReload ?? vi.fn()}
        onPosition={vi.fn()}
        onNavigationHandled={vi.fn()}
        onOpenPath={vi.fn()}
        refreshVersion={0}
      />,
    )
  })
}
