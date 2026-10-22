// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { createSkillagerPackageView } from './fixtures/skillager-package-view'
let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  document.body.replaceChildren()
  vi.useRealTimers()
})
function fixture(view = 'library') {
  const f = createSkillagerPackageView(view)
  dispose = f.dispose
  return f
}
const project = {
  id: 'project',
  host: 'local',
  root: { hostId: 'local', path: '/project' },
}
function search(value: string) {
  ;(document.getElementById('query') as HTMLInputElement).value = value
  document
    .getElementById('search-form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
}
it.each(['library', 'project'])(
  'browses collapsed sources in %s Library and exposes active search matches directly',
  async (view) => {
    const f = fixture(view)
    f.context(true, project)
    await f.flush()
    if (view === 'project') {
      f.button('scope-library').click()
      await f.flush()
    }
    expect(document.querySelectorAll('#skills [data-source-toggle]')).toHaveLength(1)
    expect(document.querySelectorAll('#skills [data-skill-occurrence]')).toHaveLength(0)
    expect(f.calls.filter((args) => args.includes('--source-group'))).toHaveLength(0)
    await f.expand()
    expect(f.calls.filter((args) => args.includes('--source-group'))).toHaveLength(1)
    expect(document.querySelectorAll('#skills [data-skill-occurrence]')).toHaveLength(1)
    search('skill')
    await f.flush()
    expect(document.querySelectorAll('#skills [data-source-toggle]')).toHaveLength(0)
    expect(document.querySelectorAll('#skills [data-skill-occurrence]')).toHaveLength(1)
    expect(document.querySelector('#skills small')?.textContent).toBe('Page 0')
    f.button('browse').click()
    await f.flush()
    expect(
      document
        .querySelector('#skills [data-source-toggle]')
        ?.getAttribute('aria-expanded'),
    ).toBe('true')
  },
)
it('keeps known sources interactive during and after an ordinary metadata refresh failure', async () => {
  const f = fixture('project')
  f.context(true, project)
  await f.flush()
  f.button('scope-library').click()
  await f.flush()
  f.hold('library')
  f.button('refresh').click()
  await vi.advanceTimersByTimeAsync(100)
  await f.expand()
  expect(
    document.querySelector('#skills [data-source-toggle]')?.getAttribute('aria-expanded'),
  ).toBe('true')
  f.resume('Temporary status failure')
  await f.flush()
  expect(document.getElementById('state')?.dataset['state']).not.toBe('ready')
  const toggle = document.querySelector<HTMLButtonElement>(
    '#skills [data-source-toggle]',
  )!
  toggle.click()
  await f.flush()
  expect(
    document.querySelector('#skills [data-source-toggle]')?.getAttribute('aria-expanded'),
  ).toBe('false')
  await f.expand()
  document.querySelector<HTMLButtonElement>('#skills [data-skill-select]')!.click()
  await f.flush()
  expect(f.opened.at(-1)).toMatchObject({
    contributionId: 'detail',
    input: { row: { id: 'lib/0' } },
  })
  f.button('refresh').click()
  await f.flush()
  expect(document.getElementById('state')?.dataset['state']).toBe('ready')
})
it('pages source groups independently without presenting a single group page as the whole library', async () => {
  const f = fixture()
  f.context()
  await f.flush()
  expect(document.getElementById('state')?.textContent).toContain('3 skills · 3 sources')
  await f.expand()
  f.button('next').click()
  await f.flush()
  expect(document.querySelector('#skills [data-source-toggle]')?.textContent).toContain(
    'Page 1',
  )
  expect(document.querySelectorAll('#skills [data-skill-occurrence]')).toHaveLength(0)
  f.button('previous').click()
  await f.flush()
  expect(
    document.querySelector('#skills [data-source-toggle]')?.getAttribute('aria-expanded'),
  ).toBe('false')
  expect(document.querySelectorAll('#skills [data-skill-occurrence]')).toHaveLength(0)
})

it('offers an update for old grouping support while independent search stays usable', async () => {
  const f = fixture()
  f.unsupportedSourceGroups()
  f.context()
  await f.flush()
  expect(document.getElementById('state')?.dataset['state']).toBe('update-required')
  expect(document.getElementById('observation-details')?.textContent).toContain(
    'Update Skillager to browse your library by source',
  )
  search('skill')
  await f.flush()
  expect(document.querySelectorAll('#skills [data-skill-select]')).toHaveLength(1)
  expect(document.getElementById('state')?.dataset['state']).toBe('ready')
})
it('ignores a late expanded-source reply after a search intent replaces grouped browsing', async () => {
  const f = fixture()
  f.context()
  await f.flush()
  f.hold('list')
  document.querySelector<HTMLButtonElement>('#skills [data-source-toggle]')!.click()
  await vi.advanceTimersByTimeAsync(100)
  search('skill')
  await f.flush()
  f.resume()
  await f.flush()
  expect(document.querySelectorAll('#skills [data-source-toggle]')).toHaveLength(0)
  expect(document.querySelector('#skills [data-skill-select]')?.textContent).toContain(
    'lib/search',
  )
  expect(f.calls.filter((args) => args.includes('--source-group'))).toHaveLength(1)
})

it('resumes retained source navigation on same-workspace show even while renewal is held or fails', async () => {
  const f = fixture('project')
  f.context(true, project)
  await f.flush()
  f.button('scope-library').click()
  await f.flush()
  f.context(false, project)
  await f.flush()
  f.hold('library')
  f.context(true, project)
  await f.expand()
  expect(
    document.querySelector('#skills [data-source-toggle]')?.getAttribute('aria-expanded'),
  ).toBe('true')
  expect(document.querySelectorAll('#skills [data-skill-select]')).toHaveLength(1)
  f.resume('Temporary renewal failure')
  await f.flush()
  document.querySelector<HTMLButtonElement>('#skills [data-source-toggle]')!.click()
  await f.expand()
  document.querySelector<HTMLButtonElement>('#skills [data-skill-select]')!.click()
  await f.flush()
  expect(f.opened.at(-1)).toMatchObject({
    contributionId: 'detail',
    input: { row: { id: 'lib/0' } },
  })
  f.context(false, project)
  await f.flush()
  f.hold('library')
  const calls = f.calls.filter((args) => args.includes('--source-group')).length
  f.context(true, { ...project, id: 'other', root: { hostId: 'local', path: '/other' } })
  document.querySelector<HTMLButtonElement>('#skills [data-source-toggle]')!.click()
  await f.flush()
  expect(f.calls.filter((args) => args.includes('--source-group'))).toHaveLength(calls)
  f.resume()
  await f.flush()
})

it.each(['visibility', 'scope'])(
  'resumes an interrupted first source page on %s return while renewal is held and fails',
  async (transition) => {
    const f = fixture('project')
    f.context(true, project)
    await f.flush()
    f.button('scope-library').click()
    await f.flush()
    f.hold('list')
    document.querySelector<HTMLButtonElement>('#skills [data-source-toggle]')!.click()
    await vi.advanceTimersByTimeAsync(100)
    expect(document.querySelector('#skills')?.textContent).toContain('Loading…')
    if (transition === 'visibility') f.context(false, project)
    else f.button('scope-project').click()
    await f.flush()
    f.resume()
    await f.flush()
    f.hold('library')
    if (transition === 'visibility') f.context(true, project)
    else f.button('scope-library').click()
    await f.flush()
    expect(document.querySelectorAll('#skills [data-skill-select]')).toHaveLength(1)
    expect(
      document
        .querySelector('#skills [data-source-toggle]')
        ?.getAttribute('aria-expanded'),
    ).toBe('true')
    expect(f.calls.filter((args) => args.includes('--source-group'))).toHaveLength(2)
    f.resume('Temporary renewal failure')
    await f.flush()
    expect(document.querySelectorAll('#skills [data-skill-select]')).toHaveLength(1)
    document.querySelector<HTMLButtonElement>('#skills [data-skill-select]')!.click()
    await f.flush()
    expect(f.opened.at(-1)).toMatchObject({
      contributionId: 'detail',
      input: { row: { id: 'lib/0' } },
    })
    expect(f.calls.filter((args) => args.includes('--source-group'))).toHaveLength(2)
  },
)

it('distinguishes unreadable library metadata from a genuinely empty library', async () => {
  const f = fixture()
  f.libraryDiscoveryErrors(2)
  f.context()
  await f.flush()
  expect(document.getElementById('state')?.textContent).toBe(
    '3 skills · 3 sources · Page 1 · Some skills could not be listed',
  )
  f.empty()
  f.button('refresh').click()
  await f.flush()
  expect(document.getElementById('state')?.dataset['state']).toBe('partial')
  expect(document.getElementById('state')?.textContent).toBe(
    'Library skills could not be listed. Try refreshing.',
  )
  expect(document.querySelectorAll('#skills [data-source-toggle]')).toHaveLength(0)
  expect(f.button('refresh').disabled).toBe(false)
  f.libraryDiscoveryErrors(0)
  f.button('refresh').click()
  await f.flush()
  expect(document.getElementById('state')?.dataset['state']).toBe('empty-library')
  expect(document.getElementById('state')?.textContent).toBe(
    'Your personal library is empty.',
  )
})
