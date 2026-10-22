// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { createSkillagerPackageView } from './fixtures/skillager-package-view'
import { projectImportFixture } from './fixtures/skillager-project-import'

let close: (() => void) | undefined
afterEach(() => {
  close?.()
  document.body.replaceChildren()
  vi.useRealTimers()
})
it('keeps whole-project eligibility independent of filter, page, selected reader and Library scope', async () => {
  const data = projectImportFixture(),
    f = createSkillagerPackageView('project')
  close = f.dispose
  f.projectImportInventory(data.inventory)
  const item = data.inventory.items[0]!
  f.projectInventory({
    schema: 'skillager.list.v1',
    scope: 'project',
    project_root: data.workspace.root.path,
    observation: { status: 'complete', errors: [], error_count: 0 },
    skills: [
      {
        id: item.id,
        occurrence_id: item.occurrence_id,
        name: item.name,
        description: item.description,
        status: 'pending',
        trust: 'discovered',
        skill_file: item.skill_file,
        kind: 'native',
        native: { scope: 'project', managed: false, agent: null },
        exposure: null,
      },
    ],
    next_cursor: 'next',
  })
  f.context(true, data.workspace)
  await f.flush()
  const counts = () => f.calls.filter((args) => args[0] === 'import-project').length
  expect(counts()).toBe(1)
  expect(document.getElementById('project-save-count')!.textContent).toBe(
    '2 skills ready to save',
  )
  ;(document.getElementById('query') as HTMLInputElement).value = 'filtered'
  document
    .getElementById('search-form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await f.flush()
  f.button('next').click()
  await f.flush()
  document.querySelector<HTMLButtonElement>('[data-skill-select]')!.click()
  await f.flush()
  expect(counts()).toBe(1)
  f.button('scope-library').click()
  await f.flush()
  expect(document.getElementById('project-save-entry')!.hidden).toBe(true)
  f.button('scope-project').click()
  await f.flush()
  expect(counts()).toBe(1)
  expect(document.getElementById('project-save-entry')!.hidden).toBe(false)
  f.button('refresh').click()
  await f.flush()
  expect(counts()).toBe(2)
})
