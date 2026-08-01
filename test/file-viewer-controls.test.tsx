// @vitest-environment happy-dom

import { EditorView } from '@codemirror/view'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FileViewer } from '../src/renderer/src/viewer/FileViewer'
import type { ViewerTab } from '../src/renderer/src/viewer/tab-state'
import { DIFF_INTERACTIVE_BYTE_LIMIT } from '../src/renderer/src/viewer/viewer-workload-policy'
import {
  localPath,
  type GitDiffResponse,
  type ViewMode,
} from '../src/shared'

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

    act(() => modeButtons[0]?.click())
    expect(onMode).not.toHaveBeenCalled()
    expect(host.querySelector('.mode-control')?.classList.contains('expanded')).toBe(true)

    act(() => modeButtons[1]?.click())
    expect(onMode).toHaveBeenCalledWith('source', undefined)
    expect(host.querySelector('.mode-control')?.classList.contains('expanded')).toBe(
      false,
    )

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

  it('uses the disclosed bounded fallback instead of MergeView above the diff budget', async () => {
    const response = diffResponse({
      baseBytes: DIFF_INTERACTIVE_BYTE_LIMIT,
      currentBytes: 1,
    })
    const invoke = vi.fn().mockResolvedValue(response)
    Object.defineProperty(window, 'hvir', {
      configurable: true,
      value: { invoke },
    })

    renderViewer(tab({ mode: 'diff', loading: false }))
    await act(async () => {
      await settle()
    })

    expect(host.querySelector('.cm-mergeView')).toBeNull()
    expect(host.querySelector('.diff-fallback')?.textContent).toContain(
      'interactive diff byte budget',
    )
    expect(host.querySelector('.diff-fallback')?.textContent).toContain('/repo/design.md')
    expect(host.querySelector('.diff-fallback')?.textContent).toContain(
      'Requested comparison: HEAD → Working tree',
    )
  })

  it('still constructs MergeView below the diff budget even for a large source file', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValue(diffResponse({ baseBytes: 5, currentBytes: 8 }))
    Object.defineProperty(window, 'hvir', {
      configurable: true,
      value: { invoke },
    })

    renderViewer(
      tab({
        mode: 'diff',
        loading: false,
        size: 5 * 1024 * 1024 + 1,
      }),
    )
    await act(async () => {
      await settle()
    })

    expect(host.querySelector('.cm-mergeView')).toBeTruthy()
    expect(host.querySelector('.large-file-shell')).toBeNull()
  })

  it('discloses partial Git input without presenting a complete diff', async () => {
    const invoke = vi.fn().mockResolvedValue(
      diffResponse({
        baseBytes: 5,
        currentBytes: 8,
        baseComplete: false,
      }),
    )
    Object.defineProperty(window, 'hvir', {
      configurable: true,
      value: { invoke },
    })

    renderViewer(tab({ mode: 'diff', loading: false }))
    await act(async () => {
      await settle()
    })

    expect(host.querySelector('.cm-mergeView')).toBeNull()
    expect(host.querySelector('.diff-fallback')?.textContent).toContain(
      'incomplete comparison is not shown',
    )
    expect(host.querySelector('.diff-fallback')?.textContent).toContain('partial input')
  })

  it('reports measured included lines for an oversized unsaved buffer', async () => {
    const content = `${'x'.repeat(DIFF_INTERACTIVE_BYTE_LIMIT)}\nsecond`
    const invoke = vi
      .fn()
      .mockResolvedValue(diffResponse({ baseBytes: 1, currentBytes: 1 }))
    Object.defineProperty(window, 'hvir', {
      configurable: true,
      value: { invoke },
    })

    renderViewer(
      tab({
        mode: 'diff',
        loading: false,
        content,
        size: new TextEncoder().encode(content).byteLength,
        dirty: true,
      }),
    )
    await act(async () => {
      await settle()
    })

    expect(host.querySelector('.cm-mergeView')).toBeNull()
    expect(host.querySelector('.diff-fallback')?.textContent).toContain(
      'Working tree (unsaved)complete input · 2.0 MiB included · 2 included lines',
    )
  })

  it('validates and submits a visible go-to-line control', () => {
    const onMode = vi.fn()
    renderViewer(tab({ mode: 'rendered' }), { onMode })

    act(() => host.querySelector<HTMLButtonElement>('.go-to-line-toggle')?.click())
    const input = host.querySelector<HTMLInputElement>('[aria-label="Go to line"] input')
    expect(input).toBeTruthy()
    act(() => {
      if (!input) return
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        '2',
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      if (!input) return
      input
        .closest('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(host.querySelector('[role="status"]')?.textContent).toContain(
      'outside this document',
    )
    expect(onMode).not.toHaveBeenCalled()

    act(() => {
      if (!input) return
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        '1:3',
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      if (!input) return
      input
        .closest('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(onMode).toHaveBeenCalledWith('source', undefined)
  })

  it('acknowledges a tab-scoped keyboard request when the control opens', () => {
    const onNavigationHandled = vi.fn()
    let target: { readonly goToLine: () => void } | undefined
    renderViewer(tab({ mode: 'source' }), {
      onNavigationHandled,
      registerCommands: (_tabId, next) => {
        target = next
        return () => undefined
      },
    })
    act(() => target?.goToLine())

    expect(host.querySelector('[aria-label="Go to line"]')).toBeTruthy()
    expect(onNavigationHandled).not.toHaveBeenCalled()
  })

  it('finds current unsaved source content and refreshes counts after edits', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0)
      return 1
    })
    let target:
      Parameters<Parameters<typeof FileViewer>[0]['registerCommands']>[1] | undefined
    renderViewer(
      tab({
        mode: 'source',
        loading: false,
        content: 'needle one\nNEEDLE two',
        size: 1024 * 1024 + 1,
      }),
      {
        registerCommands: (_tabId, next) => {
          target = next
          return () => undefined
        },
      },
    )

    act(() => target?.findInFile())
    const input = host.querySelector<HTMLInputElement>(
      '[aria-label="Find in file"] input',
    )
    setInput(input, 'needle')
    expect(
      host.querySelector('[aria-label="Find in file"] [role="status"]')?.textContent,
    ).toBe('1 of 2')

    act(() => {
      const editor = editorView()
      editor.dispatch({
        changes: { from: editor.state.doc.length, insert: '\nneedle three' },
      })
    })
    expect(
      host.querySelector('[aria-label="Find in file"] [role="status"]')?.textContent,
    ).toBe('1 of 3')
  })

  it('closes on Escape and restores focus to the previous viewer surface', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0)
      return 1
    })
    const previous = document.createElement('button')
    document.body.append(previous)
    previous.focus()
    renderViewer(tab({ mode: 'source' }))

    act(() => host.querySelector<HTMLButtonElement>('.go-to-line-toggle')?.click())
    const input = host.querySelector<HTMLInputElement>('[aria-label="Go to line"] input')
    expect(document.activeElement).toBe(input)
    act(() => {
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    expect(host.querySelector('[aria-label="Go to line"]')).toBeNull()
    expect(document.activeElement).toBe(previous)
    previous.remove()
  })

  it('keeps the original focus owner across repeated keyboard requests', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0)
      return 1
    })
    const previous = document.createElement('button')
    document.body.append(previous)
    previous.focus()
    let target: { readonly goToLine: () => void } | undefined
    renderViewer(tab({ mode: 'source' }), {
      registerCommands: (_tabId, next) => {
        target = next
        return () => undefined
      },
    })

    act(() => target?.goToLine())
    const input = host.querySelector<HTMLInputElement>('[aria-label="Go to line"] input')
    expect(document.activeElement).toBe(input)
    act(() => target?.goToLine())
    expect(document.activeElement).toBe(input)
    act(() => {
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    expect(document.activeElement).toBe(previous)
    previous.remove()
  })

  it('toggles closed and dismisses on an outside pointer press', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0)
      return 1
    })
    const outside = document.createElement('button')
    document.body.append(outside)
    renderViewer(tab({ mode: 'source' }))
    const toggle = host.querySelector<HTMLButtonElement>('.go-to-line-toggle')

    act(() => toggle?.click())
    expect(host.querySelector('[aria-label="Go to line"]')).toBeTruthy()
    act(() => toggle?.click())
    expect(host.querySelector('[aria-label="Go to line"]')).toBeNull()

    act(() => toggle?.click())
    act(() => {
      outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      outside.focus()
    })
    expect(host.querySelector('[aria-label="Go to line"]')).toBeNull()
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })

  it('acknowledges invalid terminal coordinates without moving the editor', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0)
      return 1
    })
    const onNavigationHandled = vi.fn()
    renderViewer(
      tab({
        mode: 'source',
        loading: false,
        content: 'alpha\nbeta',
        size: 1024 * 1024 + 1,
        navigation: { line: 99, column: 1, serial: 42 },
      }),
      { onNavigationHandled },
    )

    expect(onNavigationHandled).toHaveBeenCalledWith(42)
    expect(editorView().state.selection.main.head).toBe(0)
  })

  it('routes manual coordinates locally, focuses source, and does not acknowledge externally', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0)
      return 1
    })
    const onMode = vi.fn()
    const onNavigationHandled = vi.fn()
    renderViewer(
      tab({
        mode: 'source',
        loading: false,
        content: 'alpha\nbeta',
        size: 1024 * 1024 + 1,
      }),
      { onMode, onNavigationHandled },
    )

    act(() => host.querySelector<HTMLButtonElement>('.go-to-line-toggle')?.click())
    const input = host.querySelector<HTMLInputElement>('[aria-label="Go to line"] input')
    act(() => {
      if (!input) return
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        '1:3',
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input
        .closest('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(onMode).toHaveBeenCalledWith('source', expect.any(Object))
    expect(onNavigationHandled).not.toHaveBeenCalled()
    expect(editorView().state.selection.main.head).toBe(2)
    expect(document.activeElement).toBe(host.querySelector('.cm-content'))
  })
})

function tab(
  overrides: Partial<
    Pick<ViewerTab, 'mode' | 'conflict' | 'dirty' | 'loading' | 'navigation'>
  > & {
    mode: ViewMode
    content?: string
    size?: number
  },
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
    file: {
      path,
      content: overrides.content ?? '# Design',
      size: overrides.size ?? 8,
      mtimeMs: 1,
      binary: false,
    },
    loading: overrides.loading ?? true,
    navigation: overrides.navigation,
    dirty: overrides.dirty ?? false,
    conflict: overrides.conflict ?? false,
  }
}

function editorView(): EditorView {
  const editor = host.querySelector<HTMLElement>('.cm-editor')
  if (!editor) throw new Error('Expected CodeMirror editor')
  const view = EditorView.findFromDOM(editor)
  if (!view) throw new Error('Expected CodeMirror view')
  return view
}

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

function renderViewer(
  activeTab: ViewerTab,
  overrides: {
    readonly onMode?: (mode: ViewMode) => void
    readonly onDiffBase?: (base: 'working-tree' | 'head' | 'branch-point') => void
    readonly onReload?: () => void
    readonly onNavigationHandled?: (serial: number) => void
    readonly registerCommands?: Parameters<typeof FileViewer>[0]['registerCommands']
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
        onNavigationHandled={overrides.onNavigationHandled ?? vi.fn()}
        registerCommands={overrides.registerCommands ?? (() => () => undefined)}
        onOpenPath={vi.fn()}
        refreshVersion={0}
      />,
    )
  })
}

function diffResponse({
  baseBytes,
  currentBytes,
  baseComplete = true,
  currentComplete = true,
}: {
  readonly baseBytes: number
  readonly currentBytes: number
  readonly baseComplete?: boolean
  readonly currentComplete?: boolean
}): GitDiffResponse {
  return {
    path: localPath('/repo/design.md'),
    base: 'head',
    baseLabel: 'HEAD',
    currentLabel: 'Working tree',
    baseInput: {
      content: 'base\n',
      byteLength: baseBytes,
      lineCount: 2,
      complete: baseComplete,
    },
    currentInput: {
      content: 'current\n',
      byteLength: currentBytes,
      lineCount: 2,
      complete: currentComplete,
    },
  }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
