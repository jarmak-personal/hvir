// @vitest-environment happy-dom
import { buildSync } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'

const bundle = buildSync({
  entryPoints: ['packages/skillager-extension/src/browser-task-sheet.mjs'],
  bundle: true,
  format: 'cjs',
  write: false,
}).outputFiles[0]!.text
const input = {
  row: {
    id: 'occurrence',
    kind: 'Project original',
    name: 'Original',
    source: 'project',
    host: 'local',
    workspaceId: 'project',
    path: '/project/original/SKILL.md',
  },
}
let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  document.body.replaceChildren()
})
function setup() {
  document.body.innerHTML = `
    <button id="invoker">…</button>
    <div id="reader"><div id="instructions">Keep this document</div><div data-skill-tasks>
      <button id="import-save" disabled>Save</button>
      <button id="import-reconcile" hidden>Inspect uncertain operation</button>
    </div></div>
    <section id="skill-task-sheet" hidden>
      <strong id="skill-task-title"></strong><button id="skill-task-close">Close</button>
      <p id="skill-task-message"></p><button id="skill-task-retry" hidden>Review again</button>
      <div data-skill-task-sheet-target></div>
    </section>`
  const module = {
    exports: {} as {
      bindBrowserTaskSheet(
        document: Document,
        client: unknown,
        ports: unknown,
      ): {
        open(selection: typeof input, task: string, trigger: HTMLElement): Promise<void>
        close(): boolean
        contextChanged(): void
        dispose(): void
        busy: boolean
      }
    },
  }
  runInNewContext(bundle, { module, document })
  let finish!: () => void, activity: (() => void) | undefined
  const surface = {
    submitted: false,
    onActivity: (value: () => void) => {
      activity = value
    },
    onChanged: vi.fn(),
    select: vi.fn(),
    prepare: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    ),
  }
  const reader = { tasks: surface, restoreTasks: vi.fn() }
  const context = { visible: true, workspace: { id: 'project', host: 'local' } }
  const client = { alive: true, signal: new AbortController().signal, request: vi.fn() }
  const returnFocus = vi.fn()
  const sheet = module.exports['bindBrowserTaskSheet'](document, client, {
    reader,
    context: () => context,
    changed: vi.fn(),
    choose: vi.fn(),
    returnFocus,
  })
  dispose = () => sheet.dispose()
  const button = (id: string) => document.getElementById(id) as HTMLButtonElement
  return {
    sheet,
    reader,
    surface,
    context,
    button,
    finish: () => finish(),
    activity: () => activity?.(),
    client,
    returnFocus,
  }
}
it('keeps the reader document and awaits actual preparation before focusing the decision', async () => {
  const f = setup()
  const body = document.getElementById('instructions')!
  body.scrollTop = 200
  const pending = f.sheet.open(input, 'save', f.button('invoker'))
  expect(document.getElementById('skill-task-message')!.textContent).toBe('Preparing…')
  expect(f.button('skill-task-retry').hidden).toBe(true)
  expect(body.parentElement!.id).toBe('reader')
  f.button('import-save').disabled = false
  f.finish()
  await pending
  expect(document.activeElement).toBe(f.button('import-save'))
  expect(document.getElementById('instructions')).toBe(body)
  expect(body.scrollTop).toBe(200)
  f.sheet.close()
  expect(f.reader.restoreTasks).toHaveBeenCalledOnce()
  expect(document.querySelector('[data-skill-tasks]')!.parentElement!.id).toBe('reader')
  expect(document.activeElement).toBe(f.button('invoker'))
})
it('blocks Close, Escape, and another task while submitted; context loss retires the sheet', async () => {
  const f = setup()
  const pending = f.sheet.open(input, 'save', f.button('invoker'))
  f.finish()
  await pending
  f.surface.submitted = true
  f.activity()
  await Promise.resolve()
  expect(f.sheet.busy).toBe(true)
  expect(f.button('skill-task-close').disabled).toBe(true)
  expect(f.sheet.close()).toBe(false)
  document
    .getElementById('skill-task-sheet')!
    .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await f.sheet.open({ row: { ...input.row, id: 'second' } }, 'stub', f.button('invoker'))
  expect(f.surface.prepare).toHaveBeenCalledTimes(1)
  expect(f.reader.restoreTasks).not.toHaveBeenCalled()
  f.context.visible = false
  f.sheet.contextChanged()
  expect(document.getElementById('skill-task-sheet')!.hidden).toBe(true)
  expect(f.surface.select).toHaveBeenLastCalledWith(undefined)
  f.surface.submitted = false
  f.activity()
  await Promise.resolve()
  expect(document.getElementById('skill-task-sheet')!.hidden).toBe(true)
  expect(f.reader.restoreTasks).not.toHaveBeenCalled()
})
it('offers fresh preparation after failure but leaves uncertainty with its existing inspect control', async () => {
  const f = setup()
  const pending = f.sheet.open(input, 'save', f.button('invoker'))
  f.finish()
  await pending
  expect(f.button('skill-task-retry').hidden).toBe(false)
  f.button('skill-task-retry').click()
  expect(f.surface.prepare).toHaveBeenCalledTimes(2)
  expect(f.client.request).not.toHaveBeenCalled()
  f.button('import-reconcile').hidden = false
  f.finish()
  await Promise.resolve()
  await Promise.resolve()
  expect(f.button('skill-task-retry').hidden).toBe(true)
  expect(f.button('import-reconcile').hidden).toBe(false)
})

it('uses the browser focus fallback after the invoking row was removed', async () => {
  const f = setup()
  const pending = f.sheet.open(input, 'save', f.button('invoker'))
  f.finish()
  await pending
  f.button('invoker').remove()
  f.sheet.close()
  expect(f.returnFocus).toHaveBeenCalledOnce()
})
it('Show in Files retires the prior preparation without leaving a success sheet', async () => {
  const f = setup()
  const pending = f.sheet.open(input, 'save', f.button('invoker'))
  await f.sheet.open(
    { row: { ...input.row, path: '/project/original/SKILL.md' } },
    'reveal',
    f.button('invoker'),
  )
  f.finish()
  await pending
  expect(document.getElementById('skill-task-sheet')!.hidden).toBe(true)
  expect(f.client.request).toHaveBeenCalledWith('source.reveal', {
    source: 'project',
    workspaceId: 'project',
    path: { hostId: 'local', path: '/project/original' },
  })
})
