// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { buildSync } from 'esbuild'
import { afterEach, expect, it, vi } from 'vitest'
let stop: () => void
afterEach(() => {
  stop?.()
  document.body.replaceChildren()
  vi.useRealTimers()
})
function fixture(options: { cadence?: boolean; omitRoot?: boolean } = {}) {
  vi.useFakeTimers()
  const template = document.createElement('template')
  template.innerHTML = readFileSync('packages/skillager-extension/detail.html', 'utf8')
  for (const node of template.content.querySelectorAll('script,link')) node.remove()
  document.body.replaceChildren(template.content.cloneNode(true))
  document.body.dataset['view'] = 'detail'
  let receive!: (message: unknown) => void,
    decision: string | undefined,
    serial = 0,
    root = '/library',
    uuid = 'original',
    changeAfterBody = false,
    statusStarted = -Infinity,
    afterBody = false,
    collideAfterBody = false,
    bodyText = '# Current instruction'
  const statusStarts: number[] = []
  const sent: {
      id: string
      kind: string
      capability?: string
      input?: Record<string, unknown>
    }[] = [],
    outputs = new Map<string, string>()
  const reply = (id: string, value: unknown) =>
    receive({ kind: 'result', id, ok: true, value })
  const bridge = {
    onMessage: (callback: typeof receive) => {
      receive = callback
      return () => {}
    },
    send: (message: (typeof sent)[number]) => {
      sent.push(message)
      if (message.kind !== 'request') return
      const input = message.input!
      if (message.capability === 'connector.execute') {
        const version = (input['args'] as string[])[0] === '--version'
        if (
          !version &&
          ((options.cadence && Date.now() - statusStarted < 1000) ||
            (collideAfterBody && afterBody))
        ) {
          reply(message.id, { outcome: 'not-started', reason: 'frequency' })
          return
        }
        if (!version) {
          statusStarted = Date.now()
          statusStarts.push(statusStarted)
        }
        const receipt = String(++serial)
        outputs.set(
          receipt,
          version
            ? 'skillager 0.9.3'
            : JSON.stringify({
                schema: 'skillager.library-status.v1',
                initialized: true,
                library: { registration: 'valid', library_id: uuid, root },
                counts: { skills: 1 },
              }),
        )
        reply(message.id, { outcome: 'completed', code: 0, receipt })
      } else if (message.capability === 'connector.output')
        reply(
          message.id,
          input['release']
            ? null
            : {
                data:
                  input['stream'] === 'stderr'
                    ? ''
                    : outputs.get(String(input['receipt'])),
                nextOffset: null,
              },
        )
      else if (message.capability === 'source.request') {
        decision = message.id
        afterBody = false
      } else if (message.capability === 'source.select')
        reply(message.id, {
          receipt: 'selected',
          path: { hostId: 'local', path: '/library/skill/SKILL.md' },
          sha256: 'a'.repeat(64),
          readAt: 0,
        })
      else if (message.capability === 'source.read') {
        if (!input['release']) afterBody = true
        if (changeAfterBody && !input['release']) uuid = 'replacement'
        reply(message.id, input['release'] ? null : { data: bodyText, nextOffset: null })
      } else if (message.capability === 'source.render')
        reply(message.id, { sourceFallback: true })
      else reply(message.id, null)
    },
  }
  const callbacks: (() => void)[] = []
  const bundle = buildSync({
    entryPoints: ['packages/skillager-extension/src/app.mjs'],
    bundle: true,
    format: 'iife',
    write: false,
  })
  runInNewContext(bundle.outputFiles[0]!.text, {
    document,
    window: {
      hvirExtension: bridge,
      hvirUI: { bindPresentation: () => () => {} },
      addEventListener: (_: string, callback: () => void) => callbacks.push(callback),
      setTimeout,
      clearTimeout,
    },
    Date,
    performance,
    AbortController,
    TextEncoder,
    setTimeout,
    clearTimeout,
  })
  stop = () => callbacks.forEach((callback) => callback())
  const context = (selection = 'one', visible = true) =>
    receive({
      kind: 'context',
      context: {
        visible,
        input: {
          selection,
          row: {
            source: 'library',
            host: 'local',
            path: '/library/skill/SKILL.md',
            name: 'Skill',
            kind: 'Your library',
            status: 'pending',
          },
          library: { id: 'original', ...(options.omitRoot ? {} : { root: '/library' }) },
        },
      },
    })
  return {
    sent,
    statusStarts,
    context,
    flush: () => vi.advanceTimersByTimeAsync(2500),
    change: (newRoot: string, id = 'original') => {
      root = newRoot
      uuid = id
    },
    changeAfterBody: () => {
      changeAfterBody = true
    },
    decide: (granted: boolean) => reply(decision!, { granted }),
    read: () => document.getElementById('read-current')!.click(),
    collideOnNextBody: () => {
      collideAfterBody = true
      bodyText = '# Replacement bytes'
    },
  }
}
it('asks only after explicit selected metadata, using reported host-qualified root, and leaves decline without bytes', async () => {
  const f = fixture()
  await f.flush()
  expect(f.sent.some((entry) => entry.capability === 'source.request')).toBe(false)
  f.context()
  await f.flush()
  expect(f.sent.find((entry) => entry.capability === 'source.request')?.input).toEqual({
    source: 'library',
    root: { hostId: 'local', path: '/library' },
  })
  expect(f.sent.some((entry) => entry.capability === 'source.select')).toBe(false)
  f.decide(false)
  await f.flush()
  expect(document.getElementById('state')?.dataset['state']).toBe('unapproved')
  expect(document.getElementById('instructions')?.textContent).toBe('')
  f.read()
  await f.flush()
  f.decide(true)
  await f.flush()
  expect(document.getElementById('instructions')?.textContent).toBe(
    '# Current instruction',
  )
})
it('uses selected metadata only as a proposal and obtains two fresh observations with one cadence deferral', async () => {
  const f = fixture({ cadence: true })
  f.context()
  await f.flush()
  expect(f.statusStarts).toEqual([])
  expect(f.sent.some((entry) => entry.capability === 'source.select')).toBe(false)
  f.decide(true)
  await f.flush()
  expect(f.statusStarts).toHaveLength(2)
  expect(f.statusStarts[1]! - f.statusStarts[0]!).toBe(1100)
  expect(document.getElementById('instructions')?.textContent).toBe(
    '# Current instruction',
  )
})
it('resolves an omitted bounded input root before proposing access', async () => {
  const f = fixture({ omitRoot: true })
  f.context()
  await f.flush()
  expect(f.statusStarts).toHaveLength(1)
  expect(f.sent.find((entry) => entry.capability === 'source.request')?.input).toEqual({
    source: 'library',
    root: { hostId: 'local', path: '/library' },
  })
  f.decide(true)
  await f.flush()
  expect(f.statusStarts).toHaveLength(3)
  expect(document.getElementById('instructions')?.textContent).toBe(
    '# Current instruction',
  )
})
it('retains last-read bytes when sibling observation cadence makes post-read freshness unavailable', async () => {
  const f = fixture()
  f.context()
  await f.flush()
  f.decide(true)
  await f.flush()
  expect(document.getElementById('instructions')?.textContent).toBe(
    '# Current instruction',
  )
  f.collideOnNextBody()
  f.read()
  await f.flush()
  f.decide(true)
  await f.flush()
  expect(document.getElementById('state')?.textContent).toContain('freshness unavailable')
  expect(document.getElementById('instructions')?.textContent).toBe(
    '# Current instruction',
  )
  expect(document.getElementById('instructions')?.textContent).not.toContain(
    'Replacement',
  )
  expect(
    f.sent.filter(
      (entry) =>
        entry.capability === 'connector.execute' &&
        (entry.input?.['args'] as string[])[0] === 'library',
    ),
  ).toHaveLength(5) // Two initial successes, new pre-read success, one refusal + one retry.
})
it.each([
  ['/another', 'original'],
  ['/library', 'replacement'],
])('rejects changed current root/UUID after decision (%s, %s)', async (root, id) => {
  const f = fixture()
  f.context()
  await f.flush()
  f.change(root, id)
  f.decide(true)
  await f.flush()
  expect(document.getElementById('state')?.textContent).toContain(
    'personal library changed',
  )
  expect(f.sent.some((entry) => entry.capability === 'source.select')).toBe(false)
  expect(document.getElementById('instructions')?.textContent).toBe('')
})
it('retires the old decision on a new selection and does not consume a late success', async () => {
  const f = fixture()
  f.context()
  await f.flush()
  const first = f.sent.find((entry) => entry.capability === 'source.request')!
  f.context('two')
  f.decide(true)
  await f.flush()
  expect(f.sent).toContainEqual({ kind: 'cancel', id: first.id })
  expect(f.sent.filter((entry) => entry.capability === 'source.request')).toHaveLength(2)
  expect(f.sent.some((entry) => entry.capability === 'source.select')).toBe(false)
  f.context('two', false)
  await f.flush()
  expect(document.getElementById('instructions')?.textContent).toBe('')
})

it('requires restored public visibility before an explicit retry after hiding', async () => {
  const f = fixture()
  f.context()
  await f.flush()
  const first = f.sent.find((entry) => entry.capability === 'source.request')!
  f.context('one', false)
  await f.flush()
  expect(f.sent).toContainEqual({ kind: 'cancel', id: first.id })
  expect((document.getElementById('manage') as HTMLButtonElement).disabled).toBe(true)
  expect(document.getElementById('instructions')?.textContent).toBe('')
  f.context('one', true)
  await f.flush()
  expect((document.getElementById('manage') as HTMLButtonElement).disabled).toBe(false)
  expect(f.sent.filter((entry) => entry.capability === 'source.request')).toHaveLength(1)
  f.read()
  await f.flush()
  expect(f.sent.filter((entry) => entry.capability === 'source.request')).toHaveLength(2)
  f.decide(false)
  await f.flush()
  expect(document.getElementById('instructions')?.textContent).toBe('')
})

it('does not publish body bytes if public library identity changes while the selected read settles', async () => {
  const f = fixture()
  f.context()
  await f.flush()
  f.changeAfterBody()
  f.decide(true)
  await f.flush()
  expect(f.sent.some((entry) => entry.capability === 'source.select')).toBe(true)
  expect(document.getElementById('state')?.textContent).toContain(
    'personal library changed',
  )
  expect(document.getElementById('instructions')?.textContent).toBe('')
})
