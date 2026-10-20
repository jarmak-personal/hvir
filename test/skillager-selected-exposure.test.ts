// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { setImmediate as settleTransport } from 'node:timers/promises'
import { buildSync } from 'esbuild'
import { afterEach, expect, it, vi } from 'vitest'
import { connectorOutputFixture } from './fixtures/connector-output'

type Value = Record<string, unknown>
interface SourceIdentity {
  library_id: string
  skill_id: string
}
interface Request extends Value {
  action: string
  source: SourceIdentity
  members: string[]
  departures?: Array<{ skill_id: string; mode: string }>
}
interface Origin extends Value {
  path: string
  entrypoint: string
}
interface Candidate extends Value {
  source: SourceIdentity
  requests: { native: Request; stub: Request }
}
interface Observation extends Value {
  origin: Origin
  candidates: Candidate[]
}
interface Plan extends Value {
  project: string
  library_id: string
  request: Request
  confirmation_token: string
  targets: Array<{ file_effects: Value[] }>
  sources: Array<{
    id: string
    entrypoint: string
    source: { library_root: string }
    lineages: Array<{ origin: Origin }>
  }>
}
interface View {
  select(value?: unknown, options?: unknown): Promise<void>
  contextChanged(): void
  dispose(): void
}
interface Module {
  bindExposureView(document: Document, client: unknown, ports: unknown): View
}
let dispose: (() => void) | undefined
const bundle = buildSync({
  stdin: {
    contents: `export { bindExposureView } from './packages/skillager-extension/src/exposure-view.mjs';
    export { nativePreservation } from './packages/skillager-extension/src/exposure-observation.mjs';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  format: 'iife',
  globalName: 'Module',
  write: false,
})
afterEach(() => {
  dispose?.()
  document.body.replaceChildren()
})
function fixture(agent = 'codex', canonicalId = 'lib/native-58b72abb645e2767') {
  const template = document.createElement('template')
  template.innerHTML = readFileSync('packages/skillager-extension/detail.html', 'utf8')
  for (const node of template.content.querySelectorAll('script, link')) node.remove()
  document.body.replaceChildren(template.content.cloneNode(true))
  const sandbox = {
    AbortController,
    TextEncoder,
    crypto: webcrypto,
    Module: undefined as unknown,
  }
  runInNewContext(bundle.outputFiles[0]!.text, sandbox)
  const module = sandbox.Module as Module
  const plan = JSON.parse(
    readFileSync(
      'test/fixtures/skillager-management/advanced-adoption-preview.json',
      'utf8',
    )
      .replaceAll('codex', agent)
      .replaceAll('lib/native-58b72abb645e2767', canonicalId)
      .replaceAll('/.agents/', agent === 'claude' ? '/.claude/' : '/.agents/'),
  ) as Plan
  const status = JSON.parse(
    readFileSync(
      'test/fixtures/skillager-management/advanced-library-status.json',
      'utf8',
    ),
  ) as Value
  const source = plan.sources[0]!,
    origin = source.lineages[0]!.origin,
    library = {
      id: plan['library_id'],
      root: { hostId: 'local', path: source.source.library_root },
    },
    workspace = {
      id: 'project',
      name: 'Project',
      host: 'local',
      root: { hostId: 'local', path: plan['project'] },
    },
    native = connectorOutputFixture(),
    abort = new AbortController(),
    outputs = new Map<string, string>()
  let context: Value = { visible: true, workspace },
    searchLibraryId = library.id,
    serial = 0,
    hold: (() => void) | undefined,
    holdObservation = false,
    holdPlan = false,
    releasePlan: (() => void) | undefined,
    holdAction = false,
    holdInventoryRelease = false,
    releaseInventory: (() => void) | undefined,
    failAction = false,
    releaseAction: (() => void) | undefined,
    observation: Observation = {
      schema: 'skillager.native-preservation.v1',
      project: plan['project'],
      agent,
      scope: 'project',
      library_id: library.id,
      origin,
      status: 'available',
      reason_code: null,
      candidates: [
        {
          source: plan['request'].source,
          basis: 'accepted-import',
          status: 'available',
          reason_code: null,
          proof_id: 'a'.repeat(64),
          requests: {
            native: { ...plan['request'], mode: 'native' },
            stub: { ...plan['request'], mode: 'stub' },
          },
        },
      ],
    }
  const requests: Array<{ capability: string; input: Value }> = [],
    actions: Array<{ input: { request: string; token: string } }> = [],
    expanded: boolean[] = [],
    chosen: Value[] = [],
    saveAndUse: string[] = []
  const router = {
    schema: 'skillager.exposure.v1',
    exposure_id: 'owned-router',
    mode: 'router',
    agent,
    scope: 'project',
    target: `${workspace.root.path}/.agents/skills/owned-router`,
    skill_ids: [source.id, 'lib/second'],
    member_sources: [
      { skill_id: source.id, source_library_id: library.id },
      { skill_id: 'lib/second', source_library_id: library.id },
    ],
  }
  const standalone = {
    schema: 'skillager.exposure.v1',
    exposure_id: 'native',
    mode: 'stub',
    agent,
    scope: 'project',
    target: origin.path,
    skill_id: source.id,
    source_library_id: library.id,
  }
  const libraryRow = (id: string) => ({
    id,
    name: id.slice(4),
    description: '',
    status: 'accepted',
    skill_file: `${library.root.path}/skills/${id.slice(4)}/SKILL.md`,
  })
  const client = {
    alive: true,
    signal: abort.signal,
    delay: async () => {},
    async request(capability: string, input: Value): Promise<unknown> {
      requests.push({ capability, input })
      if (capability === 'actions.invoke') {
        const action = input as unknown as { input: { request: string; token: string } }
        actions.push(action)
        if (holdAction)
          await new Promise<void>((resolve) => {
            releaseAction = resolve
          })
        if (failAction) throw new Error('Reviewed files changed; review again.')
        return {
          outcome: 'verified',
          action: input['action'],
          operation: (JSON.parse(action.input.request) as Request).action,
          results: [{ status: 'applied' }],
        }
      }
      if (capability === 'connector.output') {
        if (
          holdInventoryRelease &&
          input['release'] &&
          (JSON.parse(outputs.get(String(input['receipt']))!) as Value)['schema'] ===
            'skillager.exposures.v1'
        ) {
          holdInventoryRelease = false
          await new Promise<void>((resolve) => {
            releaseInventory = resolve
          })
        }
        return native.read(input)
      }
      if (capability === 'connector.execute') {
        const args = input['args'] as string[]
        let value: Value
        if (args.includes('--observe-native')) {
          if (holdObservation) {
            holdObservation = false
            await new Promise<void>((resolve) => {
              hold = resolve
            })
          }
          value = observation
        } else if (args.includes('--request-json')) {
          if (holdPlan)
            await new Promise<void>((resolve) => {
              releasePlan = resolve
            })
          const request = JSON.parse(args[args.indexOf('--request-json') + 1]!) as Request
          value = structuredClone(plan)
          value['request'] = request
          const ids =
            request.action === 'adopt-native'
              ? [request.source.skill_id]
              : request.action === 'ungroup'
                ? router.skill_ids
                : [
                    ...request.members,
                    ...(request.departures ?? [])
                      .filter((d) => d.mode !== 'remove')
                      .map((d) => d.skill_id),
                  ]
          value['sources'] = [...new Set(ids)].map((id) => ({ ...source, id }))
          value['group'] =
            request.action === 'adopt-native'
              ? null
              : { before_members: router.skill_ids, after_members: request.members ?? [] }
        } else if (args.includes('--list'))
          value = { schema: 'skillager.exposures.v1', exposures: [router, standalone] }
        else if (args[0] === 'library') value = status
        else if (args[0] === 'search') {
          value = {
            schema: 'skillager.search.v1',
            status: 'completed',
            next_cursor: null,
            results: [
              {
                id: 'lib/found',
                name: 'Found member',
                trust: 'reviewed',
                search: {
                  canonical: { library_id: searchLibraryId, skill_id: 'lib/found' },
                  occurrence: {
                    id: 'f'.repeat(64),
                    kind: 'library',
                    entrypoint: `${library.root.path}/skills/found/SKILL.md`,
                  },
                },
              },
            ],
          }
          if (args[args.indexOf('--cursor') + 1] !== '')
            value = {
              schema: 'skillager.error.v1',
              error: {
                code: 'invalid_cursor',
                message: 'cursor belongs to a different request',
              },
            }
        } else
          value = {
            schema: 'skillager.list.v1',
            scope: 'library',
            skills: args.includes('--cursor')
              ? [libraryRow('lib/later')]
              : [libraryRow(source.id), libraryRow('lib/second')],
            next_cursor: args.includes('--cursor') ? null : 'next-page',
          }
        const receipt = `result-${++serial}`,
          text = JSON.stringify(value)
        outputs.set(receipt, text)
        return native.complete(
          {
            outcome: 'completed',
            receipt,
            code:
              value['status'] === 'unavailable' ||
              value['schema'] === 'skillager.error.v1'
                ? 2
                : 0,
          },
          text,
        )
      }
      if (capability === 'viewer.open-own') return {}
      throw new Error(`Unexpected public request: ${capability}`)
    },
  }
  const view = module.bindExposureView(document, client, {
    context: () => context,
    expanded: (value: boolean) => expanded.push(value),
    choose: (row: Value) => chosen.push(row),
    saveAndUse: (mode: string) => saveAndUse.push(mode),
  })
  dispose = () => {
    view.dispose()
    abort.abort()
  }
  const row = {
    id: 'original',
    skillId: 'project/native',
    path: origin.entrypoint,
    source: 'project',
    host: 'local',
    workspaceId: workspace.id,
    name: 'Native',
    kind: 'Project original',
    agent,
  }
  const el = (id: string) =>
    document.getElementById(`exposure-${id}`)! as HTMLInputElement
  return {
    view,
    row,
    source,
    plan,
    library,
    workspace,
    router,
    standalone,
    requests,
    actions,
    expanded,
    chosen,
    saveAndUse,
    el,
    holdInventoryRelease() {
      holdInventoryRelease = true
    },
    get inventoryReleaseWaiting() {
      return !!releaseInventory
    },
    async releaseInventory() {
      releaseInventory?.()
      // Drain the released transport's continuations before the next user action.
      await settleTransport()
    },
    setSearchLibrary(id: string) {
      searchLibraryId = id
    },
    get observation() {
      return observation
    },
    setObservation(value: Observation) {
      observation = value
    },
    selectOriginal(options?: unknown) {
      return view.select({ row }, options)
    },
    selectRouter() {
      void view.select({
        row: {
          ...row,
          path: `${router.target}/SKILL.md`,
          kind: 'Installed Router',
          exposure: router,
        },
      })
    },
    selectLibrary() {
      void view.select({
        row: {
          ...row,
          id: source.id,
          source: 'library',
          path: source.entrypoint,
          kind: 'Your library',
          canonical: null,
        },
        library: { id: library.id, root: library.root.path },
      })
    },
    setContext(value: Value) {
      context = value
      view.contextChanged()
    },
    hide() {
      context = { ...context, visible: false }
      view.contextChanged()
    },
    holdObservation() {
      holdObservation = true
    },
    releaseObservation() {
      hold?.()
    },
    get observationWaiting() {
      return !!hold
    },
    holdPlan() {
      holdPlan = true
    },
    releasePlan() {
      releasePlan?.()
    },
    get planWaiting() {
      return !!releasePlan
    },
    holdAction() {
      holdAction = true
    },
    releaseAction(failed = false) {
      failAction = failed
      releaseAction?.()
    },
    click(id: string) {
      el(id).click()
    },
    change(id: string, value: string) {
      el(id).value = value
      el(id).dispatchEvent(new Event('change'))
    },
    check(id: string, checked: boolean) {
      const input = document.querySelector<HTMLInputElement>(`[data-skill-id="${id}"]`)!
      input.checked = checked
      input.dispatchEvent(new Event('change'))
    },
    async ready() {
      await vi.waitFor(() => expect(el('full').disabled).toBe(false))
    },
    async pickerReady() {
      await vi.waitFor(() => expect(el('member-search-button').disabled).toBe(false))
      await vi.waitFor(() =>
        expect(
          document.querySelectorAll('#exposure-member-results input').length,
        ).toBeGreaterThan(0),
      )
    },
  }
}

it.each(['codex', 'claude'])(
  'automatically observes the exact %s original and reviews one explicit replacement',
  async (agent) => {
    const f = fixture(agent)
    void f.selectOriginal()
    await f.ready()
    expect(
      f.requests.some(
        (r) =>
          r.capability === 'connector.execute' &&
          (r.input['args'] as string[]).includes('--observe-native'),
      ),
    ).toBe(true)
    expect(f.actions).toEqual([])
    f.click('stub')
    await vi.waitFor(() => expect(f.el('preview').disabled).toBe(false))
    f.click('preview')
    await vi.waitFor(() => expect(f.el('review').hidden).toBe(false))
    expect(f.el('summary').textContent).toContain(f.row.path.slice(0, -9))
    expect(f.el('summary').textContent).toContain(f.source.id)
    expect(document.querySelectorAll('#exposure-effects li')).toHaveLength(
      f.plan.targets.flatMap((t) => t.file_effects).length,
    )
    f.click('confirm')
    await vi.waitFor(() => expect(f.actions).toHaveLength(1))
    expect(JSON.parse(f.actions[0]!.input.request)).toEqual(
      f.observation.candidates[0]!.requests.stub,
    )
    expect(f.actions[0]!['input'].token).toBe(f.plan['confirmation_token'])
  },
)

it('preserves an exact Unicode identity across public observation, review and dispatch', async () => {
  const identity = 'lib/保存-𐐨-１２',
    f = fixture('codex', identity)
  void f.selectOriginal()
  await f.ready()
  f.click('stub')
  await vi.waitFor(() => expect(f.el('preview').disabled).toBe(false))
  f.click('preview')
  await vi.waitFor(() => expect(f.el('review').hidden).toBe(false))
  f.click('confirm')
  await vi.waitFor(() => expect(f.actions).toHaveLength(1))
  const request = JSON.parse(f.actions[0]!.input.request) as Request
  expect(request.source.skill_id).toBe(identity)
})

it('requires an explicit actual choice when more than one preservation relation is available', async () => {
  const f = fixture(),
    second = structuredClone(f.observation.candidates[0]!)
  second.source.skill_id = 'lib/other'
  for (const request of Object.values(second.requests)) request.source = second.source
  f.observation['candidates'].push(second)
  f.observation['status'] = 'ambiguous'
  void f.selectOriginal()
  await vi.waitFor(() => expect(f.el('choice-row').hidden).toBe(false))
  expect(f.el('full').disabled).toBe(true)
  f.change('choice', 'lib/other')
  expect(f.el('full').disabled).toBe(false)
  expect(f.actions).toEqual([])
})

it('admits every one of 64 complete preservation choices without defaulting an ambiguous relation', async () => {
  const f = fixture(),
    first = f.observation.candidates[0]!
  f.observation.candidates = Array.from({ length: 64 }, (_, index) => {
    const candidate = structuredClone(first)
    candidate.source.skill_id = `lib/exact-${index}`
    for (const request of Object.values(candidate.requests))
      request.source = candidate.source
    return candidate
  })
  f.observation['status'] = 'ambiguous'
  void f.selectOriginal()
  await vi.waitFor(() =>
    expect(document.querySelectorAll('#exposure-choice option')).toHaveLength(65),
  )
  expect(f.el('full').disabled).toBe(true)
  f.change('choice', 'lib/exact-63')
  f.click('stub')
  await vi.waitFor(() => expect(f.el('preview').disabled).toBe(false))
  f.click('preview')
  await vi.waitFor(() => expect(f.el('review').hidden).toBe(false))
  expect((JSON.parse(f.el('plan').textContent) as Plan).request.source.skill_id).toBe(
    'lib/exact-63',
  )
})

it('refuses the complete oversized observation without offering its otherwise available first choice', async () => {
  const f = fixture()
  f.observation.origin['provenance'] = { note: 'x'.repeat(256 * 1024) }
  void f.selectOriginal()
  await vi.waitFor(() =>
    expect(f.el('preservation-reason').textContent).toContain(
      'Complete connector output exceeds the supported bound',
    ),
  )
  expect(f.el('full').hidden).toBe(true)
  expect(f.el('stub').hidden).toBe(true)
  expect(f.el('context').hidden).toBe(true)
  expect(f.el('preservation-details').hidden).toBe(false)
  expect(f.el('preservation-details').closest('.skill-menu')).not.toBeNull()
  expect(f.el('refresh').disabled).toBe(false)
  expect(f.actions).toEqual([])
})

it('restores ordinary selected tasks when a temporary membership task is hidden', async () => {
  const f = fixture()
  f.selectLibrary()
  f.click('group')
  await f.pickerReady()
  f.hide()
  expect(f.expanded).toEqual([true, false])
  expect(f.el('task').hidden).toBe(true)
  expect(f.actions).toEqual([])
})

it.each(['start-selection', 'start-workspace', 'refresh-selection'])(
  'retired %s inventory cannot replace the ready task after old receipt release',
  async (retirement) => {
    const f = fixture()
    f.holdInventoryRelease()
    if (retirement.startsWith('refresh')) f.selectRouter()
    else {
      f.selectLibrary()
      f.click('group')
    }
    await vi.waitFor(() => expect(f.inventoryReleaseWaiting).toBe(true))
    if (retirement.endsWith('workspace'))
      f.setContext({ visible: true, workspace: { ...f.workspace, id: 'next-project' } })
    else f.selectLibrary()
    f.standalone.exposure_id = 'current-copy'
    f.click('group')
    await f.pickerReady()
    expect(document.querySelector('[data-exposure-id="current-copy"]')).not.toBeNull()
    f.check('lib/second', true)
    await f.releaseInventory()
    expect(f.el('selected-count').textContent).toBe('2 selected')
    f.check(f.source.id, false)
    f.check(f.source.id, true)
    expect(document.querySelector('[data-exposure-id="current-copy"]')).not.toBeNull()
    expect(document.querySelector('[data-exposure-id="native"]')).toBeNull()
    expect(f.actions).toEqual([])
  },
)

it.each(['success', 'refusal', 'selection'])(
  'shows immediate task progress and retires it on %s',
  async (ending) => {
    const f = fixture()
    f.selectLibrary()
    f.click('group')
    expect(f.el('preview').textContent).toBe('Preparing…')
    expect(f.el('task').getAttribute('aria-busy')).toBe('true')
    await f.pickerReady()
    expect(f.el('preview').textContent).toBe('Review changes')
    f.el('name').value = 'Owned'
    f.holdPlan()
    f.click('preview')
    expect(f.el('preview').textContent).toBe('Reviewing…')
    await vi.waitFor(() => expect(f.planWaiting).toBe(true))
    f.releasePlan()
    await vi.waitFor(() => expect(f.el('confirm').disabled).toBe(false))
    expect(f.el('confirm').textContent).toBe('Group')
    f.holdAction()
    f.click('confirm')
    expect(f.el('confirm').textContent).toBe('Applying…')
    expect(f.el('task').getAttribute('aria-busy')).toBe('true')
    if (ending === 'selection') f.selectLibrary()
    f.releaseAction(ending === 'refusal')
    await vi.waitFor(() => expect(f.el('task').getAttribute('aria-busy')).toBe('false'))
    if (ending === 'selection') {
      await vi.waitFor(() => expect(f.el('group').disabled).toBe(false))
      expect(f.el('task').hidden).toBe(true)
    } else if (ending === 'refusal') {
      expect(f.el('state').textContent).toContain('Reviewed files changed')
      expect(f.el('confirm').hidden).toBe(true)
      expect(f.el('preview').disabled).toBe(false)
    } else {
      expect(f.el('cancel').textContent).toBe('Done')
      expect(f.el('confirm').hidden).toBe(true)
    }
  },
)

it.each(['hide', 'select', 'workspace', 'dispose'])(
  'rejects late preservation after %s',
  async (event) => {
    const f = fixture()
    f.holdObservation()
    void f.selectOriginal()
    await vi.waitFor(() => expect(f.observationWaiting).toBe(true))
    if (event === 'hide') f.hide()
    else if (event === 'select') void f.view.select(undefined)
    else if (event === 'workspace')
      f.setContext({ visible: true, workspace: { ...f.workspace, id: 'other' } })
    else f.view.dispose()
    f.releaseObservation()
    await vi.waitFor(() =>
      expect(
        f.requests.some(
          (r) => r['capability'] === 'connector.output' && r['input'].release,
        ),
      ).toBe(true),
    )
    expect(f.el('full').disabled || f.el('context').hidden).toBe(true)
    expect(f.actions).toEqual([])
  },
)

it('retires original-only preservation when the same reader selects a Router and restores it for an original', async () => {
  const f = fixture()
  void f.selectOriginal()
  await vi.waitFor(() => expect(f.el('stub').disabled).toBe(false))
  expect(f.el('preservation-details').hidden).toBe(false)
  f.router.skill_ids = [f.source.id]
  f.router.member_sources = [f.router.member_sources[0]!]
  f.selectRouter()
  await vi.waitFor(() => expect(f.el('edit').disabled).toBe(false))
  expect(f.el('preservation-details').hidden).toBe(true)
  expect(document.getElementById('router-state')!.textContent).toBe('1 member')
  expect(document.querySelector('#router-members button')!.textContent).toBe(
    f.source.id.slice(4),
  )
  expect(document.querySelector('#router-members details')!.textContent).toContain(
    f.source.id,
  )
  void f.selectOriginal()
  await vi.waitFor(() => expect(f.el('stub').disabled).toBe(false))
  expect(f.el('preservation-details').hidden).toBe(false)
  expect(f.el('edit').hidden).toBe(true)
})

it('shows exact Router members and retains selected identities across paging and search', async () => {
  const f = fixture()
  f.selectRouter()
  await vi.waitFor(() => expect(f.el('edit').disabled).toBe(false))
  expect(document.querySelectorAll('#router-members > li')).toHaveLength(2)
  expect(document.getElementById('router-members')!.textContent).toContain(f.library.id)
  f.click('edit')
  await f.pickerReady()
  expect(
    [
      ...document.querySelectorAll<HTMLInputElement>('#exposure-member-results input'),
    ].every((input) => input.checked),
  ).toBe(true)
  expect(f.el('departures').hidden).toBe(true)
  f.check(f.source.id, false)
  expect(document.querySelectorAll('#exposure-departures select')).toHaveLength(1)
  const departure = document.querySelector<HTMLSelectElement>(
    '#exposure-departures select',
  )!
  departure.value = 'stub'
  departure.dispatchEvent(new Event('change'))
  const retired = document.querySelector<HTMLInputElement>(
    `[data-skill-id="${f.source.id}"]`,
  )!
  f.click('member-next')
  await vi.waitFor(() =>
    expect(document.querySelector('[data-skill-id="lib/later"]')).not.toBeNull(),
  )
  retired.click()
  expect(f.el('selected-count').textContent).toBe('1 selected')
  f.check('lib/later', true)
  f.el('member-query').value = 'found'
  document
    .getElementById('exposure-member-search')!
    .dispatchEvent(new Event('submit', { cancelable: true }))
  await vi.waitFor(() =>
    expect(document.querySelector('[data-skill-id="lib/found"]')).not.toBeNull(),
  )
  f.check('lib/found', true)
  const retained = [...f.el('selected-members').querySelectorAll('button')].map(
    (item) => item.title,
  )
  expect(retained).toContain(`${f.library.id} · lib/second`)
  expect(retained).toContain(`${f.library.id} · lib/later`)
  expect(f.el('selected-count').textContent).toBe('3 selected')
  f.click('preview')
  await vi.waitFor(() => expect(f.el('review').hidden).toBe(false))
  const request = (JSON.parse(f.el('plan').textContent) as Plan).request
  expect(request.members).toEqual(['lib/second', 'lib/later', 'lib/found'])
  expect(request.departures).toEqual([{ skill_id: f.source.id, mode: 'stub' }])
  expect(request.replace).toEqual([])
  f.click('cancel')
  expect(f.actions).toEqual([])
})

it('returns from the second member page to the first without losing off-page selection', async () => {
  const f = fixture()
  f.selectLibrary()
  f.click('group')
  await f.pickerReady()
  f.click('member-next')
  await vi.waitFor(() =>
    expect(document.querySelector('[data-skill-id="lib/later"]')).not.toBeNull(),
  )
  f.check('lib/later', true)
  f.click('member-previous')
  await vi.waitFor(() =>
    expect(document.querySelector(`[data-skill-id="${f.source.id}"]`)).not.toBeNull(),
  )
  expect(f.el('member-page').textContent).toBe('Page 1')
  expect(f.el('member-previous').disabled).toBe(true)
  expect(f.el('member-next').disabled).toBe(false)
  expect(f.el('selected-count').textContent).toBe('2 selected')
  expect(
    [...f.el('selected-members').querySelectorAll('button')].map((item) => item.title),
  ).toContain(`${f.library.id} · lib/later`)
})

it('refuses a searched canonical identity from another library without losing retained members', async () => {
  const f = fixture()
  f.selectLibrary()
  f.click('group')
  await f.pickerReady()
  f.setSearchLibrary('7872ddf0-5e50-4bce-a032-c0fa6eac38a3')
  f.el('member-query').value = 'found'
  document
    .getElementById('exposure-member-search')!
    .dispatchEvent(new Event('submit', { cancelable: true }))
  await vi.waitFor(() => expect(f.el('state').textContent).toContain('exact library'))
  expect(document.querySelector('[data-skill-id="lib/found"]')).toBeNull()
  expect(f.el('selected-count').textContent).toBe('1 selected')
  expect(f.actions).toEqual([])
})

it('starts Group with the selected skill and requires explicit actual standalone replacement selection', async () => {
  const f = fixture()
  f.selectLibrary()
  f.click('group')
  await f.pickerReady()
  expect(f.el('selected-count').textContent).toBe('1 selected')
  const replacement = document.querySelector<HTMLInputElement>(
    '[data-exposure-id="native"]',
  )!
  expect(replacement.checked).toBe(false)
  replacement.click()
  f.el('name').value = 'Selected group'
  f.click('preview')
  await vi.waitFor(() => expect(f.el('review').hidden).toBe(false))
  expect((JSON.parse(f.el('plan').textContent) as Plan).request).toMatchObject({
    action: 'group',
    members: [f.source.id],
    replace: [{ exposure_id: 'native' }],
  })
  expect(f.el('summary').textContent).toContain(f.standalone.target)
  f.click('cancel')
  expect(f.actions).toEqual([])
})

it.each(['add-checkbox', 'remove-checkbox', 'remove-selected'])(
  'keeps visible membership and the reviewed request aligned after %s while preparing',
  async (interaction) => {
    const f = fixture()
    f.selectLibrary()
    f.click('group')
    await f.pickerReady()
    f.el('name').value = 'Owned'
    f.holdPlan()
    f.click('preview')
    await vi.waitFor(() => expect(f.planWaiting).toBe(true))
    if (interaction === 'remove-selected')
      f.el('selected-members').querySelector('button')!.click()
    else
      document
        .querySelector<HTMLInputElement>(
          `[data-skill-id="${interaction === 'add-checkbox' ? 'lib/second' : f.source.id}"]`,
        )!
        .click()
    expect(
      document.querySelector<HTMLInputElement>(`[data-skill-id="${f.source.id}"]`)!
        .checked,
    ).toBe(true)
    expect(
      document.querySelector<HTMLInputElement>('[data-skill-id="lib/second"]')!.checked,
    ).toBe(false)
    expect(
      [...f.el('selected-members').querySelectorAll('button')].map((item) => item.title),
    ).toEqual([`${f.library.id} · ${f.source.id}`])
    expect(f.el('selected-count').textContent).toBe('1 selected')
    f.releasePlan()
    await vi.waitFor(() => expect(f.el('confirm').disabled).toBe(false))
    expect((JSON.parse(f.el('plan').textContent) as Plan).request.members).toEqual([
      f.source.id,
    ])
    f.click('confirm')
    await vi.waitFor(() => expect(f.actions).toHaveLength(1))
    expect((JSON.parse(f.actions[0]!.input.request) as Request).members).toEqual([
      f.source.id,
    ])
  },
)

it('refuses a changed selection while preparing the complete plan', async () => {
  const f = fixture()
  f.selectLibrary()
  f.click('group')
  await f.pickerReady()
  f.el('name').value = 'Before'
  f.holdPlan()
  f.click('preview')
  await vi.waitFor(() => expect(f.planWaiting).toBe(true))
  f.el('name').value = 'After'
  f.releasePlan()
  await vi.waitFor(() => expect(f.el('state').textContent).toContain('Selection changed'))
  expect(f.el('review').hidden).toBe(true)
  expect(f.actions).toEqual([])
})

it.each([
  'wrong-project',
  'wrong-provider',
  'wrong-library',
  'wrong-origin',
  'request-drift',
  'too-many',
])('rejects %s preservation without offering a partial choice', async (failure) => {
  const f = fixture(),
    value = f.observation
  if (failure === 'wrong-project') value['project'] = '/other'
  if (failure === 'wrong-provider') value['agent'] = 'other'
  if (failure === 'wrong-library') value['library_id'] = 'other'
  if (failure === 'wrong-origin') value['origin'].entrypoint = '/other/SKILL.md'
  if (failure === 'request-drift')
    value.candidates[0]!.requests.stub['origin_id'] = 'b'.repeat(64)
  if (failure === 'too-many')
    value.candidates = Array.from({ length: 65 }, () => value.candidates[0]!)
  void f.selectOriginal()
  await vi.waitFor(() =>
    expect(f.el('preservation-reason').textContent).toContain(
      failure === 'request-drift'
        ? 'Replacement request differs'
        : failure === 'too-many'
          ? 'Replacement needs the current public'
          : 'Replacement observation does not match',
    ),
  )
  expect(f.el('full').disabled).toBe(true)
  expect(f.el('stub').disabled).toBe(true)
  expect(f.actions).toEqual([])
})

it('mode-first entry keeps exact saved adoption and prepares only its complete exposure review', async () => {
  const f = fixture()
  await f.selectOriginal({ mode: 'stub' })
  expect(f.el('review').hidden).toBe(false)
  expect(f.saveAndUse).toEqual([])
  const reads = f.requests
    .filter((call) => call.capability === 'connector.execute')
    .map((call) => call.input['args'] as string[])
  expect(reads.filter((args) => args.includes('--request-json'))).toHaveLength(1)
  expect(reads.some((args) => args[0] === 'import')).toBe(false)
  expect(f.actions).toEqual([])
})
it('mode-first unsaved-original entry delegates one combined review without adoption or import side effects', async () => {
  const f = fixture()
  f.observation['status'] = 'unavailable'
  f.observation.candidates = []
  await f.selectOriginal({ mode: 'native' })
  expect(f.saveAndUse).toEqual(['native'])
  expect(f.actions).toEqual([])
  const reads = f.requests
    .filter((call) => call.capability === 'connector.execute')
    .map((call) => call.input['args'] as string[])
  expect(
    reads.some((args) => args.includes('--request-json') || args[0] === 'import'),
  ).toBe(false)
})

it('does not resurrect a mode-first task after the same row context is refreshed', async () => {
  const f = fixture()
  f.holdObservation()
  const preparation = f.selectOriginal({ mode: 'stub' })
  await vi.waitFor(() => expect(f.observationWaiting).toBe(true))
  f.hide()
  f.setContext({ visible: true, workspace: f.workspace })
  await f.ready()
  f.releaseObservation()
  await preparation
  expect(f.el('task').hidden).toBe(true)
  expect(f.saveAndUse).toEqual([])
  expect(f.actions).toEqual([])
  expect(
    f.requests.some(
      (call) =>
        call.capability === 'connector.execute' &&
        (call.input['args'] as string[]).includes('--request-json'),
    ),
  ).toBe(false)
})

it('keeps ambiguous mode-first source choice inside the task and restores its ordinary home on cancel', async () => {
  const f = fixture(),
    second = structuredClone(f.observation.candidates[0]!)
  second.source.skill_id = 'lib/other'
  for (const request of Object.values(second.requests)) request.source = second.source
  f.observation.candidates.push(second)
  f.observation.status = 'ambiguous'
  const home = f.el('choice-row').parentElement
  await f.selectOriginal({ mode: 'stub' })
  expect(f.el('choice-row').parentElement).toBe(f.el('fields'))
  expect(f.el('task').hidden).toBe(false)
  expect(f.el('confirm').disabled).toBe(true)
  f.change('choice', 'lib/other')
  await vi.waitFor(() => expect(f.el('review').hidden).toBe(false))
  expect((JSON.parse(f.el('plan').textContent) as Plan).request.source.skill_id).toBe(
    'lib/other',
  )
  expect(f.actions).toEqual([])
  f.click('cancel')
  expect(f.el('choice-row').parentElement).toBe(home)
})
