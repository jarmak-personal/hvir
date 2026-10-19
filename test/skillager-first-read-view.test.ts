import { connectorOutputFixture } from './fixtures/connector-output'
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
function fixture(
  options: {
    project?: boolean
    cadence?: boolean
    omitRoot?: boolean
    inline?: boolean
    holdSource?: 'source.select' | 'source.render'
    rendered?: string
    holdAsset?: number
    holdAssetRead?: boolean
  } = {},
) {
  vi.useFakeTimers()
  const template = document.createElement('template')
  template.innerHTML = readFileSync(
    `packages/skillager-extension/${options.inline ? 'library' : 'detail'}.html`,
    'utf8',
  )
  for (const node of template.content.querySelectorAll('script,link')) node.remove()
  document.body.replaceChildren(template.content.cloneNode(true))
  document.body.dataset['view'] = options.inline ? 'library' : 'detail'
  let receive!: (message: unknown) => void,
    decision: string | undefined,
    serial = 0,
    root = '/library',
    uuid = 'original',
    changeAfterBody = false,
    statusStarted = -Infinity,
    afterBody = false,
    collideAfterBody = false,
    bodyText = '# Current instruction',
    holdStatus = false,
    holdSource = options.holdSource,
    heldStatus: (() => void) | undefined,
    heldAsset: (() => void) | undefined,
    assetSerial = 0,
    receiptsRetired = false,
    holdAssetRead = options.holdAssetRead
  const native = connectorOutputFixture()
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
      if (message.capability === holdSource) {
        holdSource = undefined
        return
      }
      const input = message.input!
      if (
        receiptsRetired &&
        message.capability?.startsWith('source.') &&
        !input['release']
      ) {
        receive({
          kind: 'result',
          id: message.id,
          ok: false,
          error: 'Selected source access ended',
        })
        return
      }
      if (message.capability === 'connector.execute') {
        const command = (input['args'] as string[])[0]
        const version = command === '--version'
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
            : command === 'list'
              ? JSON.stringify({
                  schema: 'skillager.list.v1',
                  scope: 'library',
                  skills: [],
                  next_cursor: null,
                })
              : JSON.stringify({
                  schema: 'skillager.library-status.v1',
                  initialized: true,
                  library: { registration: 'valid', library_id: uuid, root },
                  counts: { skills: 1 },
                }),
        )
        const completed = () =>
          reply(
            message.id,
            native.complete(
              { outcome: 'completed', code: 0, receipt },
              outputs.get(receipt)!,
            ),
          )
        if (holdStatus && command === 'library') {
          holdStatus = false
          heldStatus = completed
        } else completed()
      } else if (message.capability === 'connector.output')
        reply(message.id, native.read(input))
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
        if (input['receipt'] === 'rendered') {
          reply(
            message.id,
            input['release'] ? null : { data: options.rendered, nextOffset: null },
          )
          return
        }
        if (String(input['receipt']).startsWith('asset-')) {
          const completed = () =>
            reply(
              message.id,
              input['release'] ? null : { data: 'AQID', nextOffset: null },
            )
          if (!input['release'] && holdAssetRead) {
            holdAssetRead = false
            heldAsset = completed
          } else completed()
          return
        }
        if (!input['release']) afterBody = true
        if (changeAfterBody && !input['release']) uuid = 'replacement'
        reply(message.id, input['release'] ? null : { data: bodyText, nextOffset: null })
      } else if (message.capability === 'source.render')
        reply(
          message.id,
          options.rendered
            ? { receipt: 'rendered', sourceFallback: false }
            : { sourceFallback: true },
        )
      else if (message.capability === 'source.asset') {
        const receipt = `asset-${++assetSerial}`
        const completed = () => reply(message.id, { receipt, mime: 'image/png' })
        if (options.holdAsset === assetSerial) heldAsset = completed
        else completed()
      } else reply(message.id, null)
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
      hvirUI: {
        bindPresentation: () => () => {},
        bindList: () => ({ refresh() {}, dispose() {} }),
      },
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
        ...(options.project
          ? {
              workspace: {
                id: 'project',
                host: 'local',
                root: { hostId: 'local', path: '/library' },
              },
            }
          : {}),
        input: {
          selection,
          row: {
            source: options.project ? 'project' : 'library',
            ...(options.project ? { workspaceId: 'project' } : {}),
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
    receive: (message: unknown) => receive(message),
    resumeAsset: () => heldAsset?.(),
    retireReceipts: () => {
      receiptsRetired = true
    },
    replaceBody: () => {
      bodyText = '# Changed on disk'
    },
    holdStatus: () => {
      holdStatus = true
    },
    resumeStatus: () => heldStatus?.(),
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
  expect(document.getElementById('reader-state')?.dataset['state']).toBe('unapproved')
  expect(document.getElementById('instructions')?.textContent).toBe('')
  f.read()
  await f.flush()
  f.decide(true)
  await f.flush()
  expect(document.getElementById('instructions')?.textContent).toBe(
    '# Current instruction',
  )
})

it.each(['source.select', 'source.render'] as const)(
  'leaves the waiting state after a correlated %s deadline and ignores late completion',
  async (capability) => {
    const f = fixture({ holdSource: capability })
    f.context()
    await f.flush()
    f.decide(true)
    await f.flush()
    const pending = f.sent.find((entry) => entry.capability === capability)!
    expect(pending).toBeDefined()
    expect(document.getElementById('reader-state')?.dataset['state']).toBe('loading')
    f.receive({
      kind: 'result',
      id: pending.id,
      ok: false,
      error:
        'Extension request timed out; completion was not confirmed. Check the outcome before retrying.',
    })
    await f.flush()
    expect(document.getElementById('reader-state')?.dataset['state']).toBe(
      capability === 'source.select' ? 'error' : 'stale',
    )
    expect(document.getElementById('reader-state')?.textContent).toContain('timed out')
    const expectedBody = capability === 'source.select' ? '' : '# Current instruction'
    expect(document.getElementById('instructions')?.textContent).toBe(expectedBody)
    if (capability === 'source.render')
      expect(document.getElementById('instructions')?.dataset['mode']).toBe('source')
    f.receive({
      kind: 'result',
      id: pending.id,
      ok: true,
      value: { receipt: 'late-source' },
    })
    await f.flush()
    expect(document.getElementById('instructions')?.textContent).toBe(expectedBody)
    expect(document.getElementById('reader-state')?.textContent).toContain('timed out')
    expect(f.sent.filter((entry) => entry.capability === capability)).toHaveLength(1)
    f.read()
    await f.flush()
    expect(f.sent.filter((entry) => entry.capability === 'source.request')).toHaveLength(
      2,
    )
    f.decide(true)
    await f.flush()
    expect(document.getElementById('instructions')?.textContent).toBe(
      '# Current instruction',
    )
    expect(document.getElementById('reader-state')?.textContent).not.toContain(
      'timed out',
    )
  },
)
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
  expect(document.getElementById('reader-state')?.textContent).toContain(
    'freshness unavailable',
  )
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
  expect(document.getElementById('reader-state')?.textContent).toContain(
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
  expect((document.getElementById('reader-manage') as HTMLButtonElement).disabled).toBe(
    true,
  )
  expect(document.getElementById('instructions')?.textContent).toBe('')
  f.context('one', true)
  await f.flush()
  expect((document.getElementById('reader-manage') as HTMLButtonElement).disabled).toBe(
    false,
  )
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
  expect(document.getElementById('reader-state')?.textContent).toContain(
    'personal library changed',
  )
  expect(document.getElementById('instructions')?.textContent).toBe('')
})

it('keeps an inline selected read current across an unrelated catalog refresh', async () => {
  const f = fixture({ inline: true })
  f.context()
  await f.flush()
  f.holdStatus()
  f.decide(true)
  await f.flush()
  expect(f.sent.some((entry) => entry.capability === 'source.select')).toBe(false)
  document.getElementById('refresh')!.click()
  await f.flush()
  f.resumeStatus()
  await f.flush()
  expect(document.getElementById('instructions')?.textContent).toBe(
    '# Current instruction',
  )
  expect(document.getElementById('reader-state')?.textContent).not.toContain(
    'no longer current',
  )
})

const illustrated =
  '<p>Current instructions</p><p><span data-instruction-image="owned.png">Owned image</span></p>'
function mode(name: 'source' | 'rendered') {
  document.getElementById(`${name}-mode`)!.click()
}
it('retains decoded image nodes across modes, hidden receipt retirement and expiry without new reads', async () => {
  const f = fixture({ rendered: illustrated })
  f.context()
  await f.flush()
  f.decide(true)
  await f.flush()
  const image = document.querySelector('#instructions img')!
  expect(image?.getAttribute('src')).toBe('data:image/png;base64,AQID')
  document.getElementById('instructions')!.scrollTop = 140
  const reads = f.sent.filter((entry) => entry.capability?.startsWith('source.')).length
  f.replaceBody()
  f.retireReceipts()
  mode('source')
  f.context('one', false)
  await f.flush()
  f.context('one', true)
  await vi.advanceTimersByTimeAsync(300_001)
  for (let index = 0; index < 3; index++) {
    mode('rendered')
    await f.flush()
    expect(document.querySelector('#instructions img')).toBe(image)
    expect(document.getElementById('instructions')!.scrollTop).toBe(140)
    mode('source')
  }
  expect(document.getElementById('instructions')?.textContent).toBe(
    '# Current instruction',
  )
  expect(f.sent.filter((entry) => entry.capability?.startsWith('source.'))).toHaveLength(
    reads,
  )
})

it('retains the existing eight-image display bound across repeated representation changes', async () => {
  const f = fixture({
    rendered: Array.from(
      { length: 10 },
      (_, index) =>
        `<p><span data-instruction-image="${index}.png">Image ${index}</span></p>`,
    ).join(''),
  })
  f.context()
  await f.flush()
  f.decide(true)
  await f.flush()
  mode('source')
  mode('rendered')
  await f.flush()
  expect(document.querySelectorAll('#instructions img')).toHaveLength(8)
  expect(f.sent.filter((entry) => entry.capability === 'source.asset')).toHaveLength(8)
  expect(
    document.querySelectorAll('#instructions [data-instruction-image]'),
  ).toHaveLength(2)
  expect(document.getElementById('instructions')?.textContent).toContain(
    'eight-image display limit',
  )
})

it('reports an image read deadline without blaming source confinement and permits an explicit current read', async () => {
  const f = fixture({ rendered: illustrated, holdAssetRead: true })
  f.context()
  await f.flush()
  f.decide(true)
  await f.flush()
  const pending = f.sent.find(
    (entry) =>
      entry.capability === 'source.read' && entry.input?.['receipt'] === 'asset-1',
  )!
  f.receive({ kind: 'result', id: pending.id, ok: false, error: 'Image read timed out' })
  await f.flush()
  expect(document.getElementById('instructions')?.textContent).toContain(
    'Image read timed out',
  )
  expect(document.getElementById('instructions')?.textContent).not.toContain(
    'outside the selected source',
  )
  f.resumeAsset()
  await f.flush()
  expect(document.querySelector('#instructions img')).toBeNull()
  f.read()
  await f.flush()
  f.decide(true)
  await f.flush()
  expect(document.querySelectorAll('#instructions img')).toHaveLength(1)
})

it('finishes an admitted image into the retained document through quick mode changes', async () => {
  const f = fixture({ rendered: illustrated, holdAssetRead: true })
  f.context()
  await f.flush()
  f.decide(true)
  await f.flush()
  mode('source')
  mode('rendered')
  mode('source')
  f.resumeAsset()
  await f.flush()
  expect(document.getElementById('instructions')?.textContent).toBe(
    '# Current instruction',
  )
  mode('rendered')
  await f.flush()
  expect(document.querySelectorAll('#instructions img')).toHaveLength(1)
  expect(f.sent.filter((entry) => entry.capability === 'source.asset')).toHaveLength(1)
  expect(f.sent.filter((entry) => entry.capability === 'source.render')).toHaveLength(1)
})

it('preserves completed images and labels an interrupted remainder without reusing hidden receipts', async () => {
  const f = fixture({
    rendered:
      illustrated +
      '<p><span data-instruction-image="second.png">Second image</span></p>',
    holdAsset: 2,
  })
  f.context()
  await f.flush()
  f.decide(true)
  await f.flush()
  const image = document.querySelector('#instructions img')!
  const pending = f.sent.filter((entry) => entry.capability === 'source.asset')[1]!
  expect(image).toBeTruthy()
  f.context('one', false)
  await f.flush()
  expect(f.sent).toContainEqual({ kind: 'cancel', id: pending.id })
  f.resumeAsset()
  f.context('one', true)
  mode('source')
  mode('rendered')
  await f.flush()
  expect(document.querySelector('#instructions img')).toBe(image)
  expect(document.getElementById('instructions')?.textContent).toContain(
    'image reading interrupted',
  )
  expect(document.getElementById('instructions')?.textContent).not.toContain(
    'outside the selected source',
  )
  expect(f.sent.filter((entry) => entry.capability === 'source.asset')).toHaveLength(2)
  f.read()
  await f.flush()
  f.decide(true)
  await f.flush()
  expect(document.querySelectorAll('#instructions img')).toHaveLength(2)
  expect(document.getElementById('instructions')?.textContent).not.toContain(
    'interrupted',
  )
})

it.each(['selection', 'close', 'dispose'] as const)(
  'retires unfinished detached images on %s without publishing late bytes',
  async (ending) => {
    const f = fixture({ rendered: illustrated, holdAssetRead: true })
    f.context()
    await f.flush()
    f.decide(true)
    await f.flush()
    mode('source')
    const pending = f.sent.find(
      (entry) =>
        entry.capability === 'source.read' && entry.input?.['receipt'] === 'asset-1',
    )!
    if (ending === 'selection') f.context('two')
    else if (ending === 'close') document.getElementById('close-instructions')!.click()
    else stop()
    await f.flush()
    expect(f.sent).toContainEqual({ kind: 'cancel', id: pending.id })
    f.resumeAsset()
    await f.flush()
    expect(document.getElementById('instructions')?.textContent).toBe('')
    expect(document.querySelector('#instructions img')).toBeNull()
    if (ending === 'selection') {
      f.decide(true)
      await f.flush()
      mode('rendered')
      await f.flush()
      expect(document.querySelectorAll('#instructions img')).toHaveLength(1)
    }
  },
)

it('shares pending rendering through rapid toggles and keeps the same image pass', async () => {
  const f = fixture({ rendered: illustrated, holdSource: 'source.render' })
  f.context()
  await f.flush()
  f.decide(true)
  await f.flush()
  const pending = f.sent.find((entry) => entry.capability === 'source.render')!
  mode('source')
  mode('rendered')
  mode('rendered')
  f.receive({
    kind: 'result',
    id: pending.id,
    ok: true,
    value: { receipt: 'rendered', sourceFallback: false },
  })
  await f.flush()
  expect(document.querySelectorAll('#instructions img')).toHaveLength(1)
  expect(f.sent.filter((entry) => entry.capability === 'source.render')).toHaveLength(1)
  expect(f.sent.filter((entry) => entry.capability === 'source.asset')).toHaveLength(1)
})

it.each([true, false])(
  'ends loading when complete Source is chosen during rendering while preserving later fallback messages (%s)',
  async (success) => {
    const f = fixture({ rendered: illustrated, holdSource: 'source.render' })
    f.context()
    await f.flush()
    f.decide(true)
    await f.flush()
    const pending = f.sent.find((entry) => entry.capability === 'source.render')!
    expect(document.getElementById('reader-state')?.dataset['state']).toBe('loading')
    mode('source')
    expect(document.getElementById('instructions')?.textContent).toBe(
      '# Current instruction',
    )
    expect(document.getElementById('reader-state')?.dataset['state']).toBe('ready')
    f.receive(
      success
        ? {
            kind: 'result',
            id: pending.id,
            ok: true,
            value: { receipt: 'rendered', sourceFallback: false },
          }
        : { kind: 'result', id: pending.id, ok: false, error: 'Rendering timed out' },
    )
    await f.flush()
    expect(document.getElementById('instructions')?.dataset['mode']).toBe('source')
    expect(document.getElementById('reader-state')?.dataset['state']).toBe(
      success ? 'ready' : 'stale',
    )
    if (!success)
      expect(document.getElementById('reader-state')?.textContent).toContain(
        'Rendering timed out',
      )
  },
)

it('requests a project read using only its declared source, then selects the exact project occurrence', async () => {
  const f = fixture({ project: true })
  f.context()
  await f.flush()
  expect(f.sent.find((entry) => entry.capability === 'source.request')?.input).toEqual({
    source: 'project',
  })
  expect(f.sent.some((entry) => entry.capability === 'source.select')).toBe(false)
  f.decide(true)
  await f.flush()
  expect(f.sent.find((entry) => entry.capability === 'source.select')?.input).toEqual({
    source: 'project',
    path: { hostId: 'local', path: '/library/skill/SKILL.md' },
    workspaceId: 'project',
  })
  expect(document.getElementById('instructions')?.textContent).toBe(
    '# Current instruction',
  )
})
