// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TerminalLayoutControls } from '../src/renderer/src/workbench/TerminalLayoutControls'
import type { TerminalLayoutMode } from '../src/renderer/src/workbench/workspace-pane-state'

let host: HTMLDivElement
let root: Root
let animationFrames: FrameRequestCallback[]

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  animationFrames = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    animationFrames.push(callback)
    return animationFrames.length
  })
})

afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('TerminalLayoutControls', () => {
  it.each([
    ['Maximize terminal', 'restored', 'maximized'],
    ['Restore split view', 'maximized', 'restored'],
    ['Maximize viewer and minimize terminal', 'restored', 'collapsed'],
    ['Restore split view', 'collapsed', 'restored'],
  ] as const)(
    'applies %s and then focuses the active terminal',
    (label, mode, expectedMode) => {
      const onMode = vi.fn()
      renderControls(mode, onMode)
      const activeInput = addSplitTerminals()
      const button = buttonWithLabel(label)

      act(() => button.click())

      expect(onMode).toHaveBeenCalledWith(expectedMode)
      expect(document.activeElement).toBe(button)
      flushAnimationFrame()
      expect(document.activeElement).toBe(activeInput)

      const enter = vi.fn()
      activeInput.addEventListener('keydown', enter)
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter' }),
      )
      expect(enter).toHaveBeenCalledOnce()
    },
  )
})

function renderControls(
  mode: TerminalLayoutMode,
  onMode: (mode: TerminalLayoutMode) => void,
): void {
  act(() => {
    root.render(<TerminalLayoutControls mode={mode} onMode={onMode} />)
  })
}

function addSplitTerminals(): HTMLElement {
  const deck = document.createElement('div')
  deck.className = 'terminal-deck split'
  const primary = terminalSurface('primary', false)
  const secondary = terminalSurface('secondary', true)
  deck.append(primary, secondary)
  document.body.append(deck)
  return secondary.querySelector<HTMLElement>('.terminal-container')!
}

function terminalSurface(slot: string, active: boolean): HTMLElement {
  const surface = document.createElement('section')
  surface.className = `terminal-surface visible${active ? ' active' : ''}`
  surface.dataset['terminalSlot'] = slot
  const input = document.createElement('div')
  input.className = 'terminal-container'
  input.tabIndex = -1
  surface.append(input)
  return surface
}

function buttonWithLabel(label: string): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  if (!button) throw new Error(`terminal layout button missing: ${label}`)
  button.focus()
  return button
}

function flushAnimationFrame(): void {
  const callback = animationFrames.shift()
  if (!callback) throw new Error('terminal focus frame was not scheduled')
  act(() => callback(performance.now()))
}
