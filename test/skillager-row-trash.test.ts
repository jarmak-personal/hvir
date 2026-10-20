// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { createSkillagerPackageView } from './fixtures/skillager-package-view'

const workspace = {
  id: 'project',
  host: 'local',
  root: { hostId: 'local', path: '/project' },
}
const original = {
  id: 'project/example',
  occurrence_id: 'observed-original',
  name: 'Example',
  description: 'An original',
  status: 'pending',
  trust: 'discovered',
  skill_file: '/project/.agents/skills/example/CUSTOM.md',
  kind: 'native',
  native: { scope: 'project', managed: false, agent: 'codex' },
  exposure: null,
}
const inventory = (skills: unknown[] = [original]) => ({
  schema: 'skillager.list.v1',
  scope: 'project',
  project_root: '/project',
  observation: { status: 'complete', errors: [], error_count: 0 },
  skills,
  next_cursor: null,
})
let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  document.body.replaceChildren()
  vi.useRealTimers()
})
const el = (id: string) => document.getElementById(id)!
const row = () => document.querySelector<HTMLButtonElement>('[data-skill-select]')!
const more = () => document.querySelector<HTMLButtonElement>('[data-skill-actions]')!
async function setup() {
  const f = createSkillagerPackageView('project')
  dispose = f.dispose
  f.projectInventory(inventory())
  f.context(true, workspace)
  await f.flush()
  return f
}
function remove() {
  more().click()
  document.querySelector<HTMLButtonElement>('#skill-row-menu [data-task=remove]')!.click()
}
it('requests only the trusted Files decision, then refreshes the same query after completion', async () => {
  const f = await setup()
  const query = el('query') as HTMLInputElement
  query.value = 'Example'
  el('search-form').dispatchEvent(
    new Event('submit', { bubbles: true, cancelable: true }),
  )
  await f.flush()
  const before = f.requests.length
  more().click()
  expect(f.requests.length).toBe(before)
  expect(f.opened).toEqual([])
  document.querySelector<HTMLButtonElement>('#skill-row-menu [data-task=remove]')!.click()
  await f.flush()
  expect(f.requests.slice(before)).toEqual([
    {
      capability: 'source.request-trash',
      input: {
        source: 'project',
        workspaceId: 'project',
        path: { hostId: 'local', path: '/project/.agents/skills/example' },
      },
    },
  ])
  expect(row()).not.toBeNull()
  expect(f.button('skill-task-close').disabled).toBe(true)
  expect(f.button('scope-library').disabled).toBe(true)
  row().click()
  expect(f.opened).toEqual([])
  f.projectInventory(inventory([]))
  f.trashResult({ outcome: 'completed' })
  await f.flush()
  expect(row()).toBeNull()
  expect(query.value).toBe('Example')
  expect(f.calls.at(-1)).toContain('--query')
  expect(f.calls.at(-1)).toContain('Example')
  expect(el('skill-task-message').textContent).toBe('Moved to Trash.')
  expect(f.button('skill-task-close').disabled).toBe(false)
})
it.each(['cancelled', 'refused', 'uncertain'])(
  'retains the observed row after %s and never retries removal',
  async (outcome) => {
    const f = await setup()
    remove()
    await f.flush()
    f.trashResult({
      outcome,
      reason: outcome === 'cancelled' ? undefined : 'Keep the current files.',
    })
    await f.flush()
    expect(row()).not.toBeNull()
    expect(el('skill-task-message').textContent).toBe(
      outcome === 'cancelled' ? 'Cancelled.' : 'Keep the current files.',
    )
    expect(
      f.requests.filter((r) => r.capability === 'source.request-trash'),
    ).toHaveLength(1)
    expect(f.calls.filter((args) => args[0] === 'list')).toHaveLength(2)
  },
)
it('retires a hidden pending sheet and reobserves the same context after the delayed result', async () => {
  const f = await setup()
  remove()
  await f.flush()
  f.context(false, workspace)
  expect(el('skill-task-sheet').hidden).toBe(true)
  const before = f.calls.length
  f.projectInventory(inventory([]))
  f.trashResult({ outcome: 'completed' })
  await f.flush()
  expect(f.calls.length).toBe(before)
  expect(el('skill-task-sheet').hidden).toBe(true)
  f.context(true, workspace)
  await f.flush()
  expect(row()).toBeNull()
  expect(el('skill-task-sheet').hidden).toBe(true)
})
it('does not attribute an old removal result to a different workspace', async () => {
  const f = await setup()
  remove()
  await f.flush()
  f.projectInventory({ ...inventory([]), project_root: '/other' })
  f.context(true, {
    ...workspace,
    id: 'other',
    root: { hostId: 'local', path: '/other' },
  })
  await f.flush()
  const before = f.calls.length
  f.trashResult({ outcome: 'completed' })
  await f.flush()
  expect(f.calls.length).toBe(before)
  expect(el('skill-task-sheet').hidden).toBe(true)
})
