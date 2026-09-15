// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import {
  firstEnabledMenuItem,
  focusRelativeMenuItem,
} from '../src/renderer/src/context-menu/menu-focus'

afterEach(() => document.body.replaceChildren())
it('shares enabled-item wrap, Home and End navigation without taking over dismissal', () => {
  const menu = document.createElement('div')
  menu.innerHTML =
    '<button role="menuitem">First</button><button role="menuitem" disabled>Unavailable</button><button role="menuitem">Last</button>'
  document.body.append(menu)
  firstEnabledMenuItem(menu)?.focus()
  expect(document.activeElement?.textContent).toBe('First')
  expect(focusRelativeMenuItem(menu, 'ArrowDown')).toBe(true)
  expect(document.activeElement?.textContent).toBe('Last')
  focusRelativeMenuItem(menu, 'ArrowDown')
  expect(document.activeElement?.textContent).toBe('First')
  focusRelativeMenuItem(menu, 'ArrowUp')
  expect(document.activeElement?.textContent).toBe('Last')
  focusRelativeMenuItem(menu, 'Home')
  expect(document.activeElement?.textContent).toBe('First')
  focusRelativeMenuItem(menu, 'End')
  expect(document.activeElement?.textContent).toBe('Last')
  expect(focusRelativeMenuItem(menu, 'Escape')).toBe(false)
  expect(document.activeElement?.textContent).toBe('Last')
  menu.querySelectorAll('button').forEach((button) => {
    button.disabled = true
  })
  expect(firstEnabledMenuItem(menu)).toBeUndefined()
  expect(focusRelativeMenuItem(menu, 'ArrowDown')).toBe(false)
})
