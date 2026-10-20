// @vitest-environment happy-dom
import { buildSync } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'

interface Row {
  id: string
  name: string
  description: string
  kind: string
  source: string
  host: string
  path: string
  agent?: string
  exposure?: { mode: string }
  canonical?: { skill_id: string }
}
const original: Row = {
  id: 'first-occurrence',
  name: 'Same name',
  description: 'First source',
  kind: 'Project original',
  source: 'project',
  host: 'local',
  path: '/first/.agents/skills/one/SKILL.md',
  agent: 'codex',
}
const second = { ...original, id: 'second-occurrence', path: '/second/SKILL.md' }
const bundle = buildSync({
  entryPoints: ['packages/skillager-extension/src/skill-list-view.mjs'],
  bundle: true,
  format: 'cjs',
  write: false,
}).outputFiles[0]!.text
let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  document.body.replaceChildren()
})
function setup(rows: Row[] = [original, second]) {
  const module = {
    exports: {} as {
      bindSkillList(
        document: Document,
        list: HTMLElement,
        ports: unknown,
      ): {
        render(rows: Row[]): void
        dispose(): void
      }
      skillRowActions(
        row: Row,
        workspace?: { host: string },
      ): Array<{ id: string; label: string; checked?: boolean }>
    },
  }
  runInNewContext(bundle, { module, document })
  const list = document.createElement('div')
  list.setAttribute('role', 'list')
  document.body.append(list)
  const ports = {
    available: vi.fn(() => true),
    selected: vi.fn(),
    choose: vi.fn(),
    task: vi.fn(),
    emptyFocus: vi.fn(),
  }
  const owner = module.exports['bindSkillList'](document, list, ports)
  owner.render(rows)
  dispose = () => owner.dispose()
  const row = (index = 0) => list.children[index] as HTMLElement
  const select = (index = 0) =>
    row(index).querySelector<HTMLButtonElement>('[data-skill-select]')!
  const more = (index = 0) =>
    row(index).querySelector<HTMLButtonElement>('[data-skill-actions]')!
  const menu = () => document.getElementById('skill-row-menu')!
  const labels = () => [...menu().querySelectorAll('button')].map((b) => b.textContent)
  return {
    owner,
    list,
    row,
    select,
    more,
    menu,
    labels,
    ports,
    actions: (row: Row, workspace?: { host: string }) =>
      module.exports.skillRowActions(row, workspace),
  }
}
const key = (target: Element, value: string, shiftKey = false) =>
  target.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: value,
      shiftKey,
      bubbles: true,
      cancelable: true,
    }),
  )

it('opens equivalent menus without selecting/reading and dispatches the exact occurrence', () => {
  const f = setup()
  f.select().click()
  f.ports.choose.mockClear()
  f.ports.selected.mockClear()
  f.list.scrollTop = 57
  f.row(1).dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 700,
      clientY: 500,
    }),
  )
  const labels = f.labels()
  expect(labels).toEqual([
    'Save to library…',
    'Use full copy…',
    'Use stub…',
    'Remove from project…',
    'Show in Files',
  ])
  expect(f.ports.selected).not.toHaveBeenCalled()
  expect(f.ports.choose).not.toHaveBeenCalled()
  expect(f.ports.task).not.toHaveBeenCalled()
  expect(f.select().getAttribute('aria-current')).toBe('true')
  expect(f.list.scrollTop).toBe(57)
  key(document.activeElement!, 'Escape')
  f.more(1).click()
  expect(f.labels()).toEqual(labels)
  f.menu().querySelector<HTMLButtonElement>('[data-task=remove]')!.click()
  expect(f.ports.task).toHaveBeenCalledWith(second, 'remove', f.more(1))
  expect(f.ports.choose).not.toHaveBeenCalled()
  expect(f.menu().hidden).toBe(true)
})

it('uses sibling controls and returns keyboard focus to the actual invoker', () => {
  const f = setup()
  expect(f.row().getAttribute('role')).toBe('listitem')
  expect(f.more().parentElement).toBe(f.select().parentElement)
  expect(f.list.querySelector('[role=option], button button')).toBeNull()
  f.select().focus()
  key(f.select(), 'F10', true)
  expect(f.more().getAttribute('aria-expanded')).toBe('true')
  key(document.activeElement!, 'End')
  expect(document.activeElement?.textContent).toBe('Show in Files')
  key(document.activeElement!, 'ArrowDown')
  expect(document.activeElement?.textContent).toBe('Save to library…')
  key(document.activeElement!, 'Escape')
  expect(document.activeElement).toBe(f.select())
  key(f.select(), 'ArrowRight')
  expect(document.activeElement).toBe(f.more())
  key(f.more(), 'ContextMenu')
  key(document.activeElement!, 'Escape')
  expect(document.activeElement).toBe(f.more())
  key(f.more(), 'ArrowDown')
  expect(document.activeElement).toBe(f.more(1))
  expect(f.ports.choose).not.toHaveBeenCalled()
})

it('retains accurate expansion on identical refresh and retires stale occurrence menus', () => {
  const f = setup()
  f.more().click()
  f.owner.render([original, second])
  expect(f.menu().hidden).toBe(false)
  expect(f.more().getAttribute('aria-expanded')).toBe('true')
  key(document.activeElement!, 'Escape')
  expect(document.activeElement).toBe(f.more())
  f.more().click()
  f.owner.render([{ ...original, path: '/replacement/SKILL.md' }, second])
  expect(f.menu().hidden).toBe(true)
  f.more().click()
  f.ports.available.mockReturnValue(false)
  f.menu().querySelector<HTMLButtonElement>('button')!.click()
  expect(f.ports.task).not.toHaveBeenCalled()
  f.ports.available.mockReturnValue(true)
  f.more().click()
  f.owner.dispose()
  expect(document.getElementById('skill-row-menu')).toBeNull()
  f.more().click()
  expect(f.ports.task).not.toHaveBeenCalled()
})

it('checks the current managed mode and keeps unsupported native actions out of remote menus', () => {
  const managed = {
    ...original,
    kind: 'Installed Full',
    canonical: { skill_id: 'lib/example' },
    exposure: { mode: 'native' },
  }
  const f = setup([managed])
  f.more().click()
  const full = f.menu().querySelector<HTMLButtonElement>('[data-task=native]')!
  expect(full.getAttribute('role')).toBe('menuitemradio')
  expect(full.getAttribute('aria-checked')).toBe('true')
  expect(full.disabled).toBe(true)
  expect(
    f
      .actions({ ...original, source: 'library' }, { host: 'ssh-host' })
      .map((item) => item.id),
  ).toEqual(['native'])
  expect(f.actions({ ...original, host: 'remote' })).toEqual([
    { id: 'reveal', label: 'Show in Files' },
  ])
  expect(
    f.actions({ ...original, agent: 'other' }).map((a: { id: string }) => a.id),
  ).toEqual(['save', 'remove', 'reveal'])
})

it('clamps a menu to the guest viewport and dismisses on outside input and scrolling', () => {
  const f = setup()
  f.menu().getBoundingClientRect = () => ({ width: 196, height: 170 }) as DOMRect
  f.row().dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 9999,
      clientY: 9999,
    }),
  )
  expect(Number.parseFloat(f.menu().style.left)).toBeLessThanOrEqual(
    window.innerWidth - 196,
  )
  expect(Number.parseFloat(f.menu().style.top)).toBeLessThanOrEqual(
    window.innerHeight - 170,
  )
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  expect(f.menu().hidden).toBe(true)
  f.more().click()
  f.list.dispatchEvent(new Event('scroll'))
  expect(f.menu().hidden).toBe(true)
})

it('returns focus to a remaining occurrence or search when an invoked occurrence disappears', () => {
  const f = setup()
  f.more(1).click()
  f.owner.render([original])
  expect(document.activeElement).toBe(f.select())
  f.more().click()
  f.owner.render([])
  expect(f.ports.emptyFocus).toHaveBeenCalledOnce()
  expect(f.menu().hidden).toBe(true)
})
