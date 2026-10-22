// @vitest-environment happy-dom
import { buildSync } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { connectorOutputFixture } from './fixtures/connector-output'

type Value = Record<string, unknown>
const group = (letter = 'a', label = 'hvir') => ({
  id: `source:${letter.repeat(64)}`,
  label,
  kind: 'project',
  detail: `/projects/${label}`,
  count: 101,
})
const envelope = (groups = [group()]) => ({
  schema: 'skillager.library-groups.v1',
  scope: 'library',
  groups,
  total_skills: groups.reduce((n, row) => n + row.count, 0),
  total_groups: groups.length,
  next_cursor: null,
  discovery_error_count: 0,
})
const bundle = buildSync({
  stdin: {
    contents: `export * from './packages/skillager-extension/src/library-source-catalog.mjs';
    export * from './packages/skillager-extension/src/catalog.mjs';
    export * from './packages/skillager-extension/src/library-source-view.mjs';
    export * from './packages/skillager-extension/src/skill-list-view.mjs';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  format: 'iife',
  globalName: 'Module',
  write: false,
}).outputFiles[0]!.text
interface Owner {
  render(page: Value, library: Value): void
  pause(): void
  dispose(): void
}
const sandbox = { TextEncoder, AbortController, Module: undefined as unknown }
runInNewContext(bundle, sandbox)
const module = sandbox.Module as {
  libraryGroups(value: unknown): Value
  libraryPage(value: unknown): Value
  searchPage(value: unknown): Value
  sourceGroup(value: unknown): Value
  sourcePage(value: unknown, page: unknown, id: string): Value
  libraryGroupingFailure(error: unknown): Error
  bindSkillList(
    document: Document,
    list: HTMLElement,
    ports: unknown,
  ): { dispose(): void }
  bindLibrarySources(
    document: Document,
    list: HTMLElement,
    navigation: unknown,
    client: unknown,
    ports: unknown,
  ): Owner
}
let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  document.body.replaceChildren()
})
const flush = () => nextTurn()
function fixture() {
  const list = document.createElement('div')
  list.id = 'skills'
  list.setAttribute('role', 'list')
  document.body.append(list)
  const native = connectorOutputFixture(),
    calls: string[][] = [],
    choose = vi.fn(),
    task = vi.fn()
  let visible = true,
    selected: Value | undefined,
    holding = false,
    release: (() => void) | undefined,
    stale = false,
    failFirst = false,
    serial = 0
  const client = {
    alive: true,
    async request(capability: string, input: Value) {
      if (capability === 'connector.output') return native.read(input)
      expect(capability).toBe('connector.execute')
      const args = input['args'] as string[]
      calls.push(args)
      const id = args[args.indexOf('--source-group') + 1],
        cursor = args.includes('--cursor') ? args[args.indexOf('--cursor') + 1] : '',
        error = (stale && cursor) || failFirst
      const source = group(id?.slice(7, 8))
      const value =
        args[0] === '--version'
          ? 'skillager 0.9.10'
          : JSON.stringify(
              error
                ? {
                    schema: 'skillager.error.v1',
                    error: { code: 'stale_cursor' },
                  }
                : {
                    schema: 'skillager.list.v1',
                    scope: 'library',
                    total_skills: 101,
                    skills: [
                      {
                        id: `lib/${id}/${cursor || 'first'}`,
                        name: cursor || 'First',
                        description: 'A skill',
                        status: 'accepted',
                        skill_file: `/library/${id}/${cursor || 'first'}/SKILL.md`,
                        source_group: source,
                      },
                    ],
                    next_cursor: cursor ? null : 'next',
                  },
            )
      const result = native.complete(
        { outcome: 'completed', code: error ? 15 : 0, receipt: String(++serial) },
        value,
      )
      if (holding && args[0] === 'list') {
        holding = false
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      return result
    },
  }
  const navigation = module.bindSkillList(document, list, {
    available: () => visible,
    selected: (row: Value) => {
      selected = row
    },
    choose,
    task,
  })
  const owner = module.bindLibrarySources(document, list, navigation, client, {
    context: () => ({ visible }),
    available: () => visible,
    selected: () => selected,
  })
  const library = { id: 'first-library', root: '/library' }
  const render = (groups = [group()], identity = library) =>
    owner.render(module.libraryGroups(envelope(groups)), identity)
  const header = (id = group().id) =>
    [...list.querySelectorAll<HTMLButtonElement>('[data-source-toggle]')].find(
      (row) => row.dataset['sourceToggle'] === id,
    )!
  const control = (action: string) =>
    list.querySelector<HTMLButtonElement>(`[data-source-action="${action}"]`)!
  dispose = () => {
    owner.dispose()
    navigation.dispose()
  }
  return {
    owner,
    list,
    calls,
    render,
    header,
    control,
    choose,
    task,
    hold: () => {
      holding = true
    },
    release: () => release?.(),
    stale: () => {
      stale = true
    },
    failFirst: () => {
      failFirst = true
    },
    visible: (value: boolean) => {
      visible = value
      owner.pause()
    },
  }
}
const key = (node: Element, value: string) =>
  node.dispatchEvent(
    new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }),
  )

it('parses bounded opaque source identities/counts and keeps grouping metadata out of skill identity', () => {
  const first = group(),
    second = { ...group('b'), detail: '/another/hvir' }
  expect(module.libraryGroups(envelope([first, second]))).toMatchObject({
    total: 202,
    totalGroups: 2,
    groups: [first, second],
  })
  expect(() => module.libraryGroups(envelope([first, first]))).toThrow(/count/)
  expect(() => module.sourceGroup({ ...first, id: 'hvir' })).toThrow(/invalid/)
  expect(
    module.sourceGroup({ ...first, kind: 'multiple', detail: 'hvir; dungeoneer' }),
  ).toMatchObject({ detail: 'hvir; dungeoneer' })
  expect(() => module.libraryGroups({ ...envelope(), total_skills: 1 })).toThrow(/totals/)
  expect(() => module.libraryGroups({ ...envelope(), schema: 'old' })).toThrow(
    /Update Skillager/,
  )
  expect(
    module.libraryGroupingFailure({
      cli: {
        outcome: 'completed',
        code: 2,
        stderr: 'unrecognized arguments: --group-by source',
      },
    }).message,
  ).toContain('Update Skillager')
  expect(() =>
    module.sourcePage({ total_skills: 1 }, { rows: [{ sourceGroup: second }] }, first.id),
  ).toThrow(/different/)
})
it('starts collapsed, expands only the requested source and keeps expansion independent of reading', async () => {
  const f = fixture()
  f.render([group(), group('b', 'skillager')])
  await flush()
  expect(f.calls).toEqual([])
  expect(f.list.querySelectorAll('[data-skill-occurrence]')).toHaveLength(0)
  f.header().focus()
  key(f.header(), 'ArrowRight')
  await flush()
  expect(f.calls.filter((args) => args[0] === 'list')).toEqual([
    [
      'list',
      '--scope',
      'library',
      '--json',
      '--limit',
      '100',
      '--source-group',
      group().id,
    ],
  ])
  expect(f.choose).not.toHaveBeenCalled()
  expect(f.task).not.toHaveBeenCalled()
  expect(f.list.querySelectorAll('[data-skill-occurrence]')).toHaveLength(1)
  expect(f.header().getAttribute('aria-expanded')).toBe('true')
  expect(f.header(group('b').id).getAttribute('aria-expanded')).toBe('false')
  expect(document.activeElement).toBe(f.header())
})
it('retains source page, selected action identity, focus and scroll during an ordinary refresh', async () => {
  const f = fixture()
  f.render()
  f.header().click()
  await flush()
  f.control('next').click()
  await flush()
  const row = f.list.querySelector<HTMLButtonElement>('[data-skill-select]')!
  row.click()
  row.focus()
  f.list.scrollTop = 77
  f.owner.pause()
  f.render()
  await flush()
  expect(f.control('previous').disabled).toBe(false)
  expect(f.calls.at(-1)).toContain('next')
  expect(document.activeElement?.getAttribute('data-id')).toBe(row.dataset['id'])
  expect(f.list.scrollTop).toBe(77)
  expect(f.choose).toHaveBeenCalledTimes(1)
  f.list.querySelector<HTMLButtonElement>('[data-skill-actions]')!.click()
  document.querySelector<HTMLButtonElement>('[data-task=native]')!.click()
  expect(f.task.mock.calls[0]?.[0]).toMatchObject({
    id: row.dataset['id'],
    source: 'library',
  })
})
it('collapses a pending source without reopening or issuing body work, then loads again explicitly', async () => {
  const f = fixture()
  f.render()
  f.hold()
  f.header().click()
  await flush()
  expect(f.list.textContent).toContain('Loading…')
  f.header().click()
  f.release()
  await flush()
  expect(f.header().getAttribute('aria-expanded')).toBe('false')
  expect(f.list.querySelectorAll('[data-skill-occurrence]')).toHaveLength(0)
  f.header().click()
  await flush()
  expect(f.list.querySelectorAll('[data-skill-occurrence]')).toHaveLength(1)
  expect(f.calls.filter((args) => args[0] === 'list')).toHaveLength(2)
})
it('serializes source requests and skips a queued source collapsed before execution', async () => {
  const f = fixture()
  f.render([group(), group('b'), group('c')])
  f.hold()
  f.header().click()
  await flush()
  f.header(group('b').id).click()
  f.header(group('c').id).click()
  f.header(group('b').id).click()
  expect(f.calls.filter((args) => args[0] === 'list')).toHaveLength(1)
  f.release()
  await flush()
  expect(f.calls.filter((args) => args[0] === 'list').map((args) => args.at(-1))).toEqual(
    [group().id, group('c').id],
  )
})
it('restarts a stale source cursor once and leaves first-page failures recoverable', async () => {
  const f = fixture()
  f.render()
  f.header().click()
  await flush()
  f.stale()
  f.control('next').click()
  await flush()
  expect(f.calls.filter((args) => args[0] === 'list')).toHaveLength(3)
  expect(f.list.textContent).toContain('First')
  expect(f.control('previous').disabled).toBe(true)
  f.failFirst()
  f.owner.pause()
  f.render()
  await flush()
  expect(f.control('retry')).toBeTruthy()
  expect(f.list.textContent).toContain('First')
  expect(f.calls.filter((args) => args[0] === 'list')).toHaveLength(4)
})
it('fences hidden and replaced-library replies, retaining same-library expansion only', async () => {
  const f = fixture()
  f.render()
  f.hold()
  f.header().click()
  await flush()
  f.visible(false)
  f.release()
  await flush()
  expect(f.list.querySelectorAll('[data-skill-occurrence]')).toHaveLength(0)
  f.visible(true)
  f.render()
  await flush()
  expect(f.header().getAttribute('aria-expanded')).toBe('true')
  f.hold()
  f.owner.pause()
  f.render()
  await flush()
  f.render([group()], { id: 'other-library', root: '/other' })
  f.release()
  await flush()
  expect(f.header().getAttribute('aria-expanded')).toBe('false')
  expect(f.list.querySelectorAll('[data-skill-occurrence]')).toHaveLength(0)
})
it('disambiguates equal labels and releases off-page group state', async () => {
  const f = fixture(),
    second = { ...group('b'), detail: '/another/hvir' }
  f.render([group(), second])
  expect(f.list.textContent).toContain('/another/hvir')
  f.header().click()
  await flush()
  f.render([group('c', 'other')])
  await flush()
  expect(f.list.querySelectorAll('[data-skill-occurrence]')).toHaveLength(0)
  f.render()
  await flush()
  expect(f.header().getAttribute('aria-expanded')).toBe('false')
  expect(f.list.querySelectorAll('[data-skill-occurrence]')).toHaveLength(0)
  f.header().focus()
  key(f.header(), 'ArrowRight')
  await flush()
  key(f.header(), 'ArrowLeft')
  expect(document.activeElement).toBe(f.header())
})

it('keeps the reader selection unhighlighted when its source is collapsed', async () => {
  const f = fixture(),
    sources = [group(), group('b', 'skillager')]
  f.render(sources)
  f.header().click()
  await flush()
  f.header(sources[1]!.id).click()
  await flush()
  const chosen = f.list.querySelector<HTMLButtonElement>('[data-skill-select]')!
  chosen.click()
  expect(chosen.getAttribute('aria-current')).toBe('true')
  f.header().click()
  expect(f.list.querySelectorAll('[aria-current="true"]')).toHaveLength(0)
  expect(f.list.querySelector('[data-skill-select]')?.getAttribute('tabindex')).toBe('0')
  expect(f.choose).toHaveBeenCalledTimes(1)
  const other = f.list.querySelector<HTMLButtonElement>('[data-skill-select]')!
  other.focus()
  key(other, 'End')
  expect(f.list.querySelectorAll('[aria-current="true"]')).toHaveLength(0)
  key(other, 'ContextMenu')
  expect(document.querySelector<HTMLElement>('[role=menu]')!.hidden).toBe(false)
  expect(f.list.querySelectorAll('[aria-current="true"]')).toHaveLength(0)
  key(document.activeElement!, 'Escape')
  expect(document.activeElement).toBe(other)
  f.header().click()
  expect(f.list.querySelector('[aria-current="true"]')?.getAttribute('data-id')).toBe(
    chosen.dataset['id'],
  )
  expect(f.choose).toHaveBeenCalledTimes(1)
  const next = [...f.list.querySelectorAll<HTMLButtonElement>('[data-skill-select]')].at(
    -1,
  )!
  next.click()
  expect(next.getAttribute('aria-current')).toBe('true')
  expect(f.choose).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: next.dataset['id'] }),
  )
})
it('moves through source boundaries with arrows while retaining occurrence action keys', async () => {
  const f = fixture(),
    sources = [group(), group('b', 'skillager')]
  f.render(sources)
  key(f.header(), 'ArrowRight')
  await flush()
  key(f.header(), 'ArrowRight')
  const row = f.list.querySelector<HTMLButtonElement>('[data-skill-select]')!
  expect(document.activeElement).toBe(row)
  key(row, 'ArrowUp')
  expect(document.activeElement).toBe(f.header())
  key(f.header(), 'ArrowDown')
  expect(document.activeElement).toBe(row)
  key(row, 'ArrowDown')
  expect(document.activeElement).toBe(f.header(sources[1]!.id))
  expect(f.header(sources[1]!.id).getAttribute('aria-expanded')).toBe('false')
  row.focus()
  key(row, 'ContextMenu')
  expect(document.querySelector<HTMLElement>('[role=menu]')!.hidden).toBe(false)
  key(document.activeElement!, 'Escape')
  expect(document.activeElement).toBe(row)
  key(row, 'ArrowRight')
  expect(document.activeElement?.hasAttribute('data-skill-actions')).toBe(true)
  key(document.activeElement!, 'ArrowUp')
  expect(document.activeElement).toBe(f.header())
  expect(f.choose).not.toHaveBeenCalled()
  expect(f.task).not.toHaveBeenCalled()
})

const optionalSourceCases = [
  ['future kind', { ...group(), kind: 'future-kind' }],
  ['empty label', { ...group(), label: '' }],
  ['oversized label', { ...group(), label: 'x'.repeat(257) }],
  ['invalid identity', { ...group(), id: 'hvir' }],
  ['malformed detail', { ...group(), detail: 42 }],
] as const
const publicList = (source?: unknown) => ({
  schema: 'skillager.list.v1',
  scope: 'library',
  total_skills: 1,
  next_cursor: 'next',
  skills: [
    {
      id: 'lib/exact',
      name: 'Exact',
      description: '',
      status: 'accepted',
      skill_file: '/library/exact/SKILL.md',
      ...(source === undefined ? {} : { source_group: source }),
    },
  ],
})
const publicSearch = (source?: unknown) => ({
  schema: 'skillager.search.v1',
  status: 'completed',
  next_cursor: 'next-ranked',
  results: [
    {
      id: 'lib/exact',
      name: 'Exact',
      search: {
        canonical: {
          library_id: '01234567-89ab-cdef-0123-456789abcdef',
          skill_id: 'lib/exact',
        },
        occurrence: {
          id: 'occurrence',
          kind: 'library',
          entrypoint: '/library/exact/SKILL.md',
        },
      },
      ...(source === undefined ? {} : { source_group: source }),
    },
  ],
})
it.each(optionalSourceCases)(
  'omits optional %s metadata from flat pages while refusing it for actual grouping',
  (_name, source) => {
    const list = publicList(source),
      search = publicSearch(source)
    expect(module.libraryPage(list)).toEqual(module.libraryPage(publicList()))
    expect(module.searchPage(search)).toEqual(module.searchPage(publicSearch()))
    expect(() => module.sourceGroup(source)).toThrow()
    expect(() =>
      module.libraryGroups({ ...envelope(), groups: [{ ...source, count: 1 }] }),
    ).toThrow()
    expect(() => module.sourcePage(list, module.libraryPage(list), group().id)).toThrow(
      /different/,
    )
  },
)
it('preserves valid source presentation and does not swallow authoritative row failures', () => {
  const source = group(),
    list = publicList(source),
    page = module.libraryPage(list),
    expected = {
      id: source.id,
      label: source.label,
      kind: source.kind,
      detail: source.detail,
    }
  expect(page).toMatchObject({
    rows: [{ id: 'lib/exact', sourceGroup: expected }],
    next: 'next',
  })
  expect(module.searchPage(publicSearch(source))).toMatchObject({
    rows: [{ id: 'occurrence', sourceGroup: expected }],
    next: 'next-ranked',
  })
  expect(module.sourcePage(list, page, source.id)).toMatchObject({ total: 1 })
  expect(() => module.sourcePage(list, page, group('b').id)).toThrow(/different/)
  expect(() =>
    module.libraryPage({
      ...list,
      skills: [
        { ...list.skills[0], source_group: optionalSourceCases[0][1], skill_file: 42 },
      ],
    }),
  ).toThrow()
  const search = publicSearch(optionalSourceCases[0][1])
  expect(() =>
    module.searchPage({
      ...search,
      results: [
        {
          ...search.results[0],
          search: { occurrence: { id: 'bad', kind: 'library', entrypoint: 42 } },
        },
      ],
    }),
  ).toThrow()
})
