// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { buildSync } from 'esbuild'
import { afterEach, expect, it, vi } from 'vitest'
import { connectorOutputFixture } from './fixtures/connector-output'
type Value = Record<string, unknown>
let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  document.body.replaceChildren()
})
function fixture(sourceGroup?: unknown) {
  const template = document.createElement('template')
  template.innerHTML = readFileSync('packages/skillager-extension/detail.html', 'utf8')
  for (const node of template.content.querySelectorAll('script, link')) node.remove()
  document.body.replaceChildren(template.content.cloneNode(true))
  const sandbox = { AbortController, TextEncoder, Module: undefined as unknown }
  runInNewContext(
    buildSync({
      stdin: {
        contents: `
    export { mountSkillTasks } from './packages/skillager-extension/src/skill-task-template.mjs'
    export { bindExposureMembers } from './packages/skillager-extension/src/exposure-members.mjs'
    export { managementCli } from './packages/skillager-extension/src/management-cli.mjs'`,
        resolveDir: process.cwd(),
      },
      bundle: true,
      format: 'iife',
      globalName: 'Module',
      write: false,
    }).outputFiles[0]!.text,
    sandbox,
  )
  interface Picker {
    start(rows: Value[]): void
    stop(): void
    ids(): string[]
  }
  const module = sandbox.Module as {
    mountSkillTasks(document: Document): void
    bindExposureMembers(document: Document, client: unknown, ports: unknown): Picker
    managementCli(client: unknown): unknown
  }
  module.mountSkillTasks(document)
  const abort = new AbortController(),
    native = connectorOutputFixture(),
    calls: string[][] = [],
    messages: string[] = []
  const library = {
    id: '01234567-89ab-cdef-0123-456789abcdef',
    root: { hostId: 'local', path: '/library' },
  }
  let released = 0,
    serial = 0,
    available = true,
    failCursor: string | undefined,
    failFirst = false,
    held = false,
    release: (() => void) | undefined
  const row = (id: string) => ({
    id,
    name: id.slice(4),
    description: '',
    status: 'accepted',
    skill_file: `/library/skills/${id.slice(4)}/SKILL.md`,
    source_group: sourceGroup,
  })
  const client = {
    alive: true,
    signal: abort.signal,
    async request(capability: string, input: Value) {
      if (capability === 'connector.output') {
        if (input['release']) released++
        return native.read(input)
      }
      expect(capability).toBe('connector.execute')
      const args = input['args'] as string[]
      calls.push(args)
      const cursor = args.includes('--cursor') ? args[args.indexOf('--cursor') + 1] : '',
        searching = args[0] === 'search'
      let value: Value,
        code = 0
      if ((cursor && failCursor) || (!cursor && failFirst)) {
        code = 15
        value = {
          schema: 'skillager.error.v1',
          error: { code: failCursor ?? 'stale_cursor' },
        }
        failCursor = undefined
      } else if (searching)
        value = {
          schema: 'skillager.search.v1',
          status: 'completed',
          next_cursor: cursor ? null : 'next',
          results: [
            {
              id: 'ranked',
              name: 'Found',
              trust: 'reviewed',
              source_group: sourceGroup,
              search: {
                canonical: {
                  library_id: library.id,
                  skill_id: cursor ? 'lib/later' : 'lib/found',
                },
                occurrence: {
                  id: 'f'.repeat(64),
                  kind: 'library',
                  entrypoint: `/library/skills/${cursor ? 'later' : 'found'}/SKILL.md`,
                },
              },
            },
          ],
        }
      else
        value = {
          schema: 'skillager.list.v1',
          scope: 'library',
          skills: [row(cursor ? 'lib/later' : 'lib/first')],
          next_cursor: cursor === 'last' ? null : cursor ? 'last' : 'next',
        }
      if (held) {
        held = false
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      return native.complete(
        { outcome: 'completed', code, receipt: String(++serial), truncated: false },
        JSON.stringify(value),
      )
    },
  }
  const picker = module.bindExposureMembers(document, client, {
    library: () => library,
    available: () => available,
    io: () => module.managementCli(client),
    changed() {},
    say: (message: string) => messages.push(message),
  })
  dispose = () => {
    picker.stop()
    abort.abort()
  }
  const el = (id: string) =>
    document.getElementById(`exposure-member-${id}`) as HTMLButtonElement
  const ready = () => vi.waitFor(() => expect(el('search-button').disabled).toBe(false))
  return {
    picker,
    calls,
    messages,
    el,
    ready,
    start: () => picker.start([{ id: 'lib/retained', name: 'Retained' }]),
    search: () => {
      ;(document.getElementById('exposure-member-query') as HTMLInputElement).value =
        'same query'
      el('search').dispatchEvent(new Event('submit', { cancelable: true }))
    },
    fail: (code = 'stale_cursor', first = false) => {
      failCursor = code
      failFirst = first
    },
    hold: () => {
      held = true
    },
    released: () => released,
    waiting: () => !!release,
    release: () => release?.(),
    retire: () => {
      available = false
      picker.stop()
    },
  }
}
it.each([false, true])(
  'restarts one expired member page with the same query (search=%s) and retains canonical selections',
  async (searching) => {
    const f = fixture()
    f.start()
    await f.ready()
    if (searching) {
      f.search()
      await f.ready()
    }
    f.fail()
    f.el('next').click()
    await f.ready()
    expect(f.calls.at(-2)).toContain('--cursor')
    const last = f.calls.at(-1)!
    expect(last.includes('--cursor') ? last[last.indexOf('--cursor') + 1] : '').toBe('')
    if (searching) expect(f.calls.at(-1)).toContain('same query')
    expect(f.picker.ids()).toEqual(['lib/retained'])
    expect(f.el('page').textContent).toBe('Page 1')
    expect(f.el('previous').disabled).toBe(true)
    expect(f.messages).toEqual(['Skills changed; showing first page.'])
  },
)
it.each(['invalid_cursor', 'first-page'] as const)(
  'does not loop or substitute a retry for %s failures',
  async (failure) => {
    const f = fixture()
    f.start()
    await f.ready()
    const before = f.calls.length
    f.fail(failure === 'first-page' ? 'stale_cursor' : failure, failure === 'first-page')
    f.el('next').click()
    await f.ready()
    expect(f.calls).toHaveLength(before + (failure === 'first-page' ? 2 : 1))
    expect(f.messages.at(-1)).toContain('Skillager exit 15')
    expect(f.picker.ids()).toEqual(['lib/retained'])
  },
)
it('retires a held stale-cursor response without starting another read or repopulating members', async () => {
  const f = fixture()
  f.start()
  await f.ready()
  f.fail()
  f.hold()
  f.el('next').click()
  await vi.waitFor(() => expect(f.waiting()).toBe(true))
  const count = f.calls.length,
    released = f.released()
  f.retire()
  f.release()
  await vi.waitFor(() => expect(f.released()).toBe(released + 1))
  expect(f.calls).toHaveLength(count)
  expect(f.picker.ids()).toEqual([])
  expect(document.getElementById('exposure-member-results')!.childElementCount).toBe(0)
})

it('recovers an expired Previous page without losing an off-page selected member', async () => {
  const f = fixture()
  f.start()
  await f.ready()
  f.el('next').click()
  await f.ready()
  document.querySelector<HTMLInputElement>('#exposure-member-results input')!.click()
  f.el('next').click()
  await f.ready()
  expect(f.el('page').textContent).toBe('Page 3')
  f.fail()
  f.el('previous').click()
  await f.ready()
  expect(f.el('page').textContent).toBe('Page 1')
  expect(f.picker.ids()).toEqual(['lib/retained', 'lib/later'])
  expect(f.messages).toEqual(['Skills changed; showing first page.'])
})

it.each([false, true])(
  'keeps Router member paging usable with unknown optional source metadata (search=%s)',
  async (searching) => {
    const f = fixture({
      id: `source:${'a'.repeat(64)}`,
      label: 'Source',
      kind: 'future-kind',
      detail: null,
    })
    f.start()
    await f.ready()
    if (searching) {
      f.search()
      await f.ready()
    }
    const member = document.querySelector<HTMLInputElement>(
      '#exposure-member-results input',
    )!
    expect(member).not.toBeNull()
    member.click()
    expect(f.picker.ids()).toEqual([
      'lib/retained',
      searching ? 'lib/found' : 'lib/first',
    ])
    f.el('next').click()
    await f.ready()
    expect(f.el('page').textContent).toBe('Page 2')
    expect(document.getElementById('exposure-member-results')?.textContent).toContain(
      searching ? 'Found' : 'later',
    )
    expect(f.messages).toEqual([])
  },
)
