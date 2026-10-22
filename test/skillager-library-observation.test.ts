// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { createSkillagerPackageView } from './fixtures/skillager-package-view'

let close: (() => void) | undefined
afterEach(() => {
  close?.()
  close = undefined
  document.body.replaceChildren()
  vi.useRealTimers()
})
async function libraryView() {
  const fixture = createSkillagerPackageView()
  close = fixture.dispose
  fixture.context()
  await fixture.flush()
  return fixture
}
function search(query: string) {
  ;(document.getElementById('query') as HTMLInputElement).value = query
  document
    .getElementById('search-form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
}
const statuses = (fixture: Awaited<ReturnType<typeof libraryView>>) =>
  fixture.calls.filter((args) => args[0] === 'library')
const state = () => document.getElementById('state')!

it('uses one current status observation across paging, search, filters, and returning to browse', async () => {
  const f = await libraryView()
  expect(statuses(f)).toHaveLength(1)
  f.button('next').click()
  await f.flush()
  expect(state().textContent).toContain('Page 2')
  f.button('previous').click()
  await f.flush()
  ;(document.getElementById('separate-copies') as HTMLInputElement).checked = true
  search('needle')
  await f.flush()
  f.button('next').click()
  await f.flush()
  const queries = f.calls.filter((args) => args[0] === 'search')
  expect(queries).toHaveLength(2)
  expect(queries.every((args) => args[args.indexOf('--view') + 1] === 'copies')).toBe(
    true,
  )
  f.button('browse').click()
  await f.flush()
  expect(state().textContent).toContain('Page 1')
  expect(statuses(f)).toHaveLength(1)
  expect(f.requests.some(({ capability }) => capability.startsWith('source.'))).toBe(
    false,
  )
})

it('refreshes status periodically without losing the page, and starts page one on explicit Refresh', async () => {
  const f = await libraryView()
  f.button('next').click()
  await f.flush()
  await vi.advanceTimersByTimeAsync(30_000 - Date.now())
  await f.flush()
  expect(statuses(f)).toHaveLength(2)
  expect(state().textContent).toContain('Page 2')
  f.button('refresh').click()
  await f.flush()
  expect(statuses(f)).toHaveLength(3)
  expect(state().textContent).toContain('Page 1')
  expect(f.button('previous').disabled).toBe(true)
})

it('renews destination metadata while keeping Library scope and page across context and visibility changes', async () => {
  const f = await libraryView()
  f.button('next').click()
  await f.flush()
  const page = f.calls.filter((args) => args[0] === 'list').at(-1)!
  expect(page[page.indexOf('--scope') + 1]).toBe('library')
  f.context(true, {
    id: 'remote',
    host: 'ssh',
    root: { hostId: 'ssh', path: '/remote' },
  })
  await f.flush()
  expect(statuses(f)).toHaveLength(2)
  expect(f.calls.filter((args) => args[0] === 'list').at(-1)).toEqual(page)
  expect(state().textContent).toContain('Page 2')
  f.context(false)
  const before = f.calls.length
  await vi.advanceTimersByTimeAsync(31_000)
  expect(f.calls).toHaveLength(before)
  f.context()
  await f.flush()
  expect(statuses(f)).toHaveLength(3)
  expect(state().dataset.state).toBe('ready')
  expect(state().textContent).toContain('Page 2')
  expect(f.calls.filter((args) => args[0] === 'list').at(-1)).toEqual(page)
  expect(
    f.requests.some(
      ({ capability }) =>
        capability === 'connector.connect' || capability.startsWith('source.'),
    ),
  ).toBe(false)
})

it.each(['delayed', 'failed'] as const)(
  'keeps a %s status refresh required when newer page intent arrives',
  async (edge) => {
    const f = await libraryView()
    if (edge === 'delayed') f.hold('library')
    else f.fail('library')
    f.button('refresh').click()
    await f.flush()
    expect(statuses(f)).toHaveLength(2)
    f.button('next').click()
    if (edge === 'delayed') f.resume()
    await f.flush()
    expect(statuses(f)).toHaveLength(3)
    expect(state().textContent).toContain('Page 2')
    expect(f.calls.filter((args) => args[0] === 'list')).toHaveLength(2)
  },
)

it('keeps fresh status and the latest search when navigation is superseded during a delayed page', async () => {
  const f = await libraryView()
  f.hold('list')
  f.button('next').click()
  await f.flush()
  f.button('refresh').click()
  search('latest intent')
  f.resume()
  await f.flush()
  expect(statuses(f)).toHaveLength(2)
  expect(f.calls.filter((args) => args[0] === 'search').map((args) => args[1])).toEqual([
    'latest intent',
  ])
  expect(state().textContent).toContain('Page 1')
  expect(f.button('previous').disabled).toBe(true)
})

it('obtains fresh status after a successful reconnect before resuming the desired page', async () => {
  const f = await libraryView()
  f.button('next').click()
  await f.flush()
  f.button('connect-program').click()
  await f.flush()
  f.hold('library')
  f.connected({ connections: [{ connector: 'library-cli', outcome: 'connected' }] })
  await f.flush()
  expect(statuses(f)).toHaveLength(2)
  expect(document.getElementById('connection-status')?.textContent).toBe(
    'Loading skills…',
  )
  f.resume()
  await f.flush()
  expect(state().textContent).toContain('Page 2')
  expect(document.getElementById('connection-status')?.textContent).toBe('')
  expect(document.getElementById('connection-status')?.hidden).toBe(true)
  expect(f.button('connect-program').getAttribute('aria-busy')).toBe('false')
})

it.each(['root', 'UUID'] as const)(
  'retires the old list selection and cursor before loading a changed library %s',
  async (identity) => {
    const f = await libraryView()
    f.button('next').click()
    await f.flush()
    expect(state().textContent).toContain('Page 2')
    if (identity === 'root') f.libraryRoot('/replacement')
    else f.identities('replacement')
    f.hold('list')
    await vi.advanceTimersByTimeAsync(30_000 - Date.now())
    await f.flush()
    expect(document.getElementById('skills')?.children).toHaveLength(0)
    expect(state().dataset.state).toBe('connecting')
    expect(state().textContent).toBe('Loading your personal library…')
    expect(document.getElementById('observation-details')?.textContent).toBe('')
    expect(f.button('next').disabled).toBe(true)
    expect(f.button('previous').disabled).toBe(true)
    const command = f.calls.filter((args) => args[0] === 'list').at(-1)!
    expect(command).not.toContain('--cursor')
    f.resume()
    await f.flush()
    expect(state().textContent).toContain('Page 1')
    await f.expand()
    expect(
      document.querySelector<HTMLElement>('#skills [data-skill-select]')?.dataset
        .sourcePath,
    ).toBe(`${identity === 'root' ? '/replacement' : '/library'}/0/SKILL.md`)
    expect(f.requests.some(({ capability }) => capability.startsWith('source.'))).toBe(
      false,
    )
  },
)

it.each(['list', 'search'] as const)(
  'restarts an expired %s cursor once with the same query and options',
  async (kind) => {
    const f = await libraryView()
    if (kind === 'search') {
      ;(document.getElementById('separate-copies') as HTMLInputElement).checked = true
      search('kept query')
      await f.flush()
    }
    f.staleCursors()
    f.button('next').click()
    await f.flush()
    expect(f.calls.filter((args) => args[0] === kind)).toHaveLength(3)
    expect(statuses(f)).toHaveLength(1)
    expect(state().dataset.state).toBe('ready')
    expect(state().textContent).toContain('Page 1')
    expect(f.button('previous').disabled).toBe(true)
    const command = f.calls.filter((args) => args[0] === kind).at(-1)!
    if (kind === 'list') expect(command).not.toContain('--cursor')
    else {
      expect(command[1]).toBe('kept query')
      expect(command[command.indexOf('--cursor') + 1]).toBe('')
      expect(command[command.indexOf('--view') + 1]).toBe('copies')
    }
  },
)

it.each([
  ['invalid_cursor', false, 2],
  ['stale_cursor', true, 3],
] as const)(
  'does not loop or reinterpret %s after a cursor failure',
  async (code, firstPageAlsoFails, count) => {
    const f = await libraryView()
    f.staleCursors(code, firstPageAlsoFails)
    f.button('next').click()
    await f.flush()
    expect(f.calls.filter((args) => args[0] === 'list')).toHaveLength(count)
    expect(state().dataset.state).toBe('stale')
    expect(document.getElementById('skills')?.textContent).toContain('Page 0')
    expect(f.requests.some((request) => request.capability === 'actions.invoke')).toBe(
      false,
    )
  },
)
