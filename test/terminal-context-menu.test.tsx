// @vitest-environment happy-dom

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TerminalContextMenu } from '../src/renderer/src/terminal/TerminalContextMenu'
import { boundTerminalContextMenuPosition } from '../src/renderer/src/terminal/terminal-context-menu-position'
import {
  TerminalContextMenuOwner,
  type TerminalContextMenuTarget,
} from '../src/renderer/src/terminal/terminal-context-menu-target'
import type { TerminalPane } from '../src/renderer/src/terminal/terminal-pane'
import { TerminalRuntimeInteractions } from '../src/renderer/src/terminal/terminal-runtime-interactions'
import { useTerminalContextMenu } from '../src/renderer/src/terminal/use-terminal-context-menu'
import type { TerminalForkAvailability } from '../src/renderer/src/terminal/terminal-fork-policy'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('terminal context menu placement', () => {
  it('keeps every menu edge inside the viewport margin', () => {
    expect(
      boundTerminalContextMenuPosition(
        { x: 790, y: 590 },
        { width: 800, height: 600 },
        { width: 232, height: 230 },
      ),
    ).toEqual({ x: 560, y: 362 })
    expect(
      boundTerminalContextMenuPosition(
        { x: -20, y: -40 },
        { width: 800, height: 600 },
        { width: 232, height: 230 },
      ),
    ).toEqual({ x: 8, y: 8 })
  })
})

describe('terminal context menu ownership', () => {
  it('clears semantic transcript metadata with both retained-buffer clearing actions', async () => {
    const interactions = new TerminalRuntimeInteractions(
      'Shell',
      () => true,
      vi.fn(),
      vi.fn(),
    )
    const fixture = paneFixture()
    interactions.updateAvailability(true)
    interactions.bind(fixture.pane, 'pty-instance-1')
    const addRegion = (id: number) => {
      interactions.paneEvents.handle({
        type: 'semantic',
        action: 'fresh-line-new-prompt',
        options: '',
        provenance: { id, screen: 'normal', row: id, column: 0 },
      })
      expect(interactions.paneEvents.snapshot().semanticRegionsAvailable).toBe(true)
    }

    addRegion(1)
    expect(await interactions.contextMenuTarget()?.clear()).toBe(true)
    expect(fixture.clear).toHaveBeenCalledOnce()
    expect(interactions.paneEvents.snapshot().semanticRegionsAvailable).toBe(false)

    addRegion(2)
    expect(await interactions.contextMenuTarget()?.reset()).toBe(true)
    expect(fixture.reset).toHaveBeenCalledOnce()
    expect(interactions.paneEvents.snapshot().semanticRegionsAvailable).toBe(false)
  })

  it('binds only one visible attached pane and rejects a same-id successor', async () => {
    let available = true
    const owner = new TerminalContextMenuOwner(() => available)
    const original = paneFixture()
    const successor = paneFixture()
    owner.bind(original.pane, 'pty-instance-1', vi.fn())
    const originalTarget = owner.target()

    expect(await originalTarget?.reset()).toBe(true)
    available = false
    expect(owner.target()).toBeUndefined()
    expect(await originalTarget?.clear()).toBe(false)

    available = true
    owner.bind(successor.pane, 'pty-instance-2', vi.fn())
    expect(await originalTarget?.reset()).toBe(false)
    expect(await owner.target()?.reset()).toBe(true)
    expect(original.reset).toHaveBeenCalledOnce()
    expect(successor.reset).toHaveBeenCalledOnce()

    owner.revoke()
    expect(owner.target()).toBeUndefined()
  })

  it('opens from pointer and both keyboard gestures, disabling Copy without selection', async () => {
    const fixture = targetFixture('')
    renderMenu(fixture.target)
    const terminal = terminalTarget()

    await openFromPointer(terminal)
    expect(menuButton('Copy Selection').disabled).toBe(true)
    expect(fixture.focus).not.toHaveBeenCalled()

    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()
    dismissOutside(outside)
    expect(outside).toBe(document.activeElement)
    expect(fixture.focus).not.toHaveBeenCalled()
    terminal.focus()
    await openFromKeyboard(terminal, 'ContextMenu')
    expect(menuButton('Paste')).toBe(document.activeElement)

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(fixture.focus).toHaveBeenCalledOnce()
    expect(terminal).toBe(document.activeElement)

    await openFromKeyboard(terminal, 'F10', true)
    expect(menuButton('Paste')).toBe(document.activeElement)
  })

  it.each([true, false])(
    'waits for actual selection status %s before keyboard focus chooses the first enabled item',
    async (available) => {
      const fixture = targetFixture('selected'),
        status = selectionStatus()
      fixture.target.hasSelection = () => status.promise
      renderMenu(fixture.target)
      await openFromKeyboard(terminalTarget(), 'ContextMenu')
      expect(document.activeElement).toBe(document.querySelector('[role="menu"]'))
      expect(menuButton('Copy Selection').disabled).toBe(true)
      await act(async () => {
        status.resolve(available)
        await status.promise
      })
      expect(document.activeElement).toBe(
        menuButton(available ? 'Copy Selection' : 'Paste'),
      )
    },
  )

  it('settles a refused selection query without leaving keyboard focus stranded', async () => {
    const fixture = targetFixture('selected'),
      status = selectionStatus()
    fixture.target.hasSelection = () => status.promise
    renderMenu(fixture.target)
    await openFromKeyboard(terminalTarget(), 'ContextMenu')
    await act(async () => {
      status.reject(new Error('unavailable'))
      await status.promise.catch(() => undefined)
    })
    expect(menuButton('Copy Selection').disabled).toBe(true)
    expect(document.activeElement).toBe(menuButton('Paste'))
  })

  it.each(['navigation-down', 'navigation-up', 'outside', 'pointer'] as const)(
    'preserves %s focus when pending selection status resolves',
    async (mode) => {
      const fixture = targetFixture('selected'),
        status = selectionStatus()
      fixture.target.hasSelection = () => status.promise
      renderMenu(fixture.target)
      const terminal = terminalTarget()
      terminal.focus()
      if (mode === 'pointer') await openFromPointer(terminal)
      else await openFromKeyboard(terminal, 'ContextMenu')
      if (mode.startsWith('navigation'))
        act(() => {
          document.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: mode === 'navigation-up' ? 'ArrowUp' : 'ArrowDown',
              bubbles: true,
            }),
          )
        })
      const outside = document.createElement('button')
      if (mode === 'outside') {
        document.body.append(outside)
        outside.focus()
      }
      const focused = document.activeElement
      await act(async () => {
        status.resolve(true)
        await status.promise
      })
      expect(menuButton('Copy Selection').disabled).toBe(false)
      expect(document.activeElement).toBe(focused)
      if (mode === 'navigation-down') expect(focused).toBe(menuButton('Paste'))
      if (mode === 'navigation-up') expect(focused).toBe(menuButton('Terminal Settings'))
      if (mode === 'pointer') expect(focused).toBe(terminal)
    },
  )

  it('ignores the old selection result after a newer keyboard menu request', async () => {
    const fixture = targetFixture('selected'),
      first = selectionStatus(),
      second = selectionStatus()
    fixture.target.hasSelection = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    renderMenu(fixture.target)
    await openFromKeyboard(terminalTarget(), 'ContextMenu')
    await openFromKeyboard(terminalTarget(), 'ContextMenu')
    const menu = document.querySelector('[role="menu"]')
    await act(async () => {
      first.resolve(true)
      await first.promise
    })
    expect(document.activeElement).toBe(menu)
    expect(menuButton('Copy Selection').disabled).toBe(true)
    await act(async () => {
      second.resolve(false)
      await second.promise
    })
    expect(document.activeElement).toBe(menuButton('Paste'))
  })

  it('captures pointer-menu Escape before the focused terminal can emit it', async () => {
    const fixture = targetFixture('')
    renderMenu(fixture.target)
    const terminal = terminalTarget()
    const terminalKeydown = vi.fn()
    terminal.addEventListener('keydown', terminalKeydown)
    terminal.focus()
    await openFromPointer(terminal)

    const escape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    })
    act(() => {
      terminal.dispatchEvent(escape)
    })

    expect(escape.defaultPrevented).toBe(true)
    expect(terminalKeydown).not.toHaveBeenCalled()
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(fixture.focus).toHaveBeenCalledOnce()
    expect(terminal).toBe(document.activeElement)
  })

  it('keeps the menu disabled after a clipboard write is observed until that write settles', async () => {
    const fixture = targetFixture('selected')
    let finish!: () => void
    const writeText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    renderMenu(fixture.target, { writeText })
    await openFromPointer(terminalTarget())
    await clickMenuButton('Copy Selection')
    expect(writeText).toHaveBeenCalledExactlyOnceWith('selected')
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    expect(buttons.length).toBeGreaterThan(0)
    expect(buttons.every((button) => button.disabled)).toBe(true)
    await act(async () => {
      finish()
      await writeText.mock.results[0]!.value
    })
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(fixture.focus).toHaveBeenCalledOnce()
  })

  it('copies exact plain text and preserves selection when clipboard writing fails', async () => {
    const fixture = targetFixture('first\nsecond')
    const writeText = vi.fn<(value: string) => Promise<void>>()
    writeText.mockRejectedValue(new Error('denied'))
    renderMenu(fixture.target, { writeText })

    await openFromPointer(terminalTarget())
    await clickMenuButton('Copy Selection')

    expect(writeText).toHaveBeenCalledExactlyOnceWith('first\nsecond')
    expect(fixture.getSelection).toHaveBeenCalledOnce()
    expect(fixture.clear).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'Could not copy the selection to the clipboard.',
    )
  })

  it('never commits a deferred extracted selection after its exact source is revoked', async () => {
    const fixture = targetFixture('selected'),
      writeText = vi.fn(() => Promise.resolve())
    let finish!: (value: string) => void
    fixture.getSelection.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    renderMenu(fixture.target, { writeText })
    await openFromPointer(terminalTarget())
    act(() => menuButton('Copy Selection').click())
    act(() => fixture.revoke())
    await act(async () => {
      finish('old selected text')
      await Promise.resolve()
    })
    expect(writeText).not.toHaveBeenCalled()
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })
  it('reads text only after Paste activation and preserves exact bracketed-paste input', async () => {
    const fixture = targetFixture('')
    const readText = vi
      .fn<() => Promise<string>>()
      .mockResolvedValue('line one\nline two')
    renderMenu(fixture.target, { readText })

    await openFromPointer(terminalTarget())
    expect(readText).not.toHaveBeenCalled()
    await clickMenuButton('Paste')

    expect(readText).toHaveBeenCalledOnce()
    expect(fixture.paste).toHaveBeenCalledExactlyOnceWith('line one\nline two')
    expect(document.querySelector('.terminal-context-feedback')).toBeNull()
  })

  it('injects nothing and reports visible feedback when text clipboard access fails', async () => {
    const fixture = targetFixture('')
    const readText = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('denied'))
    renderMenu(fixture.target, { readText })

    await openFromPointer(terminalTarget())
    await clickMenuButton('Paste')

    expect(fixture.paste).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'Could not read plain text from the clipboard.',
    )
  })

  it('injects nothing when the text clipboard is empty', async () => {
    const fixture = targetFixture('')
    const readText = vi.fn<() => Promise<string>>().mockResolvedValue('')
    renderMenu(fixture.target, { readText })

    await openFromPointer(terminalTarget())
    await clickMenuButton('Paste')

    expect(fixture.paste).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'Clipboard does not contain plain text.',
    )
  })

  it('routes terminal, split, and Settings actions to their existing narrow owners', async () => {
    const fixture = targetFixture('selected')
    const onSplit = vi.fn()
    const onOpenSettings = vi.fn()
    renderMenu(fixture.target, { onSplit, onOpenSettings })

    for (const [label, action] of [
      ['Select All', fixture.selectAll],
      ['Clear Screen and Scrollback', fixture.clear],
      ['Reset Terminal', fixture.reset],
    ] as const) {
      await openFromPointer(terminalTarget())
      await clickMenuButton(label)
      expect(action).toHaveBeenCalledOnce()
    }

    await openFromPointer(terminalTarget())
    await clickMenuButton('Split Terminal')
    await openFromPointer(terminalTarget())
    await clickMenuButton('Terminal Settings…')

    expect(onSplit).toHaveBeenCalledOnce()
    expect(onOpenSettings).toHaveBeenCalledOnce()
  })

  it('invokes one exact-target conversation fork and dismisses the menu', async () => {
    const fixture = targetFixture('')
    const onFork = vi.fn()
    renderMenu(fixture.target, {
      onFork,
      forkAvailability: { available: true },
    })

    await openFromPointer(terminalTarget())
    const action = menuButton('Fork Conversation to New Terminal')
    await clickMenuButton('Fork Conversation to New Terminal')
    action.click()

    expect(onFork).toHaveBeenCalledOnce()
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it.each([
    'This harness provider does not support exact conversation forks.',
    'The probed harness version does not support exact conversation forks.',
    'This terminal does not have an exact current conversation identity.',
    'The observed conversation identity diverged from this terminal.',
    'This terminal is no longer live.',
  ])('states a disabled fork reason: %s', async (reason) => {
    const fixture = targetFixture('')
    const onFork = vi.fn()
    renderMenu(fixture.target, {
      onFork,
      forkAvailability: { available: false, reason },
    })

    await openFromPointer(terminalTarget())
    const action = menuButton('Fork Conversation to New Terminal')

    expect(action.disabled).toBe(true)
    expect(action.title).toBe(reason)
    expect(action.textContent).toContain(reason)
    action.click()
    expect(onFork).not.toHaveBeenCalled()
  })

  it('revokes the exact fork target before a stale action can run', async () => {
    const fixture = targetFixture('')
    const onFork = vi.fn()
    renderMenu(fixture.target, {
      onFork,
      forkAvailability: { available: true },
    })

    await openFromPointer(terminalTarget())
    act(() => fixture.revoke())

    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(onFork).not.toHaveBeenCalled()
  })

  it('keeps menu clicks from reaching terminal-owned document selection handlers', async () => {
    const fixture = targetFixture('')
    const documentClick = vi.fn()
    document.addEventListener('click', documentClick)
    renderMenu(fixture.target)

    await openFromPointer(terminalTarget())
    await clickMenuButton('Select All')

    expect(fixture.selectAll).toHaveBeenCalledOnce()
    expect(documentClick).not.toHaveBeenCalled()
    document.removeEventListener('click', documentClick)
  })

  it('revokes a pending clipboard read before it can act on a successor', async () => {
    const fixture = targetFixture('')
    let completeRead: ((value: string) => void) | undefined
    const readText = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          completeRead = resolve
        }),
    )
    renderMenu(fixture.target, { readText })

    await openFromPointer(terminalTarget())
    act(() => menuButton('Paste').click())
    act(() => fixture.revoke())
    expect(document.querySelector('[role="menu"]')).toBeNull()

    await act(async () => {
      completeRead?.('late text')
      await Promise.resolve()
    })
    expect(fixture.paste).not.toHaveBeenCalled()
  })

  it('opens terminal search only through the exact current menu target', async () => {
    const fixture = targetFixture('')
    const onSearch = vi.fn()
    renderMenu(fixture.target, { onSearch })

    await openFromPointer(terminalTarget())
    await clickMenuButton('Search Terminal…')

    expect(onSearch).toHaveBeenCalledOnce()
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })
})

function renderMenu(
  target: TerminalContextMenuTarget,
  options: {
    readonly onSplit?: () => void
    readonly onSearch?: () => void
    readonly onOpenSettings?: () => void
    readonly onFork?: () => void
    readonly forkAvailability?: TerminalForkAvailability
    readonly readText?: () => Promise<string>
    readonly writeText?: (value: string) => Promise<void>
  } = {},
): void {
  act(() => {
    root.render(
      <MenuHarness
        target={target}
        onSearch={options.onSearch ?? vi.fn()}
        onSplit={options.onSplit ?? vi.fn()}
        onFork={options.onFork}
        forkAvailability={options.forkAvailability}
        onOpenSettings={options.onOpenSettings ?? vi.fn()}
        readText={options.readText}
        writeText={options.writeText}
      />,
    )
  })
}

function MenuHarness({
  target,
  onSearch,
  onSplit,
  onOpenSettings,
  onFork,
  forkAvailability,
  readText,
  writeText,
}: {
  readonly target: TerminalContextMenuTarget
  readonly onSearch: () => void
  readonly onSplit: () => void
  readonly onOpenSettings: () => void
  readonly onFork?: () => void
  readonly forkAvailability?: TerminalForkAvailability
  readonly readText?: () => Promise<string>
  readonly writeText?: (value: string) => Promise<void>
}): ReactElement {
  const controller = useTerminalContextMenu(() => target)
  return (
    <>
      <div
        className="terminal-test-target"
        tabIndex={0}
        onContextMenu={controller.openFromPointer}
        onKeyDownCapture={controller.openFromKeyboard}
      />
      <TerminalContextMenu
        controller={controller}
        onSearch={onSearch}
        onSplit={onSplit}
        onFork={onFork ?? (() => undefined)}
        forkAvailability={
          forkAvailability ?? {
            available: false,
            reason: 'This terminal does not support exact conversation forks.',
          }
        }
        onOpenSettings={onOpenSettings}
        readText={readText}
        writeText={writeText}
      />
    </>
  )
}

function selectionStatus() {
  let resolve!: (value: boolean) => void, reject!: (error: Error) => void
  const promise = new Promise<boolean>((accept, refuse) => {
    resolve = accept
    reject = refuse
  })
  return { promise, resolve, reject }
}

function targetFixture(selection: string) {
  let current = true
  const revoked = new Set<() => void>()
  const focus = vi.fn(() => {
    document.querySelector<HTMLElement>('.terminal-test-target')?.focus()
    return current
  })
  const getSelection = vi.fn(() => Promise.resolve(current ? selection : undefined))
  const paste = vi.fn(() => current)
  const selectAll = vi.fn(() => Promise.resolve(current))
  const clear = vi.fn(() => Promise.resolve(current))
  const reset = vi.fn(() => Promise.resolve(current))
  const target: TerminalContextMenuTarget = {
    isCurrent: () => current,
    hasSelection: () => Promise.resolve(current && selection.length > 0),
    getSelection,
    paste,
    selectAll,
    clear,
    reset,
    focus,
    onRevoked: (callback) => {
      revoked.add(callback)
      return () => {
        revoked.delete(callback)
      }
    },
  }
  return {
    target,
    focus,
    getSelection,
    paste,
    selectAll,
    clear,
    reset,
    revoke: () => {
      current = false
      for (const callback of revoked) callback()
    },
  }
}

function paneFixture() {
  const clear = vi.fn()
  const reset = vi.fn()
  const listen = () => () => undefined
  const pane: TerminalPane = {
    mount: vi.fn(),
    reparent: vi.fn(),
    dispose: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    setTheme: vi.fn(),
    setTypography: vi.fn(),
    setCursorDefaults: vi.fn(),
    setLigatures: vi.fn(),
    setPresentation: vi.fn(),
    redraw: vi.fn(),
    resolveEventProvenance: vi.fn(() => undefined),
    activeEventScreen: vi.fn(() => 'normal' as const),
    revealEventLocation: vi.fn(() => false),
    searchRetainedBuffer: vi.fn(() =>
      Promise.resolve({
        query: '',
        caseSensitive: false,
        matches: [],
        pending: false,
        invalidated: false,
        onUpdate: () => () => undefined,
        resolve: () => undefined,
        clearReveal: vi.fn(),
        reveal: () => false,
        extract: () => undefined,
        dispose: () => undefined,
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
    clear,
    reset,
    focus: vi.fn(),
    events: {
      onData: listen,
      onClipboardPaste: listen,
      onEvent: listen,
      onResize: listen,
      onLink: listen,
    },
  }
  return { pane, clear, reset }
}

function terminalTarget(): HTMLDivElement {
  const target = host.querySelector<HTMLDivElement>('.terminal-test-target')
  if (!target) throw new Error('Missing terminal target')
  return target
}

async function openFromPointer(target: HTMLElement): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    target.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 20,
        clientY: 20,
      }),
    )
  })
}

async function openFromKeyboard(
  target: HTMLElement,
  key: string,
  shiftKey = false,
): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }),
    )
  })
}

function dismissOutside(target: HTMLElement = document.body): void {
  act(() => {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  })
}

function menuButton(label: string): HTMLButtonElement {
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
  ].find((candidate) => candidate.textContent?.startsWith(label))
  if (!button) throw new Error(`Missing menu action '${label}'`)
  return button
}

async function clickMenuButton(label: string): Promise<void> {
  await act(async () => {
    menuButton(label).click()
    await Promise.resolve()
  })
}
