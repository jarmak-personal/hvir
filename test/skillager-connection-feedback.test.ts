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
function packageView(view = 'library') {
  const fixture = createSkillagerPackageView(view)
  close = fixture.dispose
  return fixture
}
const localProject = {
  id: 'project-a',
  host: 'local',
  root: { hostId: 'local', path: '/project-a' },
}
const projectConnection = () => ({
  connections: [{ connector: 'project-cli', outcome: 'connected' }],
  source: { source: 'project', outcome: 'granted' },
  readiness: { program: true, source: true },
})
it.each(['project', 'library'])(
  'shows immediate adjacent Connect feedback through the first useful %s observation and prevents duplicate submits',
  async (view) => {
    const f = packageView(view)
    if (view === 'project') f.projectApproval(false)
    else f.libraryApproval(false)
    f.context(true, view === 'project' ? localProject : undefined)
    await f.flush()
    const button = f.button('connect-program'),
      status = document.getElementById('connection-status')!
    button.click()
    expect(status.textContent).toBe('Connecting…')
    expect(status.getAttribute('role')).toBe('status')
    expect(button.getAttribute('aria-describedby')).toBe(status.id)
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-busy')).toBe('true')
    button.click()
    await f.flush()
    expect(
      f.requests.filter(({ capability }) => capability === 'connector.connect'),
    ).toHaveLength(1)
    f.hold()
    f.libraryApproval(true)
    f.connected({
      ...(view === 'project'
        ? {
            source: { source: 'project', outcome: 'granted' },
            readiness: { program: true, source: true },
          }
        : {}),
      connections: [
        {
          connector: view === 'project' ? 'project-cli' : 'library-cli',
          outcome: 'connected',
        },
      ],
    })
    await f.flush()
    expect(status.textContent).toBe('Loading skills…')
    expect(button.disabled).toBe(true)
    expect(button.hidden).toBe(false)
    button.click()
    expect(
      f.requests.filter(({ capability }) => capability === 'connector.connect'),
    ).toHaveLength(1)
    f.resume()
    await f.flush()
    expect(status.textContent).toBe('Connected')
    expect(button.getAttribute('aria-busy')).toBe('false')
    expect(button.hidden).toBe(true)
    expect(document.getElementById('state')?.dataset.state).toBe(
      view === 'project' ? 'empty' : 'ready',
    )
    f.fail()
    f.button('refresh').click()
    await f.flush()
    expect(status.hidden).toBe(true)
    expect(status.textContent).toBe('')
  },
)
it.each(['connection', 'observation'])(
  'settles the adjacent %s failure and retains actual diagnostic feedback',
  async (phase) => {
    const f = packageView('project')
    f.projectApproval(false)
    f.context(true, localProject)
    await f.flush()
    f.button('connect-program').click()
    await f.flush()
    if (phase === 'connection') f.connectionFailed()
    else {
      f.fail()
      f.connected(projectConnection())
    }
    await f.flush()
    expect(f.button('connect-program').getAttribute('aria-busy')).toBe('false')
    expect(document.getElementById('connection-status')?.textContent).toBe(
      phase === 'connection' ? 'Connection failed' : 'Could not load skills',
    )
    expect(document.getElementById('state')?.textContent).not.toContain('Connecting')
    if (phase === 'connection')
      expect(document.getElementById('state')?.textContent).toBe('Old connection failed')
  },
)
it('resumes a hidden library observation without stuck progress or duplicate Connect admission', async () => {
  const f = packageView()
  f.libraryApproval(false)
  f.context()
  await f.flush()
  const button = f.button('connect-program'),
    status = document.getElementById('connection-status')!
  button.click()
  await f.flush()
  f.hold()
  f.libraryApproval(true)
  f.connected({ connections: [{ connector: 'library-cli', outcome: 'connected' }] })
  await f.flush()
  expect(status.textContent).toBe('Loading skills…')
  f.context(false)
  expect(status.hidden).toBe(true)
  expect(button.getAttribute('aria-busy')).toBe('false')
  f.context()
  expect(status.textContent).toBe('Loading skills…')
  expect(button.disabled).toBe(true)
  button.click()
  f.resume()
  await f.flush()
  expect(status.textContent).toBe('Connected')
  expect(button.getAttribute('aria-busy')).toBe('false')
  expect(
    f.requests.filter(({ capability }) => capability === 'connector.connect'),
  ).toHaveLength(1)
  expect(document.getElementById('state')?.dataset.state).toBe('ready')
})

it('does not retain progress or revive it from late replies after disposal', async () => {
  const f = packageView('project')
  f.projectApproval(false)
  f.context(true, localProject)
  await f.flush()
  f.button('connect-program').click()
  await f.flush()
  f.dispose()
  expect(document.getElementById('connection-status')?.textContent).toBe('')
  f.connected(projectConnection())
  await f.flush()
  expect(f.button('connect-program').getAttribute('aria-busy')).toBe('false')
  expect(document.getElementById('connection-status')?.textContent).toBe('')
})

it.each(['timer', 'search', 'in-flight search'])(
  'resumes %s after a declined connection or rejected reply, retaining feedback and periodic refresh',
  async (edge) => {
    for (const outcome of ['declined', 'failed']) {
      const f = packageView('project')
      f.unapproved()
      f.context(true, localProject)
      await f.flush()
      const search = () => {
        ;(document.getElementById('query') as HTMLInputElement).value = 'kept search'
        document
          .getElementById('search-form')!
          .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      }
      if (edge === 'in-flight search') {
        f.hold()
        search()
        await f.flush()
      }
      f.button('connect-program').click()
      await f.flush()
      if (edge === 'search') search()
      if (edge === 'timer') await vi.advanceTimersByTimeAsync(31_000)
      await f.flush()
      const before = f.calls.length
      if (outcome === 'declined')
        f.connected({ connections: [{ connector: 'project-cli', outcome }] })
      else f.connectionFailed()
      if (edge === 'in-flight search') f.resume()
      await f.flush()
      expect(f.calls.length).toBeGreaterThan(before)
      const expectedArgs = [
        'list',
        '--scope',
        'project',
        '--json',
        '--limit',
        '100',
        ...(edge === 'timer' ? [] : ['--query', 'kept search']),
      ]
      expect(f.calls.slice(before)).toContainEqual(expectedArgs)
      expect(f.calls.some((args) => args[0] === 'search')).toBe(false)
      expect(document.getElementById('connection-status')?.textContent).toBe(
        outcome === 'declined' ? 'Not connected' : 'Connection failed',
      )
      expect(
        document.getElementById('connection-status')?.getAttribute('aria-description'),
      ).toContain(
        outcome === 'declined'
          ? 'not connected for this project'
          : 'Old connection failed',
      )
      expect(f.button('connect-program').getAttribute('aria-busy')).toBe('false')
      const observed = f.calls.length
      await vi.advanceTimersByTimeAsync(31_000)
      expect(f.calls.length).toBeGreaterThan(observed)
      expect(f.calls.slice(observed)).toContainEqual(expectedArgs)
      f.dispose()
      vi.useRealTimers()
    }
  },
)

it('keeps missing project read access explicit after a declined combined attempt without a fallback prompt', async () => {
  const f = packageView('project')
  f.projectRead(false)
  f.context(true, localProject)
  await f.flush()
  expect(f.button('connect-program').hidden).toBe(false)
  f.button('connect-program').click()
  await f.flush()
  expect(
    f.requests.find((entry) => entry.capability === 'connector.connect')?.input,
  ).toEqual({ connector: 'project-cli', source: 'project' })
  f.connected({
    connections: [{ connector: 'project-cli', outcome: 'connected' }],
    source: { source: 'project', outcome: 'declined' },
    readiness: { program: true, source: false },
  })
  await f.flush()
  expect(f.button('connect-program').disabled).toBe(false)
  expect(document.getElementById('connection-status')?.textContent).toBe('Not connected')
  expect(document.getElementById('state')?.textContent).toContain(
    'Project read access was not confirmed',
  )
  expect(f.requests.some((entry) => entry.capability === 'source.request')).toBe(false)
  f.button('refresh').click()
  await f.flush()
  expect(f.button('connect-program').hidden).toBe(false)
  expect(
    f.requests.filter((entry) => entry.capability === 'connector.connect'),
  ).toHaveLength(1)
})
it('retains only the submitted project connection intent through passive picker visibility loss', async () => {
  const f = packageView('project')
  f.projectApproval(false)
  f.context(true, localProject)
  await f.flush()
  f.button('connect-program').click()
  await f.flush()
  f.context(false, localProject)
  f.context(true, localProject)
  f.connected(projectConnection())
  await f.flush()
  expect(document.getElementById('connection-status')?.textContent).toBe('Connected')
  expect(
    f.requests.filter((entry) => entry.capability === 'connector.connect'),
  ).toHaveLength(1)
})
it.each(['program', 'source'])(
  'never reports current readiness from a completed but withdrawn %s grant',
  async (scope) => {
    const f = packageView('project')
    f.projectApproval(false)
    f.context(true, localProject)
    await f.flush()
    f.button('connect-program').click()
    await f.flush()
    f.connected({
      ...projectConnection(),
      readiness: { program: scope !== 'program', source: scope !== 'source' },
    })
    await f.flush()
    expect(document.getElementById('connection-status')?.textContent).toBe(
      'Connection not confirmed',
    )
    expect(f.requests.some((entry) => entry.capability === 'source.request')).toBe(false)
    if (scope === 'program')
      expect(document.getElementById('state')?.textContent).toContain(
        'Program access was saved but is no longer ready',
      )
  },
)
