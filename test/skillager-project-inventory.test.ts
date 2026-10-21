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
const workspace = {
  id: 'selected-project',
  host: 'local',
  root: { hostId: 'local', path: '/selected' },
}
const original = {
  id: 'project/example',
  occurrence_id: 'project:observed-original',
  name: 'Example skill',
  description: 'A pending project skill',
  status: 'pending',
  trust: 'discovered',
  skill_file: '/selected/.agents/skills/example/SKILL.md',
  kind: 'native',
  native: { scope: 'project', managed: false, agent: null },
  exposure: null,
}
const inventory = (skills: unknown[] = [original]) => ({
  schema: 'skillager.list.v1',
  scope: 'project',
  project_root: '/selected',
  observation: { status: 'complete', errors: [] as unknown[], error_count: 0 },
  skills,
  next_cursor: null as string | null,
})
function view(data = inventory()) {
  const f = createSkillagerPackageView('project')
  close = f.dispose
  f.projectInventory(data)
  return f
}
const rows = () => [
  ...document.querySelectorAll<HTMLButtonElement>('#skills [data-skill-select]'),
]
const state = () => document.getElementById('state')!

it('automatically lists and selects the exact pending project occurrence through the connected public bridge', async () => {
  const f = view()
  f.context(true, workspace)
  await f.flush()
  expect(rows().map((row) => row.textContent)).toEqual([
    'Example skillA pending project skillProject original',
  ])
  expect(f.calls).toEqual([
    ['--version'],
    ['list', '--scope', 'project', '--json', '--limit', '100'],
    ['import-project', '--json', '--limit', '100'],
  ])
  expect(
    f.requests.filter(({ capability }) => capability === 'connector.connect'),
  ).toEqual([])
  rows()[0]!.click()
  await f.flush()
  expect(f.opened).toMatchObject([
    {
      contributionId: 'detail',
      input: {
        row: {
          id: original.occurrence_id,
          skillId: original.id,
          path: original.skill_file,
          source: 'project',
          host: 'local',
          workspaceId: workspace.id,
          status: 'pending',
          kind: 'Project original',
        },
      },
    },
  ])
  expect(f.opened[0]).not.toHaveProperty('input.row.canonical')
  expect(f.initializationRequests).toEqual([])
  expect(f.calls.some((args) => ['review', 'expose', 'setup'].includes(args[0]!))).toBe(
    false,
  )
})

it('uses the CLI page cursor without merging or repeating managed copies', async () => {
  const first = inventory()
  first.next_cursor = 'opaque-managed-page'
  const f = view(first)
  f.context(true, workspace)
  await f.flush()
  const managed = {
    ...original,
    id: 'lib/example',
    occurrence_id: 'project:managed-copy',
    name: 'Managed example',
    skill_file: '/selected/.claude/skills/managed/SKILL.md',
    kind: 'stub',
    status: 'present',
    trust: null,
    native: { scope: 'project', managed: true, agent: 'claude' },
    exposure: {
      schema: 'skillager.exposure.v1',
      exposure_id: 'copy-id',
      agent: 'claude',
      scope: 'project',
      mode: 'stub',
      target: '/selected/.claude/skills/managed',
      skill_id: 'lib/example',
      source_library_id: '720e24b1-53e0-45f6-a84e-3df65177b38c',
    },
  }
  f.projectInventory(inventory([managed]))
  f.button('next').click()
  await f.flush()
  expect(rows()).toHaveLength(1)
  expect(rows()[0]?.dataset.id).toBe(managed.occurrence_id)
  expect(f.calls.at(-1)).toEqual([
    'list',
    '--scope',
    'project',
    '--json',
    '--limit',
    '100',
    '--cursor',
    'opaque-managed-page',
  ])
  rows()[0]!.click()
  await f.flush()
  expect(f.opened[0]).toMatchObject({
    input: {
      row: {
        id: managed.occurrence_id,
        skillId: managed.id,
        path: managed.skill_file,
        kind: 'Installed Stub',
        status: 'present',
        exposure: {
          exposure_id: managed.exposure.exposure_id,
          skill_id: managed.id,
          agent: 'claude',
          scope: 'project',
          mode: 'stub',
          target: managed.exposure.target,
          source_library_id: managed.exposure.source_library_id,
        },
        canonical: {
          library_id: managed.exposure.source_library_id,
          skill_id: 'lib/example',
        },
      },
    },
  })
  f.projectInventory(first)
  f.button('previous').click()
  await f.flush()
  expect(rows().map((row) => row.dataset.id)).toEqual([original.occurrence_id])
  expect(f.button('previous').disabled).toBe(true)
})

it.each([0, 1])(
  'distinguishes partial discovery with %i rows from a complete empty project',
  async (count) => {
    const partial = inventory(count ? [original] : [])
    partial.observation = {
      status: 'partial',
      errors: [{ code: 'skill-unreadable', path: '/selected/.agents/skills/unreadable' }],
      error_count: 1,
    }
    const f = view(partial)
    f.context(true, workspace)
    await f.flush()
    expect(rows()).toHaveLength(count)
    expect(state().textContent).toContain('Some project skills could not be loaded')
    expect(state().dataset.state).toBe('partial')
    expect(state().textContent).not.toContain('skill-unreadable')
    expect(document.getElementById('observation-details')?.textContent).toContain(
      'skill-unreadable',
    )
    f.projectInventory(inventory([]))
    f.button('refresh').click()
    await f.flush()
    expect(state().textContent).toBe('No skills in this project.')
    expect(state().dataset.state).toBe('empty')
    expect(document.getElementById('observation-details')?.textContent).not.toContain(
      'skill-unreadable',
    )
  },
)

it('retains prior rows with concise failure text without claiming a complete empty project', async () => {
  const f = view()
  f.context(true, workspace)
  await f.flush()
  f.fail('list')
  f.button('refresh').click()
  await f.flush()
  expect(rows()).toHaveLength(1)
  expect(state().dataset.state).toBe('stale')
  expect(state().textContent).toBe(
    'Could not refresh project skills. Showing the last result.',
  )
  expect(document.getElementById('observation-details')?.textContent).toContain('exit 1')
})

it.each(['hide', 'workspace', 'root', 'host'] as const)(
  'rejects delayed inventory after %s changes',
  async (change) => {
    const f = view()
    f.hold('list')
    f.context(true, workspace)
    await f.flush()
    if (change === 'hide') f.context(false, workspace)
    else {
      const next =
        change === 'workspace'
          ? { ...workspace, id: 'other' }
          : change === 'root'
            ? { ...workspace, root: { hostId: 'local', path: '/other' } }
            : { ...workspace, host: 'ssh', root: { hostId: 'ssh', path: '/selected' } }
      f.projectInventory({
        ...inventory([]),
        project_root: change === 'root' ? '/other' : '/selected',
      })
      f.context(true, next)
    }
    f.resume()
    await f.flush()
    expect(rows()).toEqual([])
    expect(f.opened).toEqual([])
  },
)

it('names the required update when the installed CLI does not support project inventory', async () => {
  const f = view()
  f.unsupportedProjectScope()
  f.context(true, workspace)
  await f.flush()
  expect(rows()).toEqual([])
  expect(state().dataset.state).toBe('update-required')
  expect(state().textContent).toContain('Update Skillager')
  expect(document.getElementById('program-setup')?.hidden).toBe(false)
  expect(document.getElementById('observation-details')?.textContent).toContain('0.9.7')
  expect(
    f.requests.some(
      ({ capability, input }) =>
        capability === 'connector.output' && input.release === true,
    ),
  ).toBe(true)
  expect(f.initializationRequests).toEqual([])
})

it.each([false, true])(
  'distinguishes unavailable project observation from unsupported scope with retained rows %s',
  async (retained) => {
    const f = view()
    if (!retained) f.unavailableProject()
    f.context(true, workspace)
    await f.flush()
    if (retained) {
      expect(rows()).toHaveLength(1)
      f.unavailableProject()
      f.button('refresh').click()
      await f.flush()
    }
    expect(rows()).toHaveLength(retained ? 1 : 0)
    expect(state().dataset.state).toBe(retained ? 'stale' : 'failed-observation')
    expect(state().textContent).toBe(
      retained
        ? 'Could not refresh project skills. Showing the last result.'
        : 'Could not load skills in this project.',
    )
    expect(document.getElementById('program-setup')?.hidden).toBe(true)
    expect(document.getElementById('observation-details')?.textContent).toContain(
      'exit 2',
    )
    expect(document.getElementById('observation-details')?.textContent).toContain(
      'The selected project could not be observed.',
    )
    expect(f.initializationRequests).toEqual([])
  },
)

it('filters the project inventory before opaque pagination without importing library results', async () => {
  const first = inventory()
  first.next_cursor = 'filtered-next'
  const f = view(first)
  f.context(true, workspace)
  await f.flush()
  const input = document.getElementById('query') as HTMLInputElement
  input.value = 'pending project'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  const before = f.calls.length
  await f.flush()
  expect(f.calls).toHaveLength(before)
  document
    .getElementById('search-form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await f.flush()
  expect(f.calls.at(-1)).toEqual([
    'list',
    '--scope',
    'project',
    '--json',
    '--limit',
    '100',
    '--query',
    'pending project',
  ])
  expect(rows()[0]?.dataset.id).toBe(original.occurrence_id)
  f.projectInventory(inventory([]))
  f.button('next').click()
  await f.flush()
  expect(f.calls.at(-1)).toEqual([
    'list',
    '--scope',
    'project',
    '--json',
    '--limit',
    '100',
    '--query',
    'pending project',
    '--cursor',
    'filtered-next',
  ])
  expect(f.calls.some((args) => args[0] === 'search')).toBe(false)
  expect(rows()).toHaveLength(0)
  expect(state().textContent).toContain('No matches')
})

it('names the required project query capability when inventory works but filtering is unsupported', async () => {
  const f = view()
  f.unsupportedProjectQuery()
  f.context(true, workspace)
  await f.flush()
  ;(document.getElementById('query') as HTMLInputElement).value = 'example'
  document
    .getElementById('search-form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await f.flush()
  expect(state().dataset.state).toBe('stale')
  expect(state().textContent).toContain('Update Skillager')
  expect(document.getElementById('observation-details')?.textContent).toContain(
    'Project filtering requires Skillager 0.9.7 or a supported source build with list --scope project --query.',
  )
  expect(rows()[0]?.dataset.id).toBe(original.occurrence_id)
  expect(f.calls.some((args) => args[0] === 'search')).toBe(false)
})
