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
function packageView(view = 'library', entry = 'app') {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  document.body.innerHTML = readFileSync(
    `packages/skillager-extension/${view}.html`,
    'utf8',
  )
    .replace(/<script[\s\S]*?<\/script>/gu, '')
    .replace(/<link[^>]*>/gu, '')
  document.body.dataset.view = view
  let receive!: (message: unknown) => void
  const publications: Record<string, unknown>[] = []
  const calls: string[][] = [],
    outputs = new Map<string, string>()
  let serial = 0,
    fail = false,
    hold = false,
    frequency = false,
    resume: (() => void) | undefined
  const send = (message: {
    kind: string
    id: string
    capability: string
    input: Record<string, unknown>
  }) => {
    if (message.kind !== 'request') return
    let value: unknown
    if (message.capability === 'connector.execute') {
      const args = message.input.args as string[]
      calls.push(args)
      if (frequency) {
        frequency = false
        value = { outcome: 'not-started', reason: 'frequency' }
      } else if (fail) {
        fail = false
        value = { outcome: 'failed', code: 1 }
      } else {
        const receipt = String(++serial),
          cursor = args[args.indexOf('--cursor') + 1]
        const index = args.includes('--cursor') && cursor ? Number(cursor) : 0
        const text =
          args[0] === '--version'
            ? 'skillager 0.9.3'
            : JSON.stringify(
                args[0] === 'library'
                  ? {
                      schema: 'skillager.library-status.v1',
                      initialized: true,
                      library: {
                        registration: 'valid',
                        library_id: 'library',
                        root: '/library',
                      },
                      counts: { skills: 3 },
                    }
                  : args[0] === 'search'
                    ? {
                        schema: 'skillager.search.v1',
                        status: 'completed',
                        results: [
                          {
                            id: 'lib/search',
                            search: {
                              occurrence: {
                                id: `search-${index}`,
                                kind: 'library',
                                entrypoint: '/library/search/SKILL.md',
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
                            skills: [
                              {
                                id: `lib/${index}`,
                                name: `Page ${index}`,
                                description: '',
                                status: 'pending',
                                skill_file: `/library/${index}/SKILL.md`,
                              },
                            ],
                            next_cursor: index < 2 ? String(index + 1) : null,
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
      if (message.capability === 'contributions.publish') publications.push(message.input)
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
    entryPoints: [`packages/skillager-extension/src/${entry}.mjs`],
    bundle: true,
    format: 'iife',
    write: false,
  })
  runInNewContext(bundle.outputFiles[0]!.text, {
    window: browser,
    document,
    Date,
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
    button,
    flush,
    calls,
    publications,
    fail: () => {
      fail = true
    },
    hold: () => {
      hold = true
    },
    frequency: () => {
      frequency = true
    },
    resume: () => resume?.(),
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
  f.fail()
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
  f.fail()
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

it('updater reads only needed status metadata and publishes last-known freshness honestly after refusal', async () => {
  const f = packageView('library', 'updater')
  f.context()
  await f.flush()
  expect(f.calls.map((args) => args[0])).toEqual(['--version', 'library'])
  expect(f.publications.at(-1)).toMatchObject({
    label: 'Skills 3',
    availability: 'current',
  })
  const observedAt = f.publications.at(-1)!.observedAt
  f.fail()
  f.context()
  await f.flush()
  expect(f.publications.at(-1)).toMatchObject({
    label: 'Skills 3',
    availability: 'stale',
    observedAt,
  })
  expect(f.calls.some((args) => args[0] === 'list')).toBe(false)
})
