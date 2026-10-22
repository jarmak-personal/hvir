import { connectorOutputFixture } from './fixtures/connector-output'
// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { buildSync } from 'esbuild'
import { afterEach, expect, it, vi } from 'vitest'

type Value = Record<string, unknown>
interface AdvancedPlan extends Value {
  library_id: string
  project: string
  request: { origin_id: string }
  sources: Array<{ id: string; root: string }>
}
let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  document.body.replaceChildren()
})
function fixture(
  cryptoPort: unknown = webcrypto,
  initialize?: () => Promise<Value>,
  initialObservation = false,
) {
  const template = document.createElement('template')
  template.innerHTML = readFileSync(
    'packages/skillager-extension/management.html',
    'utf8',
  )
  for (const node of template.content.querySelectorAll('script, link')) node.remove()
  document.body.replaceChildren(template.content.cloneNode(true))
  const preview = JSON.parse(
    readFileSync(
      'test/fixtures/skillager-management/codex-mode-initial-preview.json',
      'utf8',
    ),
  ) as Array<{
    agent: string
    target: string
    exposure_id: string
    scope: string
    preview: {
      source: {
        id: string
        root: string
        content_hash: string
        source: { library_id: string; library_root: string }
      }
    }
  }>
  const selected = preview[0]!.preview.source
  const update = JSON.parse(
    readFileSync(
      'test/fixtures/skillager-management/codex-exact-mode-update-preview.json',
      'utf8',
    ),
  ) as unknown
  const removal = JSON.parse(
    readFileSync(
      'test/fixtures/skillager-management/codex-mode-remove-preview.json',
      'utf8',
    ),
  ) as unknown
  const status = JSON.parse(
    readFileSync('test/fixtures/skillager-management/first-no-git-status.json', 'utf8'),
  ) as { library: Value; skill: Value }
  status.library['library_id'] = selected.source.library_id
  status.library['root'] = selected.source.library_root
  Object.assign(status.skill, {
    id: selected.id,
    path: selected.root,
    working_hash: selected.content_hash,
    accepted_hash: selected.content_hash,
    acceptance: 'accepted',
  })
  const syncPlan = {
    schema: 'skillager.library-sync-status.v1',
    library: {
      library_id: selected.source.library_id,
      root: selected.source.library_root,
      git_mode: 'disabled',
    },
    context: {
      project_root: '/owned-fixture/mode-change-codex',
      discovery: 'effective-local',
    },
    coverage: {
      complete: true,
      discovered_origins: 1,
      approved_origins: 1,
      selected_sources: 1,
      processed_sources: 1,
      discovery_error_count: 0,
    },
    lineages: [] as Value[],
    candidates: [
      {
        source_identity: 'owned-source',
        canonical_skill_id: 'lib/owned',
        state: 'eligible-create',
        reason_code: null,
      },
    ],
  }
  const rawAdvanced = JSON.parse(
    readFileSync(
      'test/fixtures/skillager-management/advanced-adoption-preview.json',
      'utf8',
    ),
  ) as AdvancedPlan
  const advanced = JSON.parse(
    JSON.stringify(rawAdvanced)
      .replaceAll(rawAdvanced.library_id, selected.source.library_id)
      .replaceAll('/owned-fixture/advanced/library', selected.source.library_root)
      .replaceAll(rawAdvanced.project, '/owned-fixture/mode-change-codex'),
  ) as AdvancedPlan
  let holdAdvanced = false,
    settleAdvanced: (() => void) | undefined
  const listeners = new Set<(message: unknown) => void>(),
    controller = new AbortController(),
    outputs = new Map<string, unknown>()
  const actions: Array<{ action: string; input: Value }> = []
  const views: Value[] = []
  let serial = 0
  let readCount = 0
  let holdObservation: 'next' | 'skill' | undefined = initialObservation
    ? 'next'
    : undefined
  let resolveObservation: (() => void) | undefined
  let rejectObservation: ((reason: Error) => void) | undefined
  let holdNavigation = false
  let rejectNavigation: ((reason: Error) => void) | undefined
  let protectedTarget = false
  const native = connectorOutputFixture()
  const client = {
    alive: true,
    signal: controller.signal,
    listen(callback: (message: unknown) => void) {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
    request(capability: string, input: Value) {
      if (capability === 'viewer.open-own') {
        views.push(input)
        if (holdNavigation)
          return new Promise((_resolve, reject) => {
            rejectNavigation = reject
          })
        return Promise.resolve({ outcome: 'opened' })
      }
      if (capability === 'actions.invoke') {
        actions.push(input as { action: string; input: Value })
        if (input['action'] === 'initialize-library' && initialize) return initialize()
        return Promise.resolve({ outcome: 'verified' })
      }
      if (capability === 'connector.output') return Promise.resolve(native.read(input))
      readCount++
      const args = input['args'] as string[],
        receipt = String(++serial)
      outputs.set(
        receipt,
        args.includes('sync')
          ? syncPlan
          : args.includes('--list')
            ? { schema: 'skillager.exposures.v1', exposures: preview }
            : args.includes('--request-json')
              ? advanced
              : args.includes('expose')
                ? protectedTarget
                  ? [
                      {
                        schema: 'skillager.exposure-result.v1',
                        status: 'skipped',
                        reason: 'target has local edits',
                      },
                    ]
                  : args.includes('--remove')
                    ? removal
                    : update
                : status,
      )
      const completed = () =>
        native.complete(
          { outcome: 'completed', code: 0, receipt, truncated: false },
          JSON.stringify(outputs.get(receipt)),
        )
      if (
        holdObservation === 'next' ||
        (holdObservation === 'skill' &&
          args[0] === 'library' &&
          args[1] === 'status' &&
          args[2] !== '--json')
      ) {
        holdObservation = undefined
        return new Promise((resolve, reject) => {
          resolveObservation = () => resolve(completed())
          rejectObservation = reject
        })
      }
      if (args.includes('--request-json') && holdAdvanced)
        return new Promise((resolve) => {
          settleAdvanced = () => resolve(completed())
        })
      return Promise.resolve(completed())
    },
  }
  const bundle = buildSync({
    entryPoints: ['packages/skillager-extension/src/management-view.mjs'],
    bundle: true,
    format: 'iife',
    globalName: 'Module',
    write: false,
  })
  const sandbox = { TextEncoder, crypto: cryptoPort, Module: undefined as unknown }
  runInNewContext(bundle.outputFiles[0]!.text, sandbox)
  const module = sandbox.Module as {
    bindManagementView(document: Document, client: unknown): { dispose(): void }
  }
  const view = module.bindManagementView(document, client)
  dispose = () => {
    view.dispose()
    controller.abort()
  }
  const row = (id: string) => {
    for (const listener of listeners)
      listener({
        kind: 'context',
        context: {
          visible: true,
          workspace: {
            id: 'exact-workspace',
            host: 'local',
            root: { hostId: 'local', path: '/owned-fixture/mode-change-codex' },
          },
          input: { row: { source: 'library', id } },
        },
      })
  }
  row(selected.id)
  const click = (id: string) => (document.getElementById(id) as HTMLButtonElement).click()
  const ready = async (message: RegExp) =>
    vi.waitFor(() =>
      expect(document.getElementById('state')!.textContent).toMatch(message),
    )
  const connect = async () => {
    await vi.waitFor(() =>
      expect(document.querySelector('main')?.getAttribute('aria-busy')).toBe('false'),
    )
  }
  return {
    click,
    ready,
    connect,
    actions,
    views,
    holdObservation: (kind: 'next' | 'skill' = 'next') => {
      holdObservation = kind
    },
    get observationWaiting() {
      return !!resolveObservation
    },
    resolveObservation: () => {
      const resolve = resolveObservation!
      resolveObservation = undefined
      resolve()
    },
    rejectObservation: () => rejectObservation!(new Error('Retired observation failed')),
    holdNavigation: () => {
      holdNavigation = true
    },
    rejectNavigation: () => rejectNavigation!(new Error('Late navigation failed')),
    setAcceptance: (value: string) => {
      status.skill['acceptance'] = value
    },
    selectCurrent: (id: string) => {
      status.skill['id'] = id
      row(id)
    },
    changeLibrary: () => {
      status.library['library_id'] = '96600000-0000-4000-8000-000000000001'
    },
    advanced: () => {
      syncPlan.lineages = [
        {
          canonical: {
            library_id: selected.source.library_id,
            skill_id: advanced.sources[0]!.id,
            path: advanced.sources[0]!.root,
          },
          preservation: 'verified',
          origins: [
            {
              origin_id: advanced.request.origin_id,
              path: advanced.project + '/.agents/skills/native',
              native: { agent: 'codex', scope: 'project' },
            },
          ],
        },
      ]
    },
    holdAdvanced: () => {
      holdAdvanced = true
    },
    get previewWaiting() {
      return !!settleAdvanced
    },
    releaseAdvanced: () => {
      holdAdvanced = false
      settleAdvanced!()
      settleAdvanced = undefined
    },
    get readCount() {
      return readCount
    },
    hide: () => {
      for (const listener of listeners)
        listener({ kind: 'context', context: { visible: false } })
    },
    row,
    selected,
    input: document.getElementById('skill-id') as HTMLInputElement,
    protectTarget: () => {
      protectedTarget = true
    },
  }
}
it.each(['automatic', 'explicit'])(
  'keeps browsing available throughout delayed %s observation without replaying conflicting actions',
  async (trigger) => {
    const f = fixture()
    await f.connect()
    f.holdObservation('skill')
    if (trigger === 'automatic') {
      f.hide()
      f.row(f.selected.id)
    } else f.click('observe-library')
    await vi.waitFor(() => expect(f.observationWaiting).toBe(true))
    const button = (id: string) => document.getElementById(id) as HTMLButtonElement
    expect(document.getElementById('state')!.textContent.trim()).toBe('Working…')
    expect(document.querySelector('main')!.getAttribute('aria-busy')).toBe('true')
    expect(button('open-exposure-browser').disabled).toBe(false)
    expect(button('start-review').disabled).toBe(false)
    expect(button('review-previous').disabled).toBe(true)
    for (const id of ['observe-library', 'create-library', 'add-copy'])
      expect(button(id).disabled).toBe(true)
    expect(
      (document.querySelector('#initialize button') as HTMLButtonElement).disabled,
    ).toBe(true)
    f.click('open-exposure-browser')
    expect(f.views).toEqual([{ contributionId: 'library' }])
    f.click('create-library')
    button('create-library').dispatchEvent(new Event('click'))
    expect(f.actions).toEqual([])
    f.resolveObservation()
    await f.connect()
    expect(document.getElementById('state')!.textContent).toBe('')
    expect(button('create-library').disabled).toBe(false)
    expect(button('add-copy').disabled).toBe(false)
    expect(button('review-previous').disabled).toBe(true)
    expect(f.input.value).toBe(f.selected.id)
    expect(f.actions).toEqual([])
  },
)

it('restores available commands after a failed initial observation without enabling unavailable actions', async () => {
  const f = fixture(webcrypto, undefined, true)
  expect(document.getElementById('state')!.textContent.trim()).toBe('Working…')
  expect((document.getElementById('create-library') as HTMLButtonElement).disabled).toBe(
    true,
  )
  f.rejectObservation()
  await f.connect()
  expect(document.getElementById('state')!.textContent).toBe('Retired observation failed')
  expect((document.getElementById('create-library') as HTMLButtonElement).disabled).toBe(
    false,
  )
  for (const id of ['connect-library', 'add-copy', 'accept-version'])
    expect((document.getElementById(id) as HTMLButtonElement).disabled).toBe(true)
  expect(f.actions).toEqual([])
})

it.each(['hidden', 'disposed'])(
  'does not navigate or publish a late navigation error after %s lifetime withdrawal',
  async (withdrawal) => {
    const f = fixture()
    await f.connect()
    f.holdNavigation()
    f.click('open-exposure-browser')
    expect(f.views).toHaveLength(1)
    if (withdrawal === 'hidden') f.hide()
    else dispose?.()
    const state = document.getElementById('state')!
    state.textContent = 'Current public status retained'
    f.click('open-exposure-browser')
    f.rejectNavigation()
    await Promise.resolve()
    await Promise.resolve()
    expect(state.textContent).toBe('Current public status retained')
    expect(f.views).toHaveLength(1)
  },
)

it('shows protected CLI refusal without a preview or confirmation action', async () => {
  const f = fixture()
  await f.connect()
  f.click('observe-copies')
  await vi.waitFor(() =>
    expect(document.querySelectorAll('#managed-copies button')).toHaveLength(2),
  )
  f.protectTarget()
  ;(document.getElementById('copy-mode') as HTMLSelectElement).value = 'stub'
  ;(document.querySelector('#managed-copies button') as HTMLButtonElement).click()
  await f.ready(/preserve the existing target and observe/)
  expect(document.getElementById('review')!.hidden).toBe(true)
  expect(f.actions).toEqual([])
})
it.each(['input', 'context', 'programmatic'])(
  'cannot Add a cached source after %s retargeting',
  async (mode) => {
    const f = fixture()
    await f.connect()
    if (mode === 'context') f.row('lib/different')
    else {
      f.input.value = 'lib/different'
      if (mode === 'input') f.input.dispatchEvent(new Event('input'))
    }
    f.click('add-copy')
    if (mode === 'programmatic')
      await f.ready(/Choose a current accepted library skill first/)
    else
      expect((document.getElementById('add-copy') as HTMLButtonElement).disabled).toBe(
        true,
      )
    expect(f.actions).toEqual([])
  },
)
it.each(['input', 'context', 'programmatic'])(
  'cannot confirm a cached Update plan after %s source retargeting',
  async (mode) => {
    const f = fixture()
    await f.connect()
    f.click('observe-copies')
    await vi.waitFor(() =>
      expect(document.querySelectorAll('#managed-copies button')).toHaveLength(2),
    )
    ;(document.getElementById('copy-mode') as HTMLSelectElement).value = 'stub'
    ;(document.querySelector('#managed-copies button') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(document.getElementById('review')!.hidden).toBe(false))
    if (mode === 'context') {
      f.row('lib/different')
      await f.connect()
    } else {
      f.input.value = 'lib/different'
      if (mode === 'input') f.input.dispatchEvent(new Event('input'))
    }
    f.click('confirm-plan')
    await f.ready(
      mode === 'programmatic'
        ? /selected source changed/
        : /Review one complete current plan/,
    )
    expect(f.actions).toEqual([])
    if (mode !== 'programmatic') {
      f.row(f.selected.id)
      f.click('add-copy')
      expect(document.getElementById('review')!.hidden).toBe(true)
      expect(f.actions).toEqual([])
    }
  },
)

it('submits the hash of the complete displayed sync metadata through ordinary confirmation', async () => {
  const f = fixture()
  await f.connect()
  f.click('preview-sync')
  await vi.waitFor(() => expect(document.getElementById('review')!.hidden).toBe(false))
  expect((document.getElementById('review-details') as HTMLDetailsElement).open).toBe(
    true,
  )
  const shown = document.getElementById('review-plan')!.textContent ?? ''
  f.click('confirm-plan')
  await vi.waitFor(() => expect(f.actions).toHaveLength(1))
  expect(f.actions[0]!.action).toBe('sync-library')
  expect(f.actions[0]!.input['reviewHash']).toMatch(/^[a-f0-9]{64}$/)
  expect(JSON.parse(shown)).toMatchObject({
    candidates: [{ source_identity: 'owned-source' }],
    lineages: [],
  })
})
it('cannot publish a human sync review after hide during async metadata digest', async () => {
  let settle!: (value: ArrayBuffer) => void
  const pendingDigest = new Promise<ArrayBuffer>((resolve) => {
    settle = resolve
  })
  const digest = vi.fn(() => pendingDigest)
  const f = fixture({ subtle: { digest } })
  await f.connect()
  f.click('preview-sync')
  await vi.waitFor(() => expect(digest).toHaveBeenCalledOnce())
  const publications = vi.spyOn(document.getElementById('review')!, 'hidden', 'set')
  f.hide()
  settle(new ArrayBuffer(32))
  f.row(f.selected.id)
  const precedingReads = f.readCount
  // A newly admitted ordinary read proves the previous guarded async workflow settled.
  await vi.waitFor(() => {
    f.click('observe-library')
    expect(f.readCount).toBeGreaterThan(precedingReads)
  })
  expect(publications.mock.calls.some(([hidden]) => hidden === false)).toBe(false)
  expect(document.getElementById('review')!.hidden).toBe(true)
  f.click('confirm-plan')
  expect(f.actions).toEqual([])
  publications.mockRestore()
})

it.each([0, 1])(
  'keeps the complete D8 file effects visible for copy review %i',
  async (button) => {
    const f = fixture()
    await f.connect()
    f.click('observe-copies')
    await vi.waitFor(() =>
      expect(document.querySelectorAll('#managed-copies button')).toHaveLength(2),
    )
    ;(document.getElementById('copy-mode') as HTMLSelectElement).value = 'stub'
    document
      .querySelectorAll<HTMLButtonElement>('#managed-copies button')
      [button]!.click()
    await vi.waitFor(() => expect(document.getElementById('review')!.hidden).toBe(false))
    expect((document.getElementById('review-details') as HTMLDetailsElement).open).toBe(
      true,
    )
    const effects = JSON.parse(document.getElementById('review-plan')!.textContent) as {
      file_effects: unknown[]
    }
    expect(effects.file_effects.length).toBeGreaterThan(0)
    expect(f.actions).toEqual([])
  },
)

it('creates with one default action without requiring custom location or Git inputs', async () => {
  const observed = {
    id: 'owned-id',
    root: { hostId: 'local', path: '/owned/library' },
    gitMode: 'disabled',
  }
  const f = fixture(webcrypto, () =>
    Promise.resolve({
      outcome: 'verified',
      observed,
      connect: true,
      message: 'Existing library preserved',
      guidance: 'Refresh',
    }),
  )
  expect(
    (document.getElementById('custom-initialization') as HTMLDetailsElement).open,
  ).toBe(false)
  expect((document.getElementById('library-path') as HTMLInputElement).value).toBe('')
  await f.connect()
  f.click('create-library')
  await f.ready(/Existing library preserved/)
  expect(f.actions).toEqual([
    { action: 'initialize-library', input: { location: 'default' } },
  ])
  expect(document.getElementById('library-identity')!.textContent).toContain(
    'Connected local: /owned/library',
  )
  expect(document.getElementById('library-identity')!.textContent).toContain(
    'history disabled',
  )
})

it('retains the advanced custom/no-Git action and ignores a creation reply after hiding', async () => {
  let resolve!: (value: Value) => void
  const held = new Promise<Value>((done) => {
    resolve = done
  })
  const f = fixture(webcrypto, () => held)
  await f.connect()
  ;(document.querySelector('#custom-initialization summary') as HTMLElement).click()
  ;(document.getElementById('library-path') as HTMLInputElement).value = '/owned/custom'
  ;(document.getElementById('git-history') as HTMLInputElement).checked = false
  ;(document.getElementById('initialize') as HTMLFormElement).requestSubmit()
  expect(f.actions).toEqual([
    {
      action: 'initialize-library',
      input: {
        location: 'custom',
        root: { hostId: 'local', path: '/owned/custom' },
        git: false,
      },
    },
  ])
  const before = document.getElementById('library-identity')!.textContent
  f.hide()
  resolve({
    outcome: 'verified',
    connect: true,
    observed: {
      id: 'late',
      root: { hostId: 'local', path: '/owned/custom' },
      gitMode: 'disabled',
    },
  })
  await held
  await Promise.resolve()
  expect(document.getElementById('library-identity')!.textContent).toBe(before)
  expect(document.getElementById('result')!.textContent).toBe('')
  expect((document.getElementById('connect-library') as HTMLButtonElement).hidden).toBe(
    true,
  )
})

it.each(['hidden', 'selection'])(
  'preserves current status when a creation rejection arrives after %s withdrawal',
  async (withdrawal) => {
    let reject!: (reason: Error) => void
    const held = new Promise<Value>((_resolve, fail) => {
      reject = fail
    })
    const f = fixture(webcrypto, () => held)
    await f.connect()
    f.click('create-library')
    expect(f.actions).toHaveLength(1)
    if (withdrawal === 'hidden') f.hide()
    else f.row('lib/new-selection')
    const state = document.getElementById('state')!
    state.textContent = 'Current public status retained'
    reject(new Error('Late canceled initialization'))
    await held.catch(() => {})
    await Promise.resolve()
    expect(state.textContent).toBe('Current public status retained')
    expect(document.getElementById('result')!.textContent).toBe('')
  },
)

it('requires one deliberate library change decision then resolves the unchanged selected skill', async () => {
  const f = fixture()
  await f.connect()
  expect((document.getElementById('add-copy') as HTMLButtonElement).disabled).toBe(false)
  f.changeLibrary()
  f.click('observe-library')
  await f.ready(/registered library changed/)
  await f.connect()
  expect((document.getElementById('add-copy') as HTMLButtonElement).disabled).toBe(true)
  expect((document.getElementById('connect-library') as HTMLButtonElement).hidden).toBe(
    false,
  )
  f.click('connect-library')
  await f.connect()
  expect((document.getElementById('connect-library') as HTMLButtonElement).hidden).toBe(
    true,
  )
  expect((document.getElementById('add-copy') as HTMLButtonElement).disabled).toBe(false)
  f.click('add-copy')
  await vi.waitFor(() => expect(f.actions).toHaveLength(1))
  expect(f.actions[0]?.input['library']).toMatchObject({
    id: '96600000-0000-4000-8000-000000000001',
  })
})

it('revokes cached Add eligibility when refreshing a now-blocked source', async () => {
  const f = fixture()
  await f.connect()
  f.setAcceptance('blocked')
  f.click('observe-source')
  await f.connect()
  expect((document.getElementById('add-copy') as HTMLButtonElement).disabled).toBe(true)
  f.click('add-copy')
  expect(f.actions).toEqual([])
  expect(document.getElementById('state')!.textContent).toContain('needs exact review')
})
it('resolves a new visible selected skill without a manual source observation', async () => {
  const f = fixture()
  await f.connect()
  f.selectCurrent('lib/next-selected')
  await f.connect()
  expect((document.getElementById('add-copy') as HTMLButtonElement).disabled).toBe(false)
  f.click('add-copy')
  await vi.waitFor(() => expect(f.actions).toHaveLength(1))
  expect(f.actions[0]?.input['skillId']).toBe('lib/next-selected')
})
it('ignores a late automatic observation error after its view is hidden', async () => {
  const f = fixture()
  await f.connect()
  f.holdObservation()
  f.click('observe-library')
  f.hide()
  document.getElementById('state')!.textContent = 'Current view retained'
  f.rejectObservation()
  await f.connect()
  expect(document.getElementById('state')!.textContent).toBe('Current view retained')
})

it('retires an automatic observation and queued renewal on disposal', async () => {
  const f = fixture()
  await f.connect()
  f.holdObservation()
  f.click('observe-library')
  f.hide()
  f.row(f.selected.id)
  const reads = f.readCount
  dispose?.()
  document.body.replaceChildren()
  f.rejectObservation()
  await Promise.resolve()
  await Promise.resolve()
  expect(f.readCount).toBe(reads)
  expect(document.body.childElementCount).toBe(0)
  expect(() => dispose?.()).not.toThrow()
})

it('keeps Add unavailable when current-library refresh fails', async () => {
  const f = fixture()
  await f.connect()
  f.holdObservation()
  f.click('observe-library')
  expect((document.getElementById('add-copy') as HTMLButtonElement).disabled).toBe(true)
  f.rejectObservation()
  await f.connect()
  f.click('add-copy')
  expect(f.actions).toEqual([])
  expect(document.getElementById('state')!.textContent).toBe('Retired observation failed')
})
