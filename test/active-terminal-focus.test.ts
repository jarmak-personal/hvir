// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { focusActiveTerminalAfterLayout } from '../src/renderer/src/workbench/active-terminal-focus'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  document.body.replaceChildren()
})

it('never refocuses the old terminal while an intended new session has not committed', () => {
  const deck = document.createElement('div')
  deck.className = 'terminal-deck'
  document.body.append(deck)
  const old = surface(deck, 'ordinary')
  const setupAction = document.createElement('button')
  document.body.append(setupAction)
  setupAction.focus()

  focusActiveTerminalAfterLayout('prepared')
  vi.runAllTimers()
  expect(document.activeElement).toBe(setupAction)

  old.parentElement!.classList.remove('visible', 'active')
  const prepared = surface(deck, 'prepared')
  focusActiveTerminalAfterLayout('prepared')
  vi.runAllTimers()
  expect(document.activeElement).toBe(prepared)

  setupAction.focus()
  prepared.parentElement!.classList.remove('visible')
  focusActiveTerminalAfterLayout('prepared')
  vi.runAllTimers()
  expect(document.activeElement).toBe(setupAction)
})

it('preserves ordinary active-terminal focus and treats intended ids as data', () => {
  const deck = document.createElement('div')
  deck.className = 'terminal-deck'
  document.body.append(deck)
  const input = surface(deck, 'session["quoted"]')
  focusActiveTerminalAfterLayout('session["quoted"]')
  vi.runAllTimers()
  expect(document.activeElement).toBe(input)

  input.blur()
  focusActiveTerminalAfterLayout()
  vi.runAllTimers()
  expect(document.activeElement).toBe(input)
})

function surface(deck: HTMLElement, id: string): HTMLElement {
  const panel = document.createElement('section')
  panel.className = 'terminal-surface visible active'
  panel.dataset.terminalSession = id
  const input = document.createElement('div')
  input.className = 'terminal-container'
  input.tabIndex = -1
  panel.append(input)
  deck.append(panel)
  return input
}
