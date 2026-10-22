// @vitest-environment happy-dom
import { createSkillagerPackageView } from './fixtures/skillager-package-view'
import { afterEach, expect, it, vi } from 'vitest'

let close: (() => void) | undefined
afterEach(() => {
  close?.()
  close = undefined
  document.body.replaceChildren()
  vi.useRealTimers()
})
function packageView(view = 'library') {
  const fixture = createSkillagerPackageView(view)
  close = fixture.dispose
  return fixture
}

it('commits cursor/history only with a successful page, including failed Next/retry/Previous and hidden completion', async () => {
  const f = packageView()
  f.context()
  await f.flush()
  expect(document.getElementById('skills')?.textContent).toContain('Page 0')
  f.fail()
  f.button('next').click()
  await f.flush()
  expect(document.getElementById('skills')?.textContent).toContain('Page 0')
  expect(f.button('previous').disabled).toBe(true)
  f.button('next').click()
  await f.flush()
  expect(document.getElementById('state')?.textContent).toContain('Page 2')
  f.button('previous').click()
  await f.flush()
  expect(document.getElementById('skills')?.textContent).toContain('Page 0')
  expect(f.button('previous').disabled).toBe(true)
  f.hold()
  f.button('next').click()
  await vi.advanceTimersByTimeAsync(100)
  f.context(false)
  f.resume()
  await f.flush()
  expect(document.getElementById('skills')?.textContent).toContain('Page 0')
  expect(f.button('previous').disabled).toBe(true)
  f.context()
  await f.flush()
  expect(document.getElementById('state')?.textContent).toContain('Page 2')
  f.button('previous').click()
  await f.flush()
  expect(document.getElementById('skills')?.textContent).toContain('Page 0')
})

it('keeps failed search descriptors separate from old-page navigation and retries first-page search on renewal', async () => {
  const f = packageView()
  f.context()
  await f.flush()
  f.button('next').click()
  await f.flush()
  const input = document.getElementById('query') as HTMLInputElement
  input.value = 'new query'
  f.fail('search')
  document
    .getElementById('search-form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await f.flush()
  expect(document.getElementById('skills')?.textContent).toContain('Page 1')
  expect(f.button('next').disabled).toBe(true)
  expect(f.button('previous').disabled).toBe(true)
  f.context(false)
  f.context()
  await f.flush()
  const searches = f.calls.filter((args) => args[0] === 'search')
  expect(searches).toHaveLength(2)
  for (const args of searches) expect(args[args.indexOf('--cursor') + 1]).toBe('')
  expect(document.getElementById('state')?.textContent).toContain('Page 1')
  expect(document.getElementById('skills')?.textContent).toContain('lib/search')
  expect(f.button('previous').disabled).toBe(true)
  f.fail('list')
  f.button('browse').click()
  await f.flush()
  expect(document.getElementById('skills')?.textContent).toContain('lib/search')
  expect(f.button('next').disabled).toBe(true)
  f.button('refresh').click()
  await f.flush()
  expect(document.getElementById('skills')?.textContent).toContain('Page 0')
  input.value = 'hidden query'
  f.hold()
  document
    .getElementById('search-form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await vi.advanceTimersByTimeAsync(100)
  f.context(false)
  f.resume()
  await f.flush()
  expect(document.getElementById('skills')?.textContent).toContain('Page 0')
  f.context()
  await f.flush()
  const renewed = f.calls.filter((args) => args[0] === 'search').at(-1)!
  expect(renewed[1]).toBe('hidden query')
  expect(renewed[renewed.indexOf('--cursor') + 1]).toBe('')
  expect(f.button('previous').disabled).toBe(true)
})

it.each(['next', 'previous'] as const)(
  'honors enabled %s navigation during a background refresh without committing stale rows or duplicate history',
  async (direction) => {
    const f = packageView()
    f.context()
    await f.flush()
    if (direction === 'previous') {
      f.button('next').click()
      await f.flush()
    }
    f.hold()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(document.getElementById('state')?.dataset.state).toBe('stale')
    expect(f.button(direction).disabled).toBe(false)
    f.button(direction).click()
    f.button(direction).click()
    f.resume()
    await f.flush()
    expect(document.getElementById('skills')?.textContent).toContain(
      direction === 'next' ? 'Page 1' : 'Page 0',
    )
    expect(document.getElementById('state')?.textContent).toContain(
      direction === 'next' ? 'Page 2' : 'Page 1',
    )
    if (direction === 'next') {
      f.button('previous').click()
      await f.flush()
    }
    expect(f.button('previous').disabled).toBe(true)
  },
)

it('replaces queued paging with explicit search/filter intent through a pending connection and hide/show', async () => {
  const f = packageView()
  f.context()
  await f.flush()
  f.hold()
  f.button('refresh').click()
  await vi.advanceTimersByTimeAsync(100)
  f.button('next').click()
  f.button('connect-program').click()
  ;(document.getElementById('separate-copies') as HTMLInputElement).checked = true
  submitQuery('replacement')
  expect(f.button('next').disabled).toBe(true)
  f.button('next').click()
  f.context(false)
  f.resume()
  await f.flush()
  f.context()
  f.connected({ connections: [{ connector: 'library-cli', outcome: 'declined' }] })
  await f.flush()
  const search = f.calls.find((args) => args[0] === 'search')!
  expect(search[1]).toBe('replacement')
  expect(search[search.indexOf('--cursor') + 1]).toBe('')
  expect(search[search.indexOf('--view') + 1]).toBe('copies')
  expect(f.calls.filter((args) => args[0] === 'list')).toHaveLength(1)
  expect(document.getElementById('state')?.textContent).toContain('Page 1')
  expect(f.button('previous').disabled).toBe(true)
})

it.each(['library', 'ssh', 'local'])(
  'keeps Library options on Library and omits them from Project (%s)',
  async (kind) => {
    const f = packageView(kind === 'library' ? 'library' : 'project')
    f.context(
      true,
      kind === 'library'
        ? undefined
        : {
            id: 'workspace',
            host: kind === 'local' ? 'local' : 'ssh',
            root: { hostId: kind === 'local' ? 'local' : 'ssh', path: '/project' },
          },
    )
    await f.flush()
    const installed = document.getElementById(
      'include-installed',
    ) as HTMLInputElement | null
    if (kind === 'library') {
      expect(installed?.checked).toBe(false)
      expect(installed?.disabled).toBe(true)
      expect(installed?.title).toContain('unknown')
    } else {
      expect(installed).toBeNull()
      expect(document.querySelector('.search-options')).toBeNull()
      expect(document.getElementById('separate-copies')).toBeNull()
      expect(document.getElementById('preferred-agent')).toBeNull()
    }
    if (kind === 'ssh') expect(f.calls).toEqual([])
  },
)

it('retries only explicit completed-source frequency refusal once and cancels the wait on hide', async () => {
  const f = packageView()
  f.frequency()
  f.context()
  await f.flush()
  await f.flush()
  expect(f.calls.filter((args) => args[0] === '--version')).toHaveLength(2)
  expect(document.getElementById('state')?.dataset.state).toBe('ready')
  f.frequency()
  f.button('refresh').click()
  await vi.advanceTimersByTimeAsync(100)
  f.context(false)
  const count = f.calls.length
  await f.flush()
  expect(f.calls).toHaveLength(count)
  close?.()
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['unapproved', 'executable-changed'] as const)(
  'makes native %s refusal actionable while retaining last-known observations and exact search options',
  async (reason) => {
    const f = packageView()
    f.context()
    await f.flush()
    const before = document.getElementById('skills')!.textContent
    f.unapproved(reason)
    f.button('refresh').click()
    await f.flush()
    expect(document.getElementById('state')!.textContent).toContain(
      reason === 'unapproved' ? 'choose Connect Skillager' : 'Choose Connect Skillager',
    )
    expect(document.getElementById('state')!.textContent).toContain(
      'Last-known rows retained',
    )
    expect(document.getElementById('state')!.textContent).not.toContain(
      'not-started: unapproved',
    )
    expect(document.getElementById('skills')!.textContent).toBe(before)
    expect(f.button('connect-program').hidden).toBe(false)
    if (reason === 'executable-changed')
      expect(document.getElementById('state')!.textContent).toContain(
        'Skillager was updated',
      )
    expect(document.getElementById('installed-note')!.textContent).toContain(
      'Installed copies are unknown',
    )
    expect(
      (document.getElementById('include-installed') as HTMLInputElement).disabled,
    ).toBe(true)
    expect(
      (document.getElementById('include-installed') as HTMLInputElement).checked,
    ).toBe(false)
    const options = document.querySelector<HTMLDetailsElement>('.search-options')!
    expect(options.open).toBe(false)
    options.querySelector('summary')!.click()
    expect(options.open).toBe(true)
  },
)

it('delivers the current Connect result after picker context focus loss without confusing the browse generation', async () => {
  const f = packageView()
  f.context()
  await f.flush()
  f.button('connect-program').click()
  await f.flush()
  f.context(false)
  await f.flush()
  f.context(true)
  await f.flush()
  f.connected({
    connections: [
      {
        connector: 'library-cli',
        outcome: 'declined',
        explanation: 'Program access was declined',
      },
    ],
  })
  await f.flush()
  expect(
    document.getElementById('connection-status')!.getAttribute('aria-description'),
  ).toBe('Program access was declined')
  expect(document.getElementById('connection-status')!.textContent).toBe('Not connected')
  expect(document.getElementById('state')!.dataset.state).toBe('ready')
})

const localProject = {
  id: 'project-a',
  host: 'local',
  root: { hostId: 'local', path: '/project-a' },
}
function submitQuery(query: string) {
  ;(document.getElementById('query') as HTMLInputElement).value = query
  document
    .getElementById('search-form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
}
const projectConnection = (outcome = 'connected') => ({
  connections: [
    { connector: 'project-cli', outcome, explanation: 'Opaque core connection fact' },
  ],
  source: { source: 'project', outcome: outcome === 'connected' ? 'granted' : outcome },
  readiness: { program: outcome === 'connected', source: outcome === 'connected' },
})
it('connects the current project and automatically preserves project query without library program approval or search options', async () => {
  const f = packageView('project')
  f.projectApproval(false)
  f.libraryApproval(false)
  f.context(true, localProject)
  await f.flush()
  expect(f.button('connect-program').hidden).toBe(false)
  expect(document.getElementById('state')?.textContent).toBe(
    'Connect Skillager to browse skills.',
  )
  submitQuery('exact query')
  await f.flush()
  f.button('connect-program').click()
  await f.flush()
  expect(f.requests.filter((r) => r.capability === 'connector.connect')).toEqual([
    {
      capability: 'connector.connect',
      input: { connector: 'project-cli', source: 'project' },
    },
  ])
  f.connected(projectConnection())
  await f.flush()
  const commands = f.requests.filter((r) => r.capability === 'connector.execute')
  expect(
    commands.every(
      (r) =>
        r.input.connector === 'project-cli' &&
        r.input.workspace === 'project-a' &&
        r.input.host === 'local',
    ),
  ).toBe(true)
  const search = commands.findLast((r) => (r.input.args as string[])[0] === 'list')!.input
    .args as string[]
  expect(search).toEqual([
    'list',
    '--scope',
    'project',
    '--json',
    '--limit',
    '100',
    '--query',
    'exact query',
  ])
  expect(f.button('connect-program').hidden).toBe(true)
  expect(document.getElementById('state')?.dataset.state).toBe('empty')
  expect(f.initializationRequests).toEqual([])
})
it('switches the project list to Library without opening a second browser', async () => {
  const f = packageView('project')
  f.context(true, localProject)
  await f.flush()
  f.button('scope-library').click()
  await f.flush()
  expect(f.opened).toEqual([])
  expect(f.button('scope-library').getAttribute('aria-pressed')).toBe('true')
  expect(document.getElementById('skills')?.textContent).toContain('Page 0')
})
it.each(['timer', 'query'] as const)(
  'automatically discovers after a current pending connection survives %s observations',
  async (edge) => {
    const f = packageView('project')
    f.projectApproval(false)
    f.libraryApproval(false)
    f.context(true, localProject)
    await f.flush()
    submitQuery('retained query')
    await f.flush()
    f.button('connect-program').click()
    await f.flush()
    if (edge === 'timer') await vi.advanceTimersByTimeAsync(31_000)
    else {
      submitQuery('new query')
      await f.flush()
    }
    const before = f.calls.length
    f.connected(projectConnection())
    await f.flush()
    expect(f.calls.length).toBeGreaterThan(before)
    const command = f.requests.findLast(
      (r) =>
        r.capability === 'connector.execute' && (r.input.args as string[])[0] === 'list',
    )!
    const args = command.input.args as string[]
    expect(command.input.connector).toBe('project-cli')
    expect(args[args.indexOf('--query') + 1]).toBe(
      edge === 'timer' ? 'retained query' : 'new query',
    )
    expect(args).not.toContain('--view')
    expect(document.getElementById('state')?.dataset.state).toBe('empty')
  },
)
it.each(['declined', 'unavailable', 'interrupted-uncertain'] as const)(
  'keeps %s connection actionable without pretending discovery succeeded',
  async (outcome) => {
    const f = packageView('project')
    f.projectApproval(false)
    f.context(true, localProject)
    await f.flush()
    document.getElementById('program-setup')!.hidden = true
    f.button('connect-program').click()
    await f.flush()
    const before = f.calls.length
    f.connected(projectConnection(outcome))
    await f.flush()
    expect(f.calls).toHaveLength(before)
    expect(document.getElementById('state')?.textContent).toContain('this project')
    expect(document.getElementById('state')?.textContent).not.toContain('Opaque core')
    expect(document.getElementById('observation-details')?.textContent).toBe(
      'Opaque core connection fact',
    )
    expect(document.getElementById('program-setup')?.hidden).toBe(false)
    expect(
      (document.getElementById('setup-request') as HTMLTextAreaElement).value,
    ).toContain('releases')
    if (outcome === 'interrupted-uncertain') {
      expect(document.getElementById('state')?.textContent).toContain(
        'may have been saved',
      )
      expect(document.getElementById('state')?.dataset.state).toBe('error')
    }
    expect(f.button('connect-program').disabled).toBe(false)
    expect(f.button('connect-program').hidden).toBe(false)
    expect(f.button('connect-program').getAttribute('aria-busy')).toBe('false')
    expect(document.getElementById('connection-status')?.textContent).toBe(
      outcome === 'declined' ? 'Not connected' : 'Connection not confirmed',
    )
  },
)
it.each(['switch', 'roundtrip', 'root'] as const)(
  'ignores both late connection branches after %s and observes only renewed current demand',
  async (edge) => {
    const f = packageView('project')
    f.projectApproval(false)
    f.context(true, localProject)
    await f.flush()
    submitQuery('kept query')
    await f.flush()
    f.button('connect-program').click()
    await f.flush()
    function withdraw() {
      if (edge === 'switch' || edge === 'roundtrip')
        f.context(true, {
          ...localProject,
          id: 'project-b',
          root: { hostId: 'local', path: '/project-b' },
        })
      if (edge === 'roundtrip') f.context(true, localProject)
      if (edge === 'root')
        f.context(true, {
          ...localProject,
          root: { hostId: 'local', path: '/replacement' },
        })
    }
    withdraw()
    await f.flush()
    expect(f.button('scope-project').disabled).toBe(false)
    expect(f.button('scope-library').disabled).toBe(false)
    const before = document.getElementById('state')?.textContent,
      calls = f.calls.length
    f.connectionFailed()
    await f.flush()
    expect(document.getElementById('state')?.textContent).toBe(before)
    expect(f.calls).toHaveLength(calls)
    f.context(true, localProject)
    await f.flush()
    f.button('connect-program').click()
    await f.flush()
    withdraw()
    await f.flush()
    const resumed = f.calls.length
    f.connected(projectConnection())
    await f.flush()
    expect(f.calls).toHaveLength(resumed) // Retired result does not trigger refresh.
    await vi.advanceTimersByTimeAsync(31_000)
    expect(f.calls.length).toBeGreaterThan(resumed)
    expect(document.getElementById('state')?.dataset.state).toBe('empty')
    expect((document.getElementById('query') as HTMLInputElement).value).toBe(
      'kept query',
    )
  },
)
it.each(['unavailable', 'error'] as const)(
  'settles main-reported %s after a same-context visibility return without replaying setup',
  async (outcome) => {
    const f = packageView('project')
    f.projectApproval(false)
    f.context(true, localProject)
    await f.flush()
    f.button('connect-program').click()
    await f.flush()
    f.context(false, localProject)
    f.context(true, localProject)
    if (outcome === 'error') f.connectionFailed()
    else f.connected(projectConnection('unavailable'))
    await f.flush()
    expect(f.button('connect-program').disabled).toBe(false)
    expect(f.button('connect-program').getAttribute('aria-busy')).toBe('false')
    expect(f.button('connect-program').hidden).toBe(false)
    expect(document.getElementById('state')?.textContent).not.toContain('Connecting')
    await vi.advanceTimersByTimeAsync(31_000)
    expect(f.requests.filter((r) => r.capability === 'connector.connect')).toHaveLength(1)
    expect(f.requests.some((r) => r.capability === 'source.request')).toBe(false)
  },
)
it.each(['root', 'roundtrip', 'hide'] as const)(
  'stops version-to-command continuation after %s',
  async (edge) => {
    const f = packageView('project')
    f.hold()
    f.context(true, localProject)
    await vi.advanceTimersByTimeAsync(100)
    if (edge === 'root')
      f.context(true, {
        ...localProject,
        root: { hostId: 'local', path: '/replacement' },
      })
    if (edge === 'roundtrip') {
      f.context(true, { ...localProject, id: 'project-b' })
      f.context(true, localProject)
    }
    if (edge === 'hide') {
      f.context(false, localProject)
      f.context(true, localProject)
    }
    f.resume()
    await f.flush()
    const executed = f.requests.filter((r) => r.capability === 'connector.execute')
    expect(executed.slice(0, 2).map((r) => (r.input.args as string[])[0])).toEqual([
      '--version',
      '--version',
    ])
    expect(executed.every((r) => r.input.connector === 'project-cli')).toBe(true)
  },
)
it.each(['ssh', 'missing-root', 'capability'] as const)(
  'hides unusable project Connect for %s',
  async (kind) => {
    const f = packageView('project')
    f.projectApproval(false)
    if (kind === 'capability') f.capabilities([])
    f.context(
      true,
      kind === 'ssh'
        ? { ...localProject, host: 'ssh', root: { hostId: 'ssh', path: '/remote' } }
        : kind === 'missing-root'
          ? { id: 'project-a', host: 'local' }
          : localProject,
    )
    await f.flush()
    expect(f.button('connect-program').hidden).toBe(true)
    f.button('connect-program').click()
    await f.flush()
    expect(f.requests.some((r) => r.capability === 'connector.connect')).toBe(false)
    if (kind !== 'capability') expect(f.calls).toEqual([])
    else {
      expect(document.getElementById('state')?.textContent).toContain(
        'Project program access',
      )
      expect(document.getElementById('state')?.textContent).not.toContain(
        'Choose Connect Skillager here',
      )
    }
  },
)
it('shows supported-release update guidance in the project tab without initialization', async () => {
  const f = packageView('project')
  f.version('0.9.2')
  f.context(true, localProject)
  await f.flush()
  expect(document.getElementById('state')?.textContent).toContain('Update Skillager')
  expect(document.getElementById('observation-details')?.textContent).toContain('0.9.3')
  expect(document.getElementById('program-setup')?.hidden).toBe(false)
  expect(
    (document.getElementById('setup-request') as HTMLTextAreaElement).value,
  ).toContain('releases')
  expect(
    (document.getElementById('setup-request') as HTMLTextAreaElement).value,
  ).toContain('Project inventory requires Skillager 0.9.7 or a supported source build.')
  expect(
    (document.getElementById('setup-request') as HTMLTextAreaElement).value,
  ).toContain('Verify list --scope project --query with pagination.')
  expect(f.initializationRequests).toEqual([])
})

it.each(['ssh', 'missing-root'] as const)(
  'keeps project queries in %s context unavailable instead of falling through to Library',
  async (kind) => {
    const f = packageView('project')
    f.context(
      true,
      kind === 'ssh'
        ? { ...localProject, host: 'ssh', root: { hostId: 'ssh', path: '/remote' } }
        : { id: 'project-a', host: 'local' },
    )
    await f.flush()
    submitQuery('project query')
    await f.flush()
    expect(f.calls).toEqual([])
    expect(document.getElementById('state')?.textContent).toContain('this project')
    expect(f.button('connect-program').hidden).toBe(true)
    f.button('scope-library').click()
    await f.flush()
    expect(f.opened).toEqual([])
    expect(f.button('scope-library').getAttribute('aria-pressed')).toBe('true')
    expect(document.getElementById('skills')?.textContent).toContain('Page 0')
  },
)

it('automatically observes an uninitialized library without listing or initializing it', async () => {
  const f = packageView()
  f.uninitialized()
  f.context()
  await f.flush()
  expect(document.getElementById('state')?.dataset['state']).toBe('no-personal-library')
  expect(f.calls.map((args) => args[0])).toEqual(['--version', 'library'])
  expect(f.button('create-library').disabled).toBe(false)
  expect(document.getElementById('library-setup')?.hidden).toBe(false)
  expect(document.getElementById('skills')?.textContent).toBe('')
})
it('shows an empty current library and actionable supported-source guidance independently', async () => {
  const f = packageView()
  f.empty()
  f.context()
  await f.flush()
  expect(document.getElementById('state')?.dataset['state']).toBe('empty-library')
  f.unsupported()
  f.button('refresh').click()
  await f.flush()
  expect(document.getElementById('state')?.textContent).toContain('Update Skillager')
  expect(document.getElementById('observation-details')?.textContent).toContain(
    'skillager.library-status.v1',
  )
  expect(document.getElementById('program-setup')?.hidden).toBe(false)
  const request = (document.getElementById('setup-request') as HTMLTextAreaElement).value
  expect(request).toContain('https://github.com/jarmak-personal/skillager/releases')
  expect(request).toContain('Preserve my existing libraries and project skills')
  expect(f.calls.filter((args) => args[0] === 'list')).toHaveLength(1)
})

it('delegates explicit default creation to the existing action and automatically browses only its verified current library', async () => {
  const f = packageView()
  f.uninitialized()
  f.initialize({
    outcome: 'verified',
    connect: true,
    observed: { id: 'library', root: { hostId: 'local', path: '/library' } },
  })
  f.context()
  await f.flush()
  expect(f.initializationRequests).toEqual([])
  f.button('create-library').click()
  await f.flush()
  expect(f.initializationRequests).toEqual([
    { action: 'initialize-library', input: { location: 'default' } },
  ])
  expect(document.getElementById('state')?.dataset['state']).toBe('empty-library')
  expect(f.calls.filter((args) => args[0] === 'list')).toHaveLength(1)
  expect(f.calls.some((args) => args.includes('init'))).toBe(false)
})
it('does not call a different observed library the verified default creation result', async () => {
  const f = packageView()
  f.uninitialized()
  f.initialize({
    outcome: 'verified',
    connect: true,
    observed: { id: 'another-library', root: { hostId: 'local', path: '/library' } },
  })
  f.context()
  await f.flush()
  f.button('create-library').click()
  await f.flush()
  expect(document.getElementById('state')?.textContent).toContain(
    'personal library changed',
  )
  expect(f.calls.some((args) => args[0] === 'list')).toBe(false)
})
it('never reports readiness from an unverified initialization reply', async () => {
  const f = packageView()
  f.uninitialized()
  f.context()
  await f.flush()
  f.button('create-library').click()
  await f.flush()
  expect(document.getElementById('state')?.textContent).toContain(
    'Creation did not settle',
  )
  expect(f.calls.some((args) => args[0] === 'list')).toBe(false)
})

it('requires renewed package visibility before retained ready rows can open a reader', async () => {
  const f = packageView()
  f.context()
  await f.flush()
  await f.expand()
  f.context(false)
  expect(document.getElementById('state')?.dataset['state']).toBe('ready')
  expect(document.querySelectorAll('#skills [data-skill-select]')).toHaveLength(1)
  expect(f.button('manage').disabled).toBe(true)
  ;(document.querySelector('#skills [data-skill-select]') as HTMLButtonElement).click()
  await f.flush()
  expect(f.opened).toEqual([])
  f.context()
  await f.flush()
  expect(f.button('manage').disabled).toBe(false)
  ;(document.querySelector('#skills [data-skill-select]') as HTMLButtonElement).click()
  await f.flush()
  expect(f.opened).toEqual([])
  expect((document.getElementById('reader-content') as HTMLElement).hidden).toBe(false)
  expect(document.querySelectorAll('#skills [data-skill-select]')).toHaveLength(1)
})

it('keeps explicit Library search local when the selected project is SSH', async () => {
  const f = packageView('library')
  f.context(true, { id: 'ssh', host: 'ssh-host', name: 'Remote' })
  await f.flush()
  submitQuery('skill')
  await f.flush()
  ;(document.querySelector('#skills [data-skill-select]') as HTMLButtonElement).click()
  await f.flush()
  expect((document.getElementById('reader-content') as HTMLElement).hidden).toBe(false)
  expect(f.calls.some((args) => args[0] === 'search')).toBe(true)
  expect(f.calls.some((args) => args.includes('--installed-project'))).toBe(false)
  expect(
    f.requests
      .filter((r) => r.capability === 'connector.execute')
      .every((r) => r.input.connector === 'library-cli'),
  ).toBe(true)
})
it('refuses a Library search occurrence from a different public library identity', async () => {
  const f = packageView('library')
  f.identities(
    '720e24b1-53e0-45f6-a84e-3df65177b38c',
    '720e24b1-53e0-45f6-a84e-3df65177b38d',
  )
  f.context()
  await f.flush()
  submitQuery('skill')
  await f.flush()
  ;(document.querySelector('#skills [data-skill-select]') as HTMLButtonElement).click()
  await f.flush()
  expect(document.getElementById('state')?.textContent).toContain(
    'personal library changed',
  )
  expect(f.opened).toEqual([])
})
it('does not substitute a selected library occurrence outside the public reported root', async () => {
  const f = packageView('library'),
    id = '720e24b1-53e0-45f6-a84e-3df65177b38c'
  f.identities(id)
  f.searchPath('/another/SKILL.md')
  f.context(true, { id: 'ssh', host: 'ssh-host' })
  await f.flush()
  ;(document.getElementById('query') as HTMLInputElement).value = 'skill'
  document
    .getElementById('search-form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await f.flush()
  ;(document.querySelector('#skills [data-skill-select]') as HTMLButtonElement).click()
  await f.flush()
  expect(f.opened).toEqual([])
  expect(document.getElementById('state')?.textContent).toContain(
    'Selected occurrence no longer belongs',
  )
})

it.each(['library', 'list'])(
  'renews Library %s metadata cancelled by a trusted destination change without replaying setup',
  async (command) => {
    const f = packageView('library')
    f.hold(command)
    f.context(true)
    await f.flush()
    const priorLists = command === 'list' ? 1 : 0
    expect(f.calls.filter((args) => args[0] === 'list')).toHaveLength(priorLists)
    // Main rejects in-flight requests before publishing the new trusted destination.
    f.resume('Project context changed; the previous request ended')
    f.context(true, {
      id: 'project',
      host: 'local',
      root: { hostId: 'local', path: '/project' },
    })
    await f.flush()
    expect(document.getElementById('state')?.dataset.state).toBe('ready')
    expect(f.calls.filter((args) => args[0] === 'list')).toHaveLength(priorLists + 1)
    const current = f.calls.length
    f.resume() // The withdrawn physical request's eventual success is inert.
    await f.flush()
    expect(f.calls).toHaveLength(current)
    expect(document.getElementById('state')?.dataset.state).toBe('ready')
    expect(
      f.requests.some((entry) =>
        ['connector.connect', 'source.request'].includes(entry.capability),
      ),
    ).toBe(false)
  },
)

it('keeps Library query, cursor, options and selected occurrence when renewing destination metadata', async () => {
  const f = packageView('library')
  f.context()
  await f.flush()
  ;(document.getElementById('separate-copies') as HTMLInputElement).checked = true
  submitQuery('retained query')
  await f.flush()
  f.button('next').click()
  await f.flush()
  const row = document.querySelector<HTMLElement>('#skills [data-skill-select]')!
  row.setAttribute('aria-current', 'true')
  const selected = row.dataset.id
  f.hold('search')
  await vi.advanceTimersByTimeAsync(30_000)
  f.resume('Project context changed; the previous request ended')
  f.context(true, {
    id: 'project',
    host: 'local',
    root: { hostId: 'local', path: '/project' },
  })
  await f.flush()
  const search = f.calls.filter((args) => args[0] === 'search').at(-1)!
  expect(search[1]).toBe('retained query')
  expect(search[search.indexOf('--cursor') + 1]).toBe('1')
  expect(search[search.indexOf('--view') + 1]).toBe('copies')
  expect((document.getElementById('query') as HTMLInputElement).value).toBe(
    'retained query',
  )
  expect(
    document.querySelector<HTMLElement>('#skills [aria-current=true]')?.dataset.id,
  ).toBe(selected)
  expect(document.getElementById('state')?.dataset.state).toBe('ready')
  const current = f.calls.length
  f.resume('Late old failure')
  await f.flush()
  expect(f.calls).toHaveLength(current)
  expect(document.getElementById('state')?.dataset.state).toBe('ready')
  expect(
    f.requests.some((entry) =>
      ['connector.connect', 'source.request'].includes(entry.capability),
    ),
  ).toBe(false)
})

it('retains each project browser scope query and exact selection while reusing the detail reader', async () => {
  const f = packageView('project')
  const original = {
    id: 'codex/project/original',
    occurrence_id: 'original-occurrence',
    name: 'Original',
    description: 'An original skill',
    status: 'pending',
    kind: 'native',
    skill_file: '/project-a/.agents/skills/original/CUSTOM.md',
    native: { agent: 'codex', scope: 'project', managed: false },
    exposure: null,
  }
  f.projectInventory({
    schema: 'skillager.list.v1',
    scope: 'project',
    project_root: '/project-a',
    observation: { status: 'complete', errors: [], error_count: 0 },
    skills: [original],
    next_cursor: null,
  })
  f.context(true, localProject)
  await f.flush()
  submitQuery('project-only')
  await f.flush()
  ;(document.querySelector('#skills [data-skill-select]') as HTMLButtonElement).click()
  await f.flush()
  expect(f.button('skill-pages').hidden).toBe(true)
  expect(document.getElementById('state')?.textContent).not.toContain('Page 1')
  f.button('scope-library').click()
  await f.flush()
  submitQuery('library-only')
  await f.flush()
  ;(document.querySelector('#skills [data-skill-select]') as HTMLButtonElement).click()
  await f.flush()
  f.button('scope-project').click()
  await f.flush()
  expect((document.getElementById('query') as HTMLInputElement).value).toBe(
    'project-only',
  )
  expect(
    document.querySelector<HTMLElement>('#skills [aria-current=true]')?.dataset.id,
  ).toBe('original-occurrence')
  expect(f.opened.at(-1)).toMatchObject({
    contributionId: 'detail',
    input: {
      row: {
        id: 'original-occurrence',
        skillId: 'codex/project/original',
        path: original.skill_file,
        source: 'project',
        host: 'local',
        workspaceId: localProject.id,
      },
    },
  })
  f.button('scope-library').click()
  await f.flush()
  expect((document.getElementById('query') as HTMLInputElement).value).toBe(
    'library-only',
  )
  expect(
    document.querySelector<HTMLElement>('#skills [aria-current=true]')?.dataset.id,
  ).toBe('search-0')
  expect(f.opened.every((entry) => entry['contributionId'] === 'detail')).toBe(true)
})
it('rejects a late Project result after switching to Library and keeps the new scope usable', async () => {
  const f = packageView('project')
  f.context(true, localProject)
  await f.flush()
  f.hold('list')
  submitQuery('delayed-project')
  await vi.advanceTimersByTimeAsync(100)
  f.button('scope-library').click()
  f.resume()
  await f.flush()
  expect(document.getElementById('skills')?.textContent).toContain('Page 0')
  expect(f.button('scope-library').getAttribute('aria-pressed')).toBe('true')
  expect(f.opened).toEqual([])
  f.button('scope-project').click()
  await f.flush()
  expect((document.getElementById('query') as HTMLInputElement).value).toBe(
    'delayed-project',
  )
  expect(f.calls.at(-1)).toContain('delayed-project')
})

it('keeps the Library sheet occurrence on renewal instead of reselecting the reader occurrence', async () => {
  const f = packageView('library')
  f.context(true, localProject)
  await f.flush()
  await f.expand()
  ;(document.querySelector('#skills [data-skill-select]') as HTMLButtonElement).click()
  await f.flush()
  expect(document.getElementById('detail-title')?.textContent).toBe('Page 0')
  f.button('next').click()
  await f.flush()
  await f.expand()
  ;(document.querySelector('#skills [data-skill-actions]') as HTMLButtonElement).click()
  ;(
    document.querySelector('#skill-row-menu [data-task=native]') as HTMLButtonElement
  ).click()
  await f.flush()
  expect(document.getElementById('skill-task-title')?.textContent).toBe('Page 1')
  const before = f.calls.length
  f.context(false, localProject)
  f.context(true, localProject)
  await f.flush()
  expect(document.getElementById('skill-task-sheet')?.hidden).toBe(false)
  expect(document.getElementById('detail-title')?.textContent).toBe('Page 0')
  expect(document.getElementById('skill-task-title')?.textContent).toBe('Page 1')
  const selectedObservations = f.calls
    .slice(before)
    .filter((args) => args[0] === 'library' && args[2]?.startsWith('lib/'))
  expect(selectedObservations.length).toBeGreaterThan(0)
  expect(selectedObservations.every((args) => args[2] === 'lib/1')).toBe(true)
  expect(document.getElementById('state')?.textContent).toContain('Page 2')
})
