// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { fixture as selectedTaskFixture } from './fixtures/skillager-selected-task'
let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  document.body.replaceChildren()
})
function fixture() {
  const f = selectedTaskFixture(undefined, true)
  dispose = f.dispose
  return f
}
const result = () => document.getElementById('task-result')!.textContent

it.each(
  ['add', 'change', 'remove'].flatMap((action) =>
    [false, true].map((early) => ({ action, early })),
  ),
)(
  'retains the real composed $action result and current controls (early return=$early)',
  async ({ action, early }) => {
    const f = fixture()
    if (action !== 'add') f.installed()
    f.view.select(f.selection)
    await vi.waitFor(() => expect(f.button('task-mode').disabled).toBe(false))
    if (action === 'change') f.changeMode('stub')
    if (action === 'remove') f.button('task-remove').click()
    if (action !== 'add')
      await vi.waitFor(() => expect(f.button('task-confirmation').hidden).toBe(false))
    f.holdAction()
    f.button(action === 'add' ? 'task-primary' : 'task-confirm').click()
    await vi.waitFor(() => expect(f.actions).toHaveLength(1))
    f.show(false)
    if (early) f.show(true)
    f.releaseAction()
    await vi.waitFor(() => expect(f.view.submitted).toBe(false))
    expect(JSON.parse(result())).toMatchObject({ outcome: 'verified' })
    const previews = f.executions.filter((entry) =>
      (entry['args'] as string[]).includes('--dry-run'),
    ).length
    if (!early) f.show(true, true)
    await vi.waitFor(() => expect(f.button('task-mode').disabled).toBe(false))
    expect(f.button('task-primary').textContent).toBe(
      action === 'remove' ? 'Add to project' : 'Added',
    )
    expect(f.button('task-remove').hidden).toBe(action === 'remove')
    expect(f.mode()).toBe(action === 'change' ? 'stub' : 'native')
    expect(JSON.parse(result())).toMatchObject({ outcome: 'verified' })
    expect(f.actions).toHaveLength(1)
    expect(
      f.executions.filter((entry) => (entry['args'] as string[]).includes('--dry-run')),
    ).toHaveLength(previews)
    expect(f.button('task-confirmation').hidden).toBe(true)
  },
)

it.each(['uncertain', 'refused', 'rejected'] as const)(
  'keeps a composed %s outcome after showing before physical settlement',
  async (outcome) => {
    const f = fixture()
    f.view.select(f.selection)
    await f.ready()
    if (outcome === 'rejected') f.actionError('Reviewed source changed')
    else
      f.result({
        outcome,
        operationId: 'exact-pending-operation',
        message: 'Exact terminal outcome',
      })
    f.holdAction()
    f.button('task-primary').click()
    await vi.waitFor(() => expect(f.actions).toHaveLength(1))
    f.show(false)
    f.show(true)
    expect(f.view.submitted).toBe(true)
    expect(f.button('task-primary').disabled).toBe(true)
    f.button('task-primary').click()
    expect(f.actions).toHaveLength(1)
    f.releaseAction()
    await vi.waitFor(() => expect(f.view.submitted).toBe(false))
    await vi.waitFor(() =>
      expect(document.getElementById('task-state')!.textContent).toContain(
        outcome === 'rejected' ? 'Reviewed source changed' : 'Exact terminal outcome',
      ),
    )
    if (outcome === 'uncertain') {
      await vi.waitFor(() => expect(f.button('task-reconcile').hidden).toBe(false))
      expect(result()).toContain('exact-pending-operation')
      expect(f.button('task-primary').disabled).toBe(true)
    } else await f.ready()
    expect(f.actions).toHaveLength(1)
    expect(f.button('task-confirmation').hidden).toBe(true)
  },
)

it('quarantines a composed late result after a real workspace change, even when returning to its prior id', async () => {
  const f = fixture()
  f.view.select(f.selection)
  await f.ready()
  f.holdAction()
  f.button('task-primary').click()
  await vi.waitFor(() => expect(f.actions).toHaveLength(1))
  f.target('other')
  f.target('workspace')
  f.releaseAction()
  await vi.waitFor(() => expect(f.view.submitted).toBe(false))
  expect(result()).toBe('')
  expect(f.changed.mock.calls.at(-1)?.[1]).toMatchObject({ id: 'workspace' })
  expect(f.actions).toHaveLength(1)
})
