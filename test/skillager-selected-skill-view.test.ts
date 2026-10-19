import { connectorOutputFixture } from './fixtures/connector-output'
// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { buildSync } from 'esbuild'
import { afterEach, expect, it, vi } from 'vitest'

type Value = Record<string, unknown>
interface Preview {
  exposure_id: string
  target: string
  preview: {
    project: string
    confirmation_token: string
    source: {
      id: string
      root: string
      content_hash: string
      source: { library_id: string; library_root: string }
    }
  }
}
interface Status {
  library: Value
  skill: {
    id: string
    path: string
    entrypoint: string
    working_hash: string
    accepted_hash: string
    acceptance: string
    exposures: Value[]
  }
}
let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  document.body.replaceChildren()
})
function fixture() {
  const template = document.createElement('template')
  template.innerHTML = readFileSync('packages/skillager-extension/detail.html', 'utf8')
  for (const node of template.content.querySelectorAll('script, link')) node.remove()
  document.body.replaceChildren(template.content.cloneNode(true))
  const preview = JSON.parse(
    readFileSync(
      'test/fixtures/skillager-management/codex-exact-mode-update-preview.json',
      'utf8',
    ),
  ) as [Preview]
  const selected = preview[0].preview.source
  const status = JSON.parse(
    readFileSync('test/fixtures/skillager-management/first-no-git-status.json', 'utf8'),
  ) as Status
  Object.assign(status.library, {
    library_id: selected.source.library_id,
    root: selected.source.library_root,
  })
  Object.assign(status.skill, {
    id: selected.id,
    path: selected.root,
    entrypoint: `${selected.root}/SKILL.md`,
    working_hash: selected.content_hash,
    accepted_hash: selected.content_hash,
    acceptance: 'accepted',
  })
  const review = JSON.parse(
    readFileSync('test/fixtures/skillager-management/first-no-git-review.json', 'utf8')
      .replaceAll('f06e01bd-5e1f-4aa0-b1ef-3cf9c66f2a85', selected.source.library_id)
      .replaceAll('/owned-manifest-fixture/library/skills/owned-first', selected.root)
      .replaceAll('/owned-manifest-fixture/library', selected.source.library_root)
      .replaceAll('lib/owned-first', selected.id)
      .replaceAll(
        '0cc360070c6fc5542d08e3c5c85bb5a9299a39a7d56193db8eb3e12d6b6a445a',
        selected.content_hash,
      ),
  ) as unknown
  const workspace = {
    id: 'workspace',
    name: 'Project',
    host: 'local',
    root: { hostId: 'local', path: preview[0].preview.project },
  }
  let context: Value = { visible: true, workspace },
    exposures: unknown[] = [],
    failure = false,
    failureMessage: string | undefined,
    actionError: string | undefined,
    records: Value[] = [],
    hold = false,
    holdAction = false,
    releaseAction: (() => void) | undefined,
    projectReadable = true,
    releaseConnection: ((value: unknown) => void) | undefined,
    release: (() => void) | undefined
  let actionResult: Value = {
    outcome: 'verified',
    action: 'add-copy',
    exposureId: preview[0].exposure_id,
    target: { hostId: 'local', path: preview[0].target },
  }
  const actions: Value[] = [],
    requests: { capability: string; input: Value }[] = [],
    recovery: Value[] = [],
    executions: Value[] = [],
    outputs = new Map<string, unknown>(),
    controller = new AbortController()
  let count = 0
  const native = connectorOutputFixture()
  const client = {
    alive: true,
    signal: controller.signal,
    listen: () => () => undefined,
    request: async (capability: string, input: Value): Promise<unknown> => {
      requests.push({ capability, input })
      if (capability === 'source.status')
        return [{ source: 'project', granted: projectReadable }]
      if (capability === 'connector.status')
        return [
          {
            connector: 'project-cli',
            host: workspace.host,
            availability: failure ? 'unavailable' : 'supported',
          },
        ]
      if (capability === 'actions.invoke') {
        const request = input['input'] as Value
        if (input['action'] === 'operation-state') {
          recovery.push(request)
          if (request['mode'] === 'observe')
            return {
              outcome: 'observed',
              observation: JSON.stringify({ target: preview[0].target, current: true }),
              message: 'Exact current facts',
            }
          if (request['mode'] === 'acknowledge') {
            records = []
            return { outcome: 'reconciled', message: 'Current facts acknowledged' }
          }
          if (request['mode'] === 'list')
            return { ids: records.map((entry) => entry['id']) }
          if (request['mode'] === 'report')
            return {
              data: JSON.stringify(
                records.find((entry) => entry['id'] === request['operationId']),
              ),
              nextOffset: null,
            }
        }
        actions.push(input)
        if (holdAction) {
          holdAction = false
          await new Promise<void>((resolve) => {
            releaseAction = resolve
          })
        }
        if (actionResult['outcome'] === 'uncertain')
          records.push({
            id: actionResult['operationId'],
            operation: {
              action: input['action'],
              library: request['library'],
              source: { id: selected.id },
              workspace,
              agent: request['agent'],
              target: { hostId: 'local', path: preview[0].target },
            },
          })
        if (actionError) throw new Error(actionError)
        if (input['action'] === 'accept-version') status.skill.acceptance = 'accepted'
        return actionResult
      }
      if (capability === 'connector.output') return native.read(input)
      if (capability === 'connector.connect') {
        if (!projectReadable)
          return new Promise((resolve) => {
            releaseConnection = resolve
          })
        failure = false
        return {
          connections: [{ connector: 'project-cli', outcome: 'connected' }],
          source: { source: 'project', outcome: 'granted' },
          readiness: { program: true, source: true },
        }
      }
      if (failureMessage && input['connector'] === 'project-cli')
        throw new Error(failureMessage)
      executions.push(input)
      const args = input['args'] as string[]
      if (failure && input['connector'] === 'project-cli')
        return { outcome: 'not-started', reason: 'unapproved' }
      const receipt = String(++count)
      outputs.set(
        receipt,
        args.includes('--list')
          ? { schema: 'skillager.exposures.v1', exposures }
          : args.includes('accept')
            ? review
            : args[0] === 'expose'
              ? preview
              : input['connector'] === 'project-cli'
                ? status
                : { ...status, skill: { ...status.skill, exposures: [] } },
      )
      if (hold) {
        hold = false
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      return native.complete(
        { outcome: 'completed', code: 0, receipt, truncated: false },
        JSON.stringify(outputs.get(receipt)),
      )
    },
  }
  const bundle = buildSync({
    entryPoints: ['packages/skillager-extension/src/selected-skill-view.mjs'],
    bundle: true,
    format: 'iife',
    globalName: 'Module',
    write: false,
  })
  const sandbox = { TextEncoder, Module: undefined as unknown }
  runInNewContext(bundle.outputFiles[0]!.text, sandbox)
  const view = (
    sandbox.Module as {
      bindSelectedSkill(
        document: Document,
        client: unknown,
        ports: unknown,
      ): { select(input: unknown): void; contextChanged(): void; dispose(): void }
    }
  ).bindSelectedSkill(document, client, { context: () => context })
  dispose = () => {
    view.dispose()
    controller.abort()
  }
  const selection = {
    row: { id: selected.id, source: 'library', path: status.skill.entrypoint },
    library: { id: selected.source.library_id, root: selected.source.library_root },
  }
  const button = (id: string) => document.getElementById(id) as HTMLButtonElement
  const ready = () =>
    vi.waitFor(() => expect(button('task-primary').disabled).toBe(false))
  return {
    view,
    selection,
    status,
    actions,
    recovery,
    executions,
    requests,
    preview,
    button,
    ready,
    changeMode: (mode: string) => {
      const select = document.getElementById('task-mode') as HTMLSelectElement
      select.value = mode
      select.dispatchEvent(new Event('change'))
    },
    mode: () => (document.getElementById('task-mode') as HTMLSelectElement).value,
    projectSelection: (agent = 'codex', target = preview[0].target) => ({
      row: {
        id: 'exact-project-occurrence',
        skillId: selected.id,
        source: 'project',
        host: 'local',
        workspaceId: workspace.id,
        path: `${target}/SKILL.md`,
        canonical: { library_id: selected.source.library_id, skill_id: selected.id },
        exposure: {
          exposure_id: preview[0].exposure_id,
          skill_id: selected.id,
          source_library_id: selected.source.library_id,
          agent,
          target,
          scope: 'project',
          mode: 'native',
        },
      },
    }),
    changeAgent: (agent: string) => {
      const select = document.getElementById('task-agent') as HTMLSelectElement
      select.value = agent
      select.dispatchEvent(new Event('change'))
    },
    installed: (mode = 'native', agent = 'codex') => {
      exposures = [
        {
          ...preview[0],
          skill_id: selected.id,
          source_library_id: selected.source.library_id,
          mode,
          agent,
          status: 'current',
        },
      ]
      status.skill.exposures = [
        {
          path: preview[0].target,
          agent,
          scope: 'project',
          source_library_id: selected.source.library_id,
          source_hash: selected.content_hash,
        },
      ]
    },
    failureMessage: (message: string) => {
      failureMessage = message
    },
    actionError: (message: string) => {
      actionError = message
    },
    recovered: () => {
      records = []
    },
    pending: (record: Value) => {
      records.push(record)
    },
    visibility: (visible: boolean) => {
      context = { ...context, visible }
      view.contextChanged()
    },
    fail: () => {
      failure = true
    },
    projectRead: (value: boolean) => {
      projectReadable = value
    },
    connected: (value: unknown) => releaseConnection?.(value),
    hold: () => {
      hold = true
    },
    release: () => release?.(),
    holdAction: () => {
      holdAction = true
    },
    releaseAction: () => releaseAction?.(),
    target: (id: string | undefined) => {
      context = { ...context, workspace: id ? { ...workspace, id } : undefined }
      view.contextChanged()
    },
    result: (value: Value) => {
      actionResult = value
    },
  }
}
it('resolves selection internally and adds the accepted version with one action and visible destination', async () => {
  const f = fixture()
  f.view.select(f.selection)
  await f.ready()
  expect(document.getElementById('task-destination')?.title).toContain(
    'local: /owned-fixture/',
  )
  f.button('task-primary').click()
  await vi.waitFor(() => expect(f.actions).toHaveLength(1))
  expect(f.actions[0]).toMatchObject({
    action: 'add-copy',
    input: {
      skillId: f.status.skill.id,
      hash: f.status.skill.accepted_hash,
      agent: 'codex',
      mode: 'native',
    },
  })
  await vi.waitFor(() => expect(f.button('task-primary').textContent).toBe('Added'))
  expect(f.button('task-primary').disabled).toBe(true)
  expect(f.button('task-primary').hidden).toBe(true)
  expect(f.button('task-update').hidden).toBe(true)
})
it('describes an accepted version without claiming Add readiness before a destination is selected', async () => {
  const f = fixture()
  f.target(undefined)
  f.view.select(f.selection)
  await vi.waitFor(() => expect(f.button('task-refresh').disabled).toBe(false))
  expect(document.getElementById('task-destination')?.textContent).toContain(
    'Choose a project',
  )
  expect(f.button('task-primary').disabled).toBe(true)
  expect(f.actions).toEqual([])
  f.target('workspace')
  await f.ready()
  expect(document.getElementById('task-state')?.textContent).toBe('')
})
it('offers one primary Update for an outdated local Stub copy and reviews its exact target', async () => {
  const f = fixture()
  f.installed('stub')
  f.status.skill.exposures[0]!['source_hash'] = '0'.repeat(64)
  f.view.select(f.selection)
  await f.ready()
  expect(f.button('task-primary').textContent).toBe('Update')
  expect(f.button('task-primary').hidden).toBe(false)
  expect(f.button('task-update').hidden).toBe(true)
  f.button('task-primary').click()
  await vi.waitFor(() => expect(f.button('task-confirmation').hidden).toBe(false))
  expect(document.getElementById('task-confirm-target')?.textContent).toContain(
    f.preview[0].target,
  )
  expect(document.getElementById('task-effects')?.textContent).toContain('SKILL.md')
  expect(f.actions).toEqual([])
})
it('keeps a current project-bound copy quiet after refresh and presents affected files with one confirmation for mode changes', async () => {
  const f = fixture()
  f.installed()
  f.view.select(f.selection)
  await vi.waitFor(() => expect(f.button('task-primary').textContent).toBe('Added'))
  expect(f.button('task-primary').disabled).toBe(true)
  f.button('task-refresh').click()
  await vi.waitFor(() => expect(f.button('task-refresh').disabled).toBe(false))
  expect(f.button('task-primary').textContent).toBe('Added')
  f.changeMode('stub')
  await vi.waitFor(() =>
    expect((document.getElementById('task-confirmation') as HTMLElement).hidden).toBe(
      false,
    ),
  )
  expect(document.getElementById('task-effects')?.textContent).toContain('SKILL.md')
  expect(f.actions).toEqual([])
  expect(f.mode()).toBe('native')
  f.button('task-cancel').click()
  expect(f.actions).toEqual([])
  expect(f.mode()).toBe('native')
  f.changeMode('stub')
  await vi.waitFor(() =>
    expect((document.getElementById('task-confirmation') as HTMLElement).hidden).toBe(
      false,
    ),
  )
  f.button('task-confirm').click()
  await vi.waitFor(() => expect(f.actions).toHaveLength(1))
  expect(f.actions[0]).toMatchObject({
    action: 'change-exposure',
    input: { token: f.preview[0].preview.confirmation_token },
  })
})
it('invalidates an old preparation immediately on destination changes and ignores its late completion', async () => {
  const f = fixture()
  f.installed()
  f.view.select(f.selection)
  await vi.waitFor(() => expect(f.button('task-primary').textContent).toBe('Added'))
  f.hold()
  f.changeMode('stub')
  await vi.waitFor(() => expect(f.button('task-primary').disabled).toBe(true))
  f.target('other')
  f.release()
  await vi.waitFor(() => expect(f.button('task-primary').textContent).toBe('Added'))
  expect((document.getElementById('task-confirmation') as HTMLElement).hidden).toBe(true)
  expect(f.actions).toEqual([])
})
it('never leaves a stale Add enabled after failed observation and refreshes automatically after connection', async () => {
  const f = fixture()
  f.view.select(f.selection)
  await f.ready()
  f.fail()
  f.button('task-refresh').click()
  await vi.waitFor(() => expect(f.button('task-connect').hidden).toBe(false))
  expect(f.button('task-primary').disabled).toBe(true)
  f.button('task-connect').click()
  await f.ready()
  expect(f.button('task-connect').hidden).toBe(true)
})
it('settles a Library read-only decline through passive picker hide and return without replay', async () => {
  const f = fixture()
  f.projectRead(false)
  f.view.select(f.selection)
  await f.ready()
  expect(f.button('task-connect').hidden).toBe(false)
  f.button('task-connect').click()
  expect(f.requests.at(-1)).toEqual({
    capability: 'connector.connect',
    input: { connector: 'project-cli', source: 'project' },
  })
  f.visibility(false)
  f.visibility(true)
  f.connected({
    connections: [{ connector: 'project-cli', outcome: 'connected' }],
    source: { source: 'project', outcome: 'declined' },
    readiness: { program: true, source: false },
  })
  await vi.waitFor(() => expect(f.button('task-connect').disabled).toBe(false))
  expect(document.getElementById('task-state')?.textContent).toContain(
    'Project read access was not confirmed',
  )
  expect(f.requests.some((entry) => entry.capability === 'source.request')).toBe(false)
  expect(
    f.requests.filter((entry) => entry.capability === 'connector.connect'),
  ).toHaveLength(1)
  f.projectRead(true)
  f.button('task-connect').click()
  await vi.waitFor(() => expect(f.button('task-connect').hidden).toBe(true))
})
it('does not publish a Library connection result after the destination changes away and back', async () => {
  const f = fixture()
  f.projectRead(false)
  f.view.select(f.selection)
  await f.ready()
  f.button('task-connect').click()
  f.target('other')
  f.target('workspace')
  f.connected({
    connections: [{ connector: 'project-cli', outcome: 'connected' }],
    source: { source: 'project', outcome: 'granted' },
    readiness: { program: true, source: true },
  })
  await f.ready()
  expect(f.button('task-connect').hidden).toBe(false)
  expect(document.getElementById('task-state')?.textContent).toContain(
    'Project read access is not connected',
  )
})
it('describes a saved but withdrawn program as not ready in the Library task', async () => {
  const f = fixture()
  f.projectRead(false)
  f.view.select(f.selection)
  await f.ready()
  f.button('task-connect').click()
  f.connected({
    connections: [{ connector: 'project-cli', outcome: 'connected' }],
    source: { source: 'project', outcome: 'granted' },
    readiness: { program: false, source: true },
  })
  await vi.waitFor(() => expect(f.button('task-connect').disabled).toBe(false))
  expect(document.getElementById('task-state')?.textContent).toContain(
    'Program access was saved but is no longer ready',
  )
  expect(f.button('task-connect').hidden).toBe(false)
})
it('retains uncertainty for the exact source and target across selection and destination changes', async () => {
  const f = fixture()
  f.view.select(f.selection)
  await f.ready()
  f.result({
    outcome: 'uncertain',
    action: 'add-copy',
    operationId: 'owned-operation',
    message: 'Completion unknown',
  })
  f.button('task-primary').click()
  await vi.waitFor(() => expect(f.button('task-reconcile').hidden).toBe(false))
  f.target('other')
  await f.ready()
  f.target('workspace')
  await vi.waitFor(() =>
    expect(document.getElementById('task-state')?.textContent).toContain(
      'uncertain outcome',
    ),
  )
  expect(f.button('task-primary').disabled).toBe(true)
  expect(f.button('task-reconcile').hidden).toBe(false)
  f.recovered()
  f.button('task-refresh').click()
  await f.ready()
  expect(f.button('task-reconcile').hidden).toBe(true)
})

it('publishes a delayed verified Add result while the exact task stays current', async () => {
  const f = fixture()
  f.view.select(f.selection)
  await f.ready()
  f.holdAction()
  f.button('task-primary').click()
  await vi.waitFor(() => expect(f.actions).toHaveLength(1))
  expect(f.button('task-primary').disabled).toBe(true)
  expect(document.getElementById('task-result')?.textContent).toBe('')
  f.releaseAction()
  await vi.waitFor(() =>
    expect(JSON.parse(document.getElementById('task-result')!.textContent)).toMatchObject(
      {
        action: 'add-copy',
        outcome: 'verified',
        exposureId: f.preview[0].exposure_id,
        target: { hostId: 'local', path: f.preview[0].target },
      },
    ),
  )
  expect(f.button('task-primary').textContent).toBe('Added')
  expect(f.button('task-primary').hidden).toBe(true)
  expect(f.button('task-mode').disabled).toBe(false)
  expect(f.actions).toHaveLength(1)
})

it.each(['hidden', 'selection'] as const)(
  'rejects a delayed Add display after %s withdrawal and freshly observes the original task on return',
  async (withdrawal) => {
    const f = fixture()
    f.view.select(f.selection)
    await f.ready()
    f.holdAction()
    f.button('task-primary').click()
    await vi.waitFor(() => expect(f.actions).toHaveLength(1))
    if (withdrawal === 'hidden') f.visibility(false)
    else
      f.view.select({
        row: {
          id: 'original',
          source: 'project',
          kind: 'Project original',
          skillId: 'original',
          path: '/original/SKILL.md',
        },
      })
    f.installed()
    f.releaseAction()
    await vi.waitFor(() => expect(f.button('task-agent').disabled).toBe(false))
    expect(document.getElementById('task-result')?.textContent).toBe('')
    if (withdrawal === 'hidden') f.visibility(true)
    else f.view.select(f.selection)
    await vi.waitFor(() => expect(f.button('task-primary').textContent).toBe('Added'))
    expect(f.button('task-primary').hidden).toBe(true)
    expect(document.getElementById('task-result')?.textContent).toBe('')
    expect(f.actions).toHaveLength(1)
  },
)

it('uses the canonical skill identity while retaining a searched occurrence selection', async () => {
  const f = fixture()
  f.view.select({
    ...f.selection,
    row: {
      ...f.selection.row,
      id: 'search-occurrence-hash',
      canonical: { library_id: f.selection.library.id, skill_id: f.selection.row.id },
    },
  })
  await f.ready()
  f.button('task-primary').click()
  await vi.waitFor(() => expect(f.actions).toHaveLength(1))
  expect(f.actions[0]).toMatchObject({
    action: 'add-copy',
    input: { skillId: f.selection.row.id },
  })
})

it.each(['foreign-library', 'stale-entrypoint'])(
  'refuses a same-name searched occurrence with %s identity',
  async (mismatch) => {
    const f = fixture()
    f.view.select({
      ...f.selection,
      row: {
        ...f.selection.row,
        id: 'same-name-occurrence',
        name: 'Same visible name',
        path:
          mismatch === 'stale-entrypoint'
            ? '/old/library/SKILL.md'
            : f.selection.row.path,
        canonical: {
          library_id:
            mismatch === 'foreign-library'
              ? '00000000-0000-4000-8000-000000000000'
              : f.selection.library.id,
          skill_id: f.selection.row.id,
        },
      },
    })
    await vi.waitFor(() =>
      expect(document.getElementById('task-state')?.textContent).toMatch(
        /different library|moved or is unavailable/,
      ),
    )
    expect(f.button('task-primary').disabled).toBe(true)
    expect(f.actions).toEqual([])
  },
)

it('keeps the actual Full mode through review, cancellation, failure and context changes', async () => {
  const f = fixture()
  f.installed('native')
  f.view.select(f.selection)
  await vi.waitFor(() => expect(f.button('task-primary').textContent).toBe('Added'))
  expect(f.mode()).toBe('native')
  f.changeMode('stub')
  await vi.waitFor(() => expect(f.button('task-confirmation').hidden).toBe(false))
  expect(f.mode()).toBe('native')
  f.button('task-cancel').click()
  expect(f.mode()).toBe('native')
  f.changeMode('stub')
  await vi.waitFor(() => expect(f.button('task-confirmation').hidden).toBe(false))
  f.result({ outcome: 'failed', message: 'Local edits preserved' })
  f.button('task-confirm').click()
  await vi.waitFor(() => expect(f.button('task-refresh').disabled).toBe(false))
  expect(f.mode()).toBe('native')
  f.visibility(false)
  f.visibility(true)
  await vi.waitFor(() => expect(f.button('task-refresh').disabled).toBe(false))
  expect(f.mode()).toBe('native')
  f.target('another')
  await vi.waitFor(() => expect(f.button('task-primary').textContent).toBe('Added'))
  expect(f.mode()).toBe('native')
  f.installed('native', 'claude')
  f.changeAgent('claude')
  await vi.waitFor(() => expect(f.mode()).toBe('native'))
})
it('keeps admission failures actionable and does not invent an uncertain submitted operation', async () => {
  const f = fixture()
  f.view.select(f.selection)
  await f.ready()
  f.actionError('This view is hidden before submission')
  f.button('task-primary').click()
  await vi.waitFor(() =>
    expect(document.getElementById('task-state')?.textContent).toContain(
      'hidden before submission',
    ),
  )
  expect(f.button('task-reconcile').hidden).toBe(true)
  expect(f.button('task-primary').disabled).toBe(false)
  f.button('task-refresh').click()
  await f.ready()
  expect(f.button('task-reconcile').hidden).toBe(true)
})
it('preserves CLI failures mentioning connection or grants when structured connection state is supported', async () => {
  const f = fixture()
  f.failureMessage('Connection index has corrupt grant metadata')
  f.view.select(f.selection)
  await vi.waitFor(() =>
    expect(document.getElementById('task-state')?.textContent).toBe(
      'Connection index has corrupt grant metadata',
    ),
  )
  expect(f.button('task-connect').hidden).toBe(true)
  expect(f.button('task-primary').disabled).toBe(true)
})
it.each(['library', 'source', 'workspace', 'target', 'agent'])(
  'does not borrow a pending operation with a different %s binding',
  async (part) => {
    const f = fixture()
    f.installed()
    const operation = {
      library: {
        id: f.selection.library.id,
        root: { hostId: 'local', path: f.selection.library.root },
      },
      source: { id: f.selection.row.id },
      workspace: {
        id: 'workspace',
        host: 'local',
        root: { hostId: 'local', path: f.preview[0].preview.project },
      },
      target: { hostId: 'local', path: f.preview[0].target },
      agent: 'codex',
    } as Value
    if (part === 'agent') operation[part] = 'claude'
    else
      operation[part] = {
        ...(operation[part] as Value),
        [part === 'target' ? 'path' : 'id']: 'another',
      }
    f.pending({ id: 'unrelated', operation })
    f.view.select(f.selection)
    await vi.waitFor(() => expect(f.button('task-primary').textContent).toBe('Added'))
    expect(f.button('task-reconcile').hidden).toBe(true)
    f.changeMode('stub')
    await vi.waitFor(() => expect(f.button('task-confirmation').hidden).toBe(false))
  },
)

it('acknowledges exact fresh recovery facts through the operation owner without replaying the mutation', async () => {
  const f = fixture()
  f.view.select(f.selection)
  await f.ready()
  f.result({
    outcome: 'uncertain',
    operationId: 'submitted',
    message: 'Unknown completion',
  })
  f.button('task-primary').click()
  await vi.waitFor(() => expect(f.button('task-reconcile').hidden).toBe(false))
  f.button('task-reconcile').click()
  await vi.waitFor(() => expect(f.button('task-confirm').textContent).toBe('Acknowledge'))
  expect(f.actions).toHaveLength(1)
  f.button('task-confirm').click()
  await f.ready()
  expect(f.recovery).toContainEqual({
    mode: 'acknowledge',
    operationId: 'submitted',
    observation: JSON.stringify({ target: f.preview[0].target, current: true }),
  })
  expect(f.actions).toHaveLength(1)
  expect(f.button('task-reconcile').hidden).toBe(true)
})

it('reobserves retained exact pending facts after a lost action reply before allowing a retry', async () => {
  const f = fixture()
  f.view.select(f.selection)
  await f.ready()
  f.result({ outcome: 'uncertain', operationId: 'physically-submitted' })
  f.actionError('The submitted reply was lost')
  f.button('task-primary').click()
  await vi.waitFor(() =>
    expect(document.getElementById('task-state')?.textContent).toBe(
      'The submitted reply was lost',
    ),
  )
  expect(f.button('task-reconcile').hidden).toBe(false)
  expect(f.button('task-primary').disabled).toBe(true)
  expect(f.actions).toHaveLength(1)
})
it('keeps independent source review and one acceptance available before project connection', async () => {
  const f = fixture()
  f.status.skill.acceptance = 'pending'
  f.fail()
  f.view.select(f.selection)
  await vi.waitFor(() => expect(f.button('accept-version').disabled).toBe(false))
  expect(f.button('task-primary').hidden).toBe(true)
  expect(f.button('task-connect').hidden).toBe(false)
  f.button('accept-version').click()
  await vi.waitFor(() => expect(f.actions).toHaveLength(1))
  expect(f.actions[0]).toMatchObject({ action: 'accept-version' })
  await vi.waitFor(() =>
    expect(f.button('task-primary').textContent).toBe('Add to project'),
  )
  expect(f.button('task-primary').disabled).toBe(true)
  expect(f.button('task-connect').hidden).toBe(false)
  expect(document.getElementById('task-state')?.textContent).not.toContain(
    'Version accepted',
  )
  expect(document.getElementById('task-state')?.textContent).toContain(
    'Connect Skillager for this project',
  )
  expect(
    f.executions.every((execution) => execution['connector'] === 'library-cli'),
  ).toBe(true)
})

it('settles unknown combined readiness in Library without claiming revocation or replaying consent', async () => {
  const f = fixture()
  f.projectRead(false)
  f.view.select(f.selection)
  await f.ready()
  f.button('task-connect').click()
  f.connected({
    connections: [{ connector: 'project-cli', outcome: 'connected' }],
    source: { source: 'project', outcome: 'unavailable' },
    readiness: { program: null, source: null },
  })
  await vi.waitFor(() => expect(f.button('task-connect').disabled).toBe(false))
  expect(document.getElementById('task-state')?.textContent).toContain(
    'Connection ended before access could be confirmed',
  )
  expect(document.getElementById('task-state')?.textContent).not.toContain(
    'no longer ready',
  )
  expect(f.button('task-connect').hidden).toBe(false)
  expect(
    f.requests.filter((entry) => entry.capability === 'connector.connect'),
  ).toHaveLength(1)
  expect(f.requests.some((entry) => entry.capability === 'source.request')).toBe(false)
})

it('binds the selected managed occurrence to its actual agent and target independently of Library Add choices', async () => {
  const f = fixture()
  ;(document.getElementById('task-agent') as HTMLSelectElement).value = 'claude'
  f.installed('native', 'codex')
  f.view.select(f.projectSelection())
  await vi.waitFor(() => expect(f.button('task-mode').disabled).toBe(false))
  expect(f.button('task-agent').disabled).toBe(true)
  expect(document.getElementById('task-agent-name')?.textContent).toBe('codex')
  expect(f.button('task-primary').hidden).toBe(true)
  const observation = f.executions.find((entry) =>
    (entry['args'] as string[]).includes('--list'),
  )!
  expect(observation['args']).toEqual([
    'expose',
    '--list',
    '--agent',
    'codex',
    '--scope',
    'project',
    '--json',
  ])
  f.changeMode('stub')
  await vi.waitFor(() => expect(f.button('task-confirmation').hidden).toBe(false))
  expect(f.mode()).toBe('native')
  expect(f.actions).toHaveLength(0)
  f.button('task-confirm').click()
  await vi.waitFor(() => expect(f.actions).toHaveLength(1))
  const input = f.actions[0]!['input'] as Value
  expect(input['agent']).toBe('codex')
  expect(JSON.parse(input['request'] as string)).toMatchObject({
    exposureId: f.preview[0].exposure_id,
    target: { hostId: 'local', path: f.preview[0].target },
    mode: 'stub',
  })
  await vi.waitFor(() => expect(f.mode()).toBe('stub'))
})
it('refuses a same-skill copy at another target and never converts it into Add', async () => {
  const f = fixture()
  f.installed()
  f.view.select(f.projectSelection('codex', '/owned-fixture/different-copy'))
  await vi.waitFor(() =>
    expect(document.getElementById('task-state')?.textContent).toContain(
      'no longer available',
    ),
  )
  expect(f.button('task-primary').hidden).toBe(true)
  expect(f.button('task-remove').hidden).toBe(true)
  expect(f.actions).toEqual([])
})
it('retains an original external identity without inventing a canonical task', () => {
  const f = fixture()
  f.view.select({
    row: {
      id: 'external-occurrence',
      skillId: 'codex/project/original',
      source: 'project',
      path: '/project/.agents/skills/original/OTHER.md',
      host: 'local',
      workspaceId: 'workspace',
    },
  })
  expect(document.getElementById('selected-task')?.hidden).toBe(true)
  expect(f.executions).toEqual([])
  expect(f.actions).toEqual([])
})
