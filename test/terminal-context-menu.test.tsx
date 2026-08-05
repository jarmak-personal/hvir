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
import { useTerminalContextMenu } from '../src/renderer/src/terminal/use-terminal-context-menu'

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
  it('binds only one visible attached pane and rejects a same-id successor', () => {
    let available = true
    const owner = new TerminalContextMenuOwner(() => available)
    const original = paneFixture()
    const successor = paneFixture()
    owner.bind(original.pane, 'pty-instance-1', vi.fn())
    const originalTarget = owner.target()

    expect(originalTarget?.reset()).toBe(true)
    available = false
    expect(owner.target()).toBeUndefined()
    expect(originalTarget?.clear()).toBe(false)

    available = true
    owner.bind(successor.pane, 'pty-instance-2', vi.fn())
    expect(originalTarget?.reset()).toBe(false)
    expect(owner.target()?.reset()).toBe(true)
    expect(original.reset).toHaveBeenCalledOnce()
    expect(successor.reset).toHaveBeenCalledOnce()

    owner.revoke()
    expect(owner.target()).toBeUndefined()
  })

  it('opens from pointer and both keyboard gestures, disabling Copy without selection', () => {
    const fixture = targetFixture('')
    renderMenu(fixture.target)
    const terminal = terminalTarget()

    openFromPointer(terminal)
    expect(menuButton('Copy Selection').disabled).toBe(true)
    expect(fixture.focus).not.toHaveBeenCalled()

    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()
    dismissOutside(outside)
    expect(outside).toBe(document.activeElement)
    expect(fixture.focus).not.toHaveBeenCalled()
    terminal.focus()
    openFromKeyboard(terminal, 'ContextMenu')
    expect(menuButton('Paste')).toBe(document.activeElement)

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(fixture.focus).toHaveBeenCalledOnce()
    expect(terminal).toBe(document.activeElement)

    openFromKeyboard(terminal, 'F10', true)
    expect(menuButton('Paste')).toBe(document.activeElement)
  })

  it('captures pointer-menu Escape before the focused terminal can emit it', () => {
    const fixture = targetFixture('')
    renderMenu(fixture.target)
    const terminal = terminalTarget()
    const terminalKeydown = vi.fn()
    terminal.addEventListener('keydown', terminalKeydown)
    terminal.focus()
    openFromPointer(terminal)

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

  it('copies exact plain text and preserves selection when clipboard writing fails', async () => {
    const fixture = targetFixture('first\nsecond')
    const writeText = vi.fn<(value: string) => Promise<void>>()
    writeText.mockRejectedValue(new Error('denied'))
    renderMenu(fixture.target, { writeText })

    openFromPointer(terminalTarget())
    await clickMenuButton('Copy Selection')

    expect(writeText).toHaveBeenCalledExactlyOnceWith('first\nsecond')
    expect(fixture.getSelection).toHaveBeenCalledOnce()
    expect(fixture.clear).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'Could not copy the selection to the clipboard.',
    )
  })

  it('reads text only after Paste activation and preserves exact bracketed-paste input', async () => {
    const fixture = targetFixture('')
    const readText = vi
      .fn<() => Promise<string>>()
      .mockResolvedValue('line one\nline two')
    renderMenu(fixture.target, { readText })

    openFromPointer(terminalTarget())
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

    openFromPointer(terminalTarget())
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

    openFromPointer(terminalTarget())
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
      openFromPointer(terminalTarget())
      await clickMenuButton(label)
      expect(action).toHaveBeenCalledOnce()
    }

    openFromPointer(terminalTarget())
    await clickMenuButton('Split Terminal')
    openFromPointer(terminalTarget())
    await clickMenuButton('Terminal Settings…')

    expect(onSplit).toHaveBeenCalledOnce()
    expect(onOpenSettings).toHaveBeenCalledOnce()
  })

  it('keeps menu clicks from reaching terminal-owned document selection handlers', async () => {
    const fixture = targetFixture('')
    const documentClick = vi.fn()
    document.addEventListener('click', documentClick)
    renderMenu(fixture.target)

    openFromPointer(terminalTarget())
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

    openFromPointer(terminalTarget())
    act(() => menuButton('Paste').click())
    act(() => fixture.revoke())
    expect(document.querySelector('[role="menu"]')).toBeNull()

    await act(async () => {
      completeRead?.('late text')
      await Promise.resolve()
    })
    expect(fixture.paste).not.toHaveBeenCalled()
  })
})

function renderMenu(
  target: TerminalContextMenuTarget,
  options: {
    readonly onSplit?: () => void
    readonly onOpenSettings?: () => void
    readonly readText?: () => Promise<string>
    readonly writeText?: (value: string) => Promise<void>
  } = {},
): void {
  act(() => {
    root.render(
      <MenuHarness
        target={target}
        onSplit={options.onSplit ?? vi.fn()}
        onOpenSettings={options.onOpenSettings ?? vi.fn()}
        readText={options.readText}
        writeText={options.writeText}
      />,
    )
  })
}

function MenuHarness({
  target,
  onSplit,
  onOpenSettings,
  readText,
  writeText,
}: {
  readonly target: TerminalContextMenuTarget
  readonly onSplit: () => void
  readonly onOpenSettings: () => void
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
        onSplit={onSplit}
        onOpenSettings={onOpenSettings}
        readText={readText}
        writeText={writeText}
      />
    </>
  )
}

function targetFixture(selection: string) {
  let current = true
  const revoked = new Set<() => void>()
  const focus = vi.fn(() => {
    document.querySelector<HTMLElement>('.terminal-test-target')?.focus()
    return current
  })
  const getSelection = vi.fn(() => (current ? selection : undefined))
  const paste = vi.fn(() => current)
  const selectAll = vi.fn(() => current)
  const clear = vi.fn(() => current)
  const reset = vi.fn(() => current)
  const target: TerminalContextMenuTarget = {
    isCurrent: () => current,
    hasSelection: () => current && selection.length > 0,
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
    setPresentation: vi.fn(),
    redraw: vi.fn(),
    resolveEventProvenance: vi.fn(() => undefined),
    activeEventScreen: vi.fn(() => 'normal' as const),
    revealEventLocation: vi.fn(() => false),
    hasSelection: vi.fn(() => false),
    getSelection: vi.fn(() => ''),
    paste: vi.fn(),
    selectAll: vi.fn(),
    clear: vi.fn(),
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
  return { pane, reset }
}

function terminalTarget(): HTMLDivElement {
  const target = host.querySelector<HTMLDivElement>('.terminal-test-target')
  if (!target) throw new Error('Missing terminal target')
  return target
}

function openFromPointer(target: HTMLElement): void {
  act(() => {
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

function openFromKeyboard(target: HTMLElement, key: string, shiftKey = false): void {
  act(() => {
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
  ].find((candidate) => candidate.textContent === label)
  if (!button) throw new Error(`Missing menu action '${label}'`)
  return button
}

async function clickMenuButton(label: string): Promise<void> {
  await act(async () => {
    menuButton(label).click()
    await Promise.resolve()
  })
}
