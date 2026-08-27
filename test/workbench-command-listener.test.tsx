// @vitest-environment happy-dom

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useWorkbenchCommands } from '../src/renderer/src/workbench/use-workbench-commands'
import type { WorkbenchCommandPorts } from '../src/renderer/src/workbench/workbench-command-router'
import { DEFAULT_KEYBINDINGS } from '../src/shared'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  Object.defineProperty(window, 'hvir', {
    configurable: true,
    value: { send: vi.fn(), on: vi.fn(() => vi.fn()) },
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('workbench command listener', () => {
  it('leaves viewer commands untouched in renderer-owned web pane chrome', () => {
    const ports = commandPorts()
    act(() => root.render(<CommandHarness ports={ports} />))
    const input = container.querySelector('input')!
    const primaryModifier = /Mac/.test(navigator.platform)
      ? { metaKey: true }
      : { ctrlKey: true }

    const find = keydown('f', primaryModifier)
    const goToLine = keydown('g', { ctrlKey: true })
    act(() => {
      input.dispatchEvent(find)
      input.dispatchEvent(goToLine)
    })

    expect(find.defaultPrevented).toBe(false)
    expect(goToLine.defaultPrevented).toBe(false)
    expect(ports.findInFile).not.toHaveBeenCalled()
    expect(ports.goToLine).not.toHaveBeenCalled()

    const findFile = keydown('p', primaryModifier)
    act(() => {
      input.dispatchEvent(findFile)
    })
    expect(findFile.defaultPrevented).toBe(true)
    expect(ports.findFile).toHaveBeenCalledOnce()
  })

  it('claims Mod+Shift+F only after the selected live terminal opens search', () => {
    const ports = commandPorts()
    act(() => root.render(<TerminalCommandHarness ports={ports} />))
    const terminal = container.querySelector('textarea')!
    const primaryModifier = /Mac/.test(navigator.platform)
      ? { metaKey: true }
      : { ctrlKey: true }
    const find = keydown('f', { ...primaryModifier, shiftKey: true })
    const terminalInput = vi.fn()
    terminal.addEventListener('keydown', terminalInput)

    act(() => {
      terminal.dispatchEvent(find)
    })

    expect(find.defaultPrevented).toBe(true)
    expect(ports.findInTerminal).toHaveBeenCalledOnce()
    expect(ports.findInFile).not.toHaveBeenCalled()
    expect(terminalInput).not.toHaveBeenCalled()
  })

  it('leaves ordinary Ctrl+F and rejected terminal search chords with the PTY', () => {
    const ports = commandPorts()
    vi.mocked(ports.findInTerminal).mockReturnValue(false)
    act(() => root.render(<TerminalCommandHarness ports={ports} />))
    const terminal = container.querySelector('textarea')!
    const terminalInput = vi.fn()
    terminal.addEventListener('keydown', terminalInput)

    const ordinaryForward = keydown('f', { ctrlKey: true })
    const primaryModifier = /Mac/.test(navigator.platform)
      ? { metaKey: true }
      : { ctrlKey: true }
    const rejectedSearch = keydown('f', { ...primaryModifier, shiftKey: true })
    act(() => {
      terminal.dispatchEvent(ordinaryForward)
      terminal.dispatchEvent(rejectedSearch)
    })

    expect(ordinaryForward.defaultPrevented).toBe(false)
    expect(rejectedSearch.defaultPrevented).toBe(false)
    expect(ports.findInTerminal).toHaveBeenCalledOnce()
    expect(terminalInput).toHaveBeenNthCalledWith(1, ordinaryForward)
    expect(terminalInput).toHaveBeenNthCalledWith(2, rejectedSearch)
  })

  it('does not claim workbench shortcuts while another application destination is active', () => {
    const ports = commandPorts()
    act(() => root.render(<CommandHarness ports={ports} enabled={false} />))
    const input = container.querySelector('input')!
    const primaryModifier = /Mac/.test(navigator.platform)
      ? { metaKey: true }
      : { ctrlKey: true }
    const findFile = keydown('p', primaryModifier)

    act(() => {
      input.dispatchEvent(findFile)
    })

    expect(findFile.defaultPrevented).toBe(false)
    expect(ports.findFile).not.toHaveBeenCalled()
  })
})

function CommandHarness({
  ports,
  enabled = true,
}: {
  readonly ports: WorkbenchCommandPorts
  readonly enabled?: boolean
}): ReactElement {
  useWorkbenchCommands(DEFAULT_KEYBINDINGS, { ...ports, enabled })
  return (
    <div className="web-pane">
      <input aria-label="Web pane path" />
    </div>
  )
}

function TerminalCommandHarness({
  ports,
}: {
  readonly ports: WorkbenchCommandPorts
}): ReactElement {
  useWorkbenchCommands(DEFAULT_KEYBINDINGS, ports)
  return (
    <div className="terminal-panel">
      <textarea aria-label="Terminal input" />
    </div>
  )
}

function keydown(
  key: string,
  modifiers: Pick<KeyboardEventInit, 'ctrlKey' | 'metaKey'> &
    Partial<Pick<KeyboardEventInit, 'shiftKey'>>,
): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    key,
    ...modifiers,
    bubbles: true,
    cancelable: true,
  })
}

function commandPorts(): WorkbenchCommandPorts {
  return {
    closeWebPane: vi.fn(),
    escapeWebPaneFocus: vi.fn(),
    canUseViewerCommands: vi.fn(() => true),
    cycleViewMode: vi.fn(),
    findFile: vi.fn(),
    findInFile: vi.fn(),
    findInTerminal: vi.fn(() => true),
    goToLine: vi.fn(),
    toggleTerminalFocus: vi.fn(),
    focusTerminal: vi.fn(),
    focusViewer: vi.fn(),
    focusTree: vi.fn(),
    switchWorkspace: vi.fn(),
  }
}
