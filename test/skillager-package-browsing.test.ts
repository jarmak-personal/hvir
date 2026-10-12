// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { buildSync } from 'esbuild'
import { afterEach, expect, it, vi } from 'vitest'

let close: (() => void) | undefined
afterEach(() => {
  close?.()
  close = undefined
  document.body.replaceChildren()
  vi.useRealTimers()
})
function packageView(view = 'library') {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const template = document.createElement('template')
  template.innerHTML = readFileSync(`packages/skillager-extension/${view}.html`, 'utf8')
  for (const node of template.content.querySelectorAll('script, link')) node.remove()
  document.body.replaceChildren(template.content.cloneNode(true))
  document.body.dataset.view = view
  let receive!: (message: unknown) => void
  const requests: Array<{ capability: string; input: Record<string, unknown> }> = [],
    calls: string[][] = [],
    outputs = new Map<string, string>()
  let serial = 0,
    fail = false,
    failOn: string | undefined,
    initialized = true,
    identifier = 'library',
    canonicalIdentifier: string | undefined,
    occurrencePath = '/library/search/SKILL.md',
    supported = true,
    count = 3,
    initialization: unknown,
    hold = false,
    frequency = false,
    unapproved = false,
    projectApproved = true,
    libraryApproved = true,
    version = '0.9.3',
    resume: (() => void) | undefined,
    finishConnection: ((value: unknown, error?: string) => void) | undefined
  const opened: Record<string, unknown>[] = []
  const initializationRequests: Record<string, unknown>[] = []
  const send = (message: {
    kind: string
    id: string
    capability: string
    input: Record<string, unknown>
  }) => {
    if (message.kind === 'hello') {
      receive({ kind: 'hello', capabilities: ['connector.connect'] })
      return
    }
    if (message.kind !== 'request') return
    requests.push({ capability: message.capability, input: message.input })
    let value: unknown
    if (message.capability === 'viewer.open-own') opened.push(message.input)
    if (message.capability === 'actions.invoke') {
      initializationRequests.push(message.input)
      if (initialization) {
        initialized = true
        count = 0
      }
      receive({
        kind: 'result',
        id: message.id,
        ok: true,
        value: initialization ?? {
          outcome: 'uncertain',
          message: 'Creation did not settle; no ready state claimed.',
        },
      })
      return
    }
    if (message.capability === 'connector.connect') {
      finishConnection = (value, error) => {
        if (
          (
            value as { connections?: { connector: string; outcome: string }[] }
          )?.connections?.some(
            (entry) => entry.connector === 'project-cli' && entry.outcome === 'connected',
          )
        )
          projectApproved = true
        receive({ kind: 'result', id: message.id, ok: !error, value, error })
      }
      return
    }
    if (message.capability === 'connector.execute') {
      const args = message.input.args as string[]
      calls.push(args)
      if (
        unapproved ||
        (message.input.connector === 'project-cli' && !projectApproved) ||
        (message.input.connector === 'library-cli' && !libraryApproved)
      ) {
        unapproved = false
        value = { outcome: 'not-started', reason: 'unapproved' }
      } else if (frequency) {
        frequency = false
        value = { outcome: 'not-started', reason: 'frequency' }
      } else if (fail && (!failOn || args[0] === failOn)) {
        fail = false
        value = { outcome: 'failed', code: 1 }
      } else {
        const receipt = String(++serial),
          cursor = args[args.indexOf('--cursor') + 1]
        const index = args.includes('--cursor') && cursor ? Number(cursor) : 0
        const text =
          args[0] === '--version'
            ? `skillager ${version}`
            : JSON.stringify(
                args[0] === 'library'
                  ? {
                      schema: supported ? 'skillager.library-status.v1' : 'old-status',
                      initialized,
                      library: {
                        registration: 'valid',
                        library_id: identifier,
                        root: '/library',
                      },
                      counts: { skills: count },
                    }
                  : args[0] === 'search'
                    ? {
                        schema: 'skillager.search.v1',
                        status: 'completed',
                        results: [
                          {
                            id: 'lib/search',
                            search: {
                              ...(canonicalIdentifier
                                ? {
                                    canonical: {
                                      library_id: canonicalIdentifier,
                                      skill_id: 'lib/search',
                                    },
                                  }
                                : {}),
                              occurrence: {
                                id: `search-${index}`,
                                kind: 'library',
                                entrypoint: occurrencePath,
                              },
                            },
                          },
                        ],
                        next_cursor: index < 2 ? String(index + 1) : null,
                      }
                    : args[0] === 'review'
                      ? { selected: [], action: { changed: [] } }
                      : args[0] === 'expose'
                        ? { schema: 'skillager.exposures.v1', exposures: [] }
                        : {
                            schema: 'skillager.list.v1',
                            scope: 'library',
                            skills: count
                              ? [
                                  {
                                    id: `lib/${index}`,
                                    name: `Page ${index}`,
                                    description: '',
                                    status: 'pending',
                                    skill_file: `/library/${index}/SKILL.md`,
                                  },
                                ]
                              : [],
                            next_cursor: count && index < 2 ? String(index + 1) : null,
                          },
              )
        outputs.set(receipt, text)
        value = { outcome: 'completed', code: 0, receipt }
      }
    } else if (message.capability === 'connector.output') {
      value = message.input.release
        ? null
        : {
            data:
              message.input.stream === 'stderr'
                ? ''
                : outputs.get(String(message.input.receipt)),
            nextOffset: null,
          }
    } else {
      value = null
    }
    const reply = () => receive({ kind: 'result', id: message.id, ok: true, value })
    if (hold && message.capability === 'connector.execute') {
      hold = false
      resume = reply
    } else reply()
  }
  const bridge = {
    onMessage: (callback: typeof receive) => {
      receive = callback
      return () => {}
    },
    send,
  }
  const ui = {
    bindPresentation: () => () => {},
    bindList: () => ({ refresh() {}, dispose() {} }),
  }
  const browser = Object.create(window) as Window & {
    hvirExtension: unknown
    hvirUI: unknown
  }
  browser.hvirExtension = bridge
  browser.hvirUI = ui
  browser.setTimeout = setTimeout
  browser.clearTimeout = clearTimeout
  const disposeListeners: (() => void)[] = []
  browser.addEventListener = ((name: string, listener: () => void) => {
    if (name === 'pagehide') disposeListeners.push(listener)
  }) as typeof window.addEventListener
  const bundle = buildSync({
    entryPoints: ['packages/skillager-extension/src/app.mjs'],
    bundle: true,
    format: 'iife',
    write: false,
  })
  runInNewContext(bundle.outputFiles[0]!.text, {
    window: browser,
    document,
    Date,
    performance,
    AbortController,
    TextEncoder,
    setTimeout,
    clearTimeout,
  })
  close = () => disposeListeners.forEach((listener) => listener())
  const context = (visible = true, workspace?: unknown) =>
    receive({ kind: 'context', context: { visible, workspace } })
  const button = (id: string) => document.getElementById(id) as HTMLButtonElement
  const flush = () => vi.advanceTimersByTimeAsync(1500)
  return {
    context,
    projectApproval: (approved: boolean) => {
      projectApproved = approved
    },
    libraryApproval: (approved: boolean) => {
      libraryApproved = approved
    },
    version: (value: string) => {
      version = value
    },
    capabilities: (capabilities: string[]) => receive({ kind: 'hello', capabilities }),
    requests,
    button,
    flush,
    calls,
    unapproved: () => {
      unapproved = true
    },
    fail: (command?: string) => {
      fail = true
      failOn = command
    },
    initializationRequests,
    opened,
    initialize: (result: unknown) => {
      initialization = result
    },
    searchPath: (path: string) => {
      occurrencePath = path
    },
    identities: (current: string, observed = current) => {
      identifier = current
      canonicalIdentifier = observed
    },
    uninitialized: () => {
      initialized = false
    },
    unsupported: () => {
      supported = false
    },
    empty: () => {
      count = 0
    },
    hold: () => {
      hold = true
    },
    frequency: () => {
      frequency = true
    },
    resume: () => resume?.(),
    connected: (value: unknown) => finishConnection?.(value),
    connectionFailed: () => finishConnection?.(undefined, 'Old connection failed'),
  }
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

it.each(['library', 'ssh', 'local'])(
  'defaults installed controls only for available exact local workspace (%s)',
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
    const installed = document.getElementById('include-installed') as HTMLInputElement
    expect(installed.checked).toBe(kind === 'local')
    expect(installed.disabled).toBe(kind !== 'local')
    if (kind !== 'local') expect(installed.title).toContain('unknown')
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

it('makes native approval refusal actionable while retaining last-known observations and exact search options', async () => {
  const f = packageView()
  f.context()
  await f.flush()
  const before = document.getElementById('skills')!.textContent
  f.unapproved()
  f.button('refresh').click()
  await f.flush()
  expect(document.getElementById('state')!.textContent).toContain(
    'choose Connect Skillager',
  )
  expect(document.getElementById('state')!.textContent).toContain(
    'Last-known rows retained',
  )
  expect(document.getElementById('state')!.textContent).not.toContain(
    'not-started: unapproved',
  )
  expect(document.getElementById('skills')!.textContent).toBe(before)
  expect(document.getElementById('installed-note')!.textContent).toContain(
    'Installed copies are unknown',
  )
  expect(
    (document.getElementById('include-installed') as HTMLInputElement).disabled,
  ).toBe(true)
  expect((document.getElementById('include-installed') as HTMLInputElement).checked).toBe(
    false,
  )
  const options = document.querySelector<HTMLDetailsElement>('.search-options')!
  expect(options.open).toBe(false)
  options.querySelector('summary')!.click()
  expect(options.open).toBe(true)
})

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
  expect(document.getElementById('state')!.textContent).toBe(
    'Program access was declined',
  )
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
})
it('connects the current project and automatically preserves exact query/options without library program approval', async () => {
  const f = packageView('project')
  f.projectApproval(false)
  f.libraryApproval(false)
  f.context(true, localProject)
  await f.flush()
  expect(f.button('connect-program').hidden).toBe(false)
  expect(document.getElementById('state')?.textContent).toContain('for this project')
  ;(document.getElementById('separate-copies') as HTMLInputElement).checked = true
  ;(document.getElementById('preferred-agent') as HTMLSelectElement).value = 'claude'
  submitQuery('exact query')
  await f.flush()
  f.button('connect-program').click()
  await f.flush()
  expect(f.requests.filter((r) => r.capability === 'connector.connect')).toEqual([
    { capability: 'connector.connect', input: { connector: 'project-cli' } },
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
  const search = commands.at(-1)!.input.args as string[]
  expect(search[0]).toBe('search')
  expect(search[1]).toBe('exact query')
  expect(search[search.indexOf('--installed-project') + 1]).toBe('/project-a')
  expect(search[search.indexOf('--view') + 1]).toBe('copies')
  expect(search[search.indexOf('--agent') + 1]).toBe('claude')
  expect(f.button('connect-program').hidden).toBe(true)
  expect(document.getElementById('state')?.dataset.state).toBe('ready')
  expect(f.initializationRequests).toEqual([])
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
      ;(document.getElementById('separate-copies') as HTMLInputElement).checked = true
      submitQuery('new query')
      await f.flush()
    }
    const before = f.calls.length
    f.connected(projectConnection())
    await f.flush()
    expect(f.calls.length).toBeGreaterThan(before)
    const command = f.requests.filter((r) => r.capability === 'connector.execute').at(-1)!
    const args = command.input.args as string[]
    expect(command.input.connector).toBe('project-cli')
    expect(args[1]).toBe(edge === 'timer' ? 'retained query' : 'new query')
    expect(args[args.indexOf('--view') + 1]).toBe(edge === 'timer' ? 'skills' : 'copies')
    expect(document.getElementById('state')?.dataset.state).toBe('ready')
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
    ).toContain('releases/tag/v0.9.5')
    if (outcome === 'interrupted-uncertain') {
      expect(document.getElementById('state')?.textContent).toContain(
        'may have been saved',
      )
      expect(document.getElementById('state')?.dataset.state).toBe('error')
    }
    expect(f.button('connect-program').disabled).toBe(false)
    expect(f.button('connect-program').hidden).toBe(false)
  },
)
it.each(['switch', 'roundtrip', 'root', 'hide'] as const)(
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
    if (edge === 'hide') {
      f.context(false, localProject)
      f.context(true, localProject)
    }
    await f.flush()
    const before = document.getElementById('state')?.textContent,
      calls = f.calls.length
    f.connectionFailed()
    await f.flush()
    expect(document.getElementById('state')?.textContent).toBe(before)
    expect(f.calls).toHaveLength(calls)
    f.button('connect-program').click()
    await f.flush()
    f.context(false, localProject)
    f.context(true, localProject)
    await f.flush()
    const resumed = f.calls.length
    f.connected(projectConnection())
    await f.flush()
    expect(f.calls).toHaveLength(resumed) // Retired result does not trigger refresh.
    await vi.advanceTimersByTimeAsync(31_000)
    expect(f.calls.length).toBeGreaterThan(resumed)
    expect(document.getElementById('state')?.dataset.state).toBe('ready')
    expect((document.getElementById('query') as HTMLInputElement).value).toBe(
      'kept query',
    )
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
  ).toContain('releases/tag/v0.9.5')
  expect(f.initializationRequests).toEqual([])
})

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
  expect(request).toContain(
    'https://github.com/jarmak-personal/skillager/releases/tag/v0.9.5',
  )
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
  f.context(false)
  expect(document.getElementById('state')?.dataset['state']).toBe('ready')
  expect(document.querySelectorAll('#skills [role="option"]')).toHaveLength(1)
  expect(f.button('manage').disabled).toBe(true)
  ;(document.querySelector('#skills [role="option"]') as HTMLButtonElement).click()
  await f.flush()
  expect(f.opened).toEqual([])
  f.context()
  await f.flush()
  expect(f.button('manage').disabled).toBe(false)
  ;(document.querySelector('#skills [role="option"]') as HTMLButtonElement).click()
  await f.flush()
  expect(f.opened).toHaveLength(1)
  expect(f.opened[0]).toMatchObject({
    contributionId: 'detail',
    context: 'application',
    input: { library: { id: 'library', root: '/library' } },
  })
})

it('qualifies library search selections from an SSH project through public application status without substituting the host', async () => {
  const f = packageView('project'),
    id = '720e24b1-53e0-45f6-a84e-3df65177b38c'
  f.identities(id)
  f.context(true, { id: 'ssh', host: 'ssh-host', name: 'Remote' })
  await f.flush()
  ;(document.getElementById('query') as HTMLInputElement).value = 'skill'
  document
    .getElementById('search-form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await f.flush()
  ;(document.querySelector('#skills [role="option"]') as HTMLButtonElement).click()
  await f.flush()
  expect(f.opened).toHaveLength(1)
  expect(f.opened[0]).toMatchObject({
    context: 'application',
    input: {
      library: { id, root: '/library' },
      row: { host: 'local', source: 'library' },
    },
  })
  expect(f.calls.some((args) => args[0] === 'library')).toBe(true)
  expect(f.calls.some((args) => args.includes('--installed-project'))).toBe(false)
})

async function searchedProjectLibrary() {
  const f = packageView('project'),
    id = '720e24b1-53e0-45f6-a84e-3df65177b38c'
  f.identities(id)
  f.context(true, { id: 'ssh', host: 'ssh-host', name: 'Remote' })
  await f.flush()
  ;(document.getElementById('query') as HTMLInputElement).value = 'skill'
  document
    .getElementById('search-form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await f.flush()
  return { ...f, id }
}
it('does not retarget a project search occurrence when the public library UUID changed', async () => {
  const f = await searchedProjectLibrary()
  f.identities('replacement', f.id)
  ;(document.querySelector('#skills [role="option"]') as HTMLButtonElement).click()
  await f.flush()
  expect(f.opened).toEqual([])
  expect(document.getElementById('state')?.textContent).toContain(
    'personal library changed',
  )
})
it.each(['hide', 'generation', 'new selection'] as const)(
  'does not open a project result from a stale explicit selection status reply after %s',
  async (edge) => {
    const f = await searchedProjectLibrary()
    f.hold()
    ;(document.querySelector('#skills [role="option"]') as HTMLButtonElement).click()
    await vi.advanceTimersByTimeAsync(100)
    if (edge === 'hide') f.context(false)
    if (edge === 'generation') f.button('browse').click()
    if (edge === 'new selection') {
      ;(document.querySelector('#skills [role="option"]') as HTMLButtonElement).click()
      await f.flush()
    }
    f.resume()
    await f.flush()
    expect(f.opened).toHaveLength(edge === 'new selection' ? 1 : 0)
    expect(f.calls.some((args) => args.includes('--installed-project'))).toBe(false)
  },
)
it('does not substitute a selected library occurrence outside the public reported root', async () => {
  const f = packageView('project'),
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
  ;(document.querySelector('#skills [role="option"]') as HTMLButtonElement).click()
  await f.flush()
  expect(f.opened).toEqual([])
  expect(document.getElementById('state')?.textContent).toContain(
    'Selected occurrence no longer belongs',
  )
})
