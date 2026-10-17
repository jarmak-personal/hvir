// @vitest-environment happy-dom
import { runInNewContext } from 'node:vm'
import { buildSync } from 'esbuild'
import { afterEach, expect, it, vi } from 'vitest'

const sandbox = { CommandMenus: undefined as unknown }
runInNewContext(
  buildSync({
    entryPoints: ['packages/skillager-extension/src/command-menus.mjs'],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'CommandMenus',
  }).outputFiles[0]!.text,
  sandbox,
)
const { bindCommandMenus } = sandbox.CommandMenus as {
  bindCommandMenus: (document: Document, signal: AbortSignal) => void
}
let controller: AbortController
afterEach(() => {
  controller.abort()
  document.body.replaceChildren()
})
function fixture() {
  document.body.innerHTML = `<details class="skill-more" open><summary>More</summary><div class="skill-menu"><button>Refresh</button><button disabled>Unavailable</button></div></details><details id="source" open><summary>Source details</summary><button>Inspect</button></details>`
  controller = new AbortController()
  bindCommandMenus(document, controller.signal)
  return {
    menu: document.querySelector<HTMLDetailsElement>('.skill-more')!,
    button: document.querySelector<HTMLButtonElement>('.skill-menu button')!,
  }
}

it('dismisses enabled commands even when their action immediately disables them', () => {
  const { menu, button } = fixture()
  const action = vi.fn(() => {
    button.disabled = true
  })
  button.addEventListener('click', action)
  button.click()
  expect(action).toHaveBeenCalledOnce()
  expect(menu.open).toBe(false)
  expect(document.activeElement).toBe(menu.querySelector('summary'))
})

it('keeps disabled commands and persistent details open', () => {
  const { menu } = fixture()
  menu
    .querySelector('button[disabled]')!
    .dispatchEvent(new MouseEvent('click', { bubbles: true }))
  document.querySelector<HTMLButtonElement>('#source button')!.click()
  expect(menu.open).toBe(true)
  expect(document.querySelector<HTMLDetailsElement>('#source')!.open).toBe(true)
})

it('Escape dismisses the command disclosure and returns focus to its summary', () => {
  const { menu, button } = fixture()
  button.focus()
  button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  expect(menu.open).toBe(false)
  expect(document.activeElement).toBe(menu.querySelector('summary'))
})

it('releases command listeners with the guest lifetime', () => {
  const { menu, button } = fixture()
  controller.abort()
  button.click()
  button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  expect(menu.open).toBe(true)
})
