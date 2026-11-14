// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TerminalRuntimeRegistry } from '../src/renderer/src/terminal/terminal-runtime-registry'
import { TerminalView } from '../src/renderer/src/terminal/TerminalView'
import { ghosttyLifecycleRuntimeOptions as runtimeOptions } from './fixtures/ghostty-lifecycle-runtime-options'

const viewState = vi.hoisted(() => ({
  live: true,
  current: true,
  selection: Promise.resolve(false),
}))

vi.mock('../src/renderer/src/terminal/use-terminal-pane-controller', () => ({
  useTerminalPaneController: () => ({
    containerRef: { current: null },
    live: viewState.live,
    title: 'Codex · repo',
    status: 'Ready',
    exited: false,
    semanticRegionsAvailable: false,
    semanticRegion: undefined,
    restart: vi.fn(),
    startFresh: vi.fn(),
    previousSemanticRegion: vi.fn(),
    nextSemanticRegion: vi.fn(),
    searchController: {},
    openSearch: vi.fn(),
    getContextMenuTarget: () => ({
      isCurrent: () => viewState.current,
      hasSelection: () => viewState.selection,
      getSelection: () => Promise.resolve(undefined),
      paste: () => viewState.current,
      selectAll: () => Promise.resolve(viewState.current),
      clear: () => Promise.resolve(viewState.current),
      reset: () => Promise.resolve(viewState.current),
      focus: () => viewState.current,
      onRevoked: () => () => undefined,
    }),
    focus: vi.fn(),
  }),
}))

vi.mock('../src/renderer/src/terminal/TerminalSearch', () => ({
  TerminalSearch: () => null,
}))

describe('TerminalView conversation fork binding', () => {
  let host: HTMLDivElement
  let root: Root
  let runtimes: TerminalRuntimeRegistry

  beforeEach(() => {
    viewState.live = true
    viewState.current = true
    viewState.selection = Promise.resolve(false)
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    runtimes = new TerminalRuntimeRegistry()
  })

  afterEach(() => {
    act(() => root.unmount())
    runtimes.dispose()
    document.body.replaceChildren()
  })

  it('binds the fork command to the exact TerminalView session target', async () => {
    const onFork = vi.fn()
    renderView({ sessionId: 'exact-target', onFork })

    await openContextMenu()
    const action = forkAction()
    expect(action.disabled).toBe(false)
    act(() => action.click())

    expect(onFork).toHaveBeenCalledOnce()
    expect(onFork).toHaveBeenCalledWith('exact-target')
  })

  it.each([
    ['non-live', false, true],
    ['non-current', true, false],
  ])('fails closed for a %s TerminalView target', async (_case, live, current) => {
    viewState.live = live
    viewState.current = current
    const onFork = vi.fn()
    renderView({ sessionId: 'unavailable-target', onFork })

    await openContextMenu()
    const action = forkAction()
    expect(action.disabled).toBe(true)
    expect(action.title).toContain('no longer live')
    act(() => action.click())
    expect(onFork).not.toHaveBeenCalled()
  })

  it('states the forkPending disabled reason on the exact TerminalView target', async () => {
    renderView({ sessionId: 'pending-target', forkPending: true })

    await openContextMenu()
    const action = forkAction()
    expect(action.disabled).toBe(true)
    expect(action.title).toContain('already starting')
    expect(action.textContent).toContain('already starting')
  })

  function renderView(overrides: {
    readonly sessionId: string
    readonly onFork?: (sessionId: string) => void
    readonly forkPending?: true
  }): void {
    act(() => {
      root.render(
        <TerminalView
          {...runtimeOptions()}
          {...overrides}
          onFork={overrides.onFork ?? vi.fn()}
          visible
          slot="primary"
          themeOverride="app"
          runtimes={runtimes}
        />,
      )
    })
  }

  async function openContextMenu(): Promise<void> {
    await act(async () => {
      host
        .querySelector<HTMLElement>('.terminal-container')
        ?.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
        )
      await viewState.selection
    })
  }
})

function forkAction(): HTMLButtonElement {
  const action = document.querySelector<HTMLButtonElement>(
    '.terminal-context-menu-explained',
  )
  if (!action) throw new Error('fork action was not rendered')
  return action
}
