// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { importContractFixture, type ImportPreview } from './fixtures/skillager-import'
import { fixture as selectedTaskFixture } from './fixtures/skillager-selected-task'
type Value = Record<string, unknown>
let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  document.body.replaceChildren()
})
function fixture(external?: ImportPreview) {
  const f = selectedTaskFixture(external)
  dispose = f.dispose
  return f
}

it('keeps canonical original tasks and offers Save as in the same task area without adoption', async () => {
  const f = fixture(importContractFixture().preview),
    external = f.external!,
    linked = f.projectSelection().row
  f.view.select({
    row: {
      id: 'linked-original',
      source: 'project',
      kind: 'Project original',
      host: linked.host,
      workspaceId: linked.workspaceId,
      canonical: linked.canonical,
      skillId: external.source.id,
      path: external.source.file,
    },
  })
  await f.ready()
  expect(f.button('selected-task').hidden).toBe(false)
  expect(f.button('selected-import').hidden).toBe(true)
  expect(f.button('task-save-original').hidden).toBe(false)
  expect(f.button('task-remove').hidden).toBe(true)
  f.button('task-save-original').click()
  await vi.waitFor(() => expect(f.button('import-save').disabled).toBe(false))
  expect(f.button('selected-task').hidden).toBe(true)
  expect(f.button('selected-import').hidden).toBe(false)
  expect(f.button('import-use-library').hidden).toBe(false)
  const name = document.getElementById('import-name') as HTMLInputElement
  name.value = 'separate-copy'
  name.dispatchEvent(new Event('input'))
  external.destination.name = 'separate-copy'
  external.destination.id = external.review_manifest.destination_id = 'lib/separate-copy'
  external.destination.path =
    external.review_manifest.destination_path = `${external.library.root}/skills/separate-copy`
  external.next_command_argv[external.next_command_argv.indexOf('--as') + 1] =
    'separate-copy'
  f.button('import-refresh').click()
  await vi.waitFor(() => expect(f.button('import-save').disabled).toBe(false))
  f.button('import-save').click()
  await vi.waitFor(() =>
    expect(f.actions.at(-1)).toMatchObject({
      action: 'save-and-accept',
      input: {
        name: 'separate-copy',
        skillId: external.source.id,
        file: { hostId: 'local', path: external.source.file },
      },
    }),
  )
  f.button('import-use-library').click()
  await f.ready()
  expect(f.button('selected-task').hidden).toBe(false)
  expect(f.button('selected-import').hidden).toBe(true)
  expect(f.actions).toHaveLength(1)
})
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
