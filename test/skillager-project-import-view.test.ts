// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { projectImportViewFixture } from './fixtures/skillager-project-import-view'

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})
function setup(eligible = 2, managed = 0) {
  const f = projectImportViewFixture(eligible, managed)
  dispose = f.dispose
  return f
}
it('observes global eligibility once and prepares all off-page originals in one review', async () => {
  const f = setup(4, 220)
  await f.view.observe()
  expect(document.getElementById('project-save-count')!.textContent).toBe(
    '4 skills ready to save',
  )
  await f.view.observe()
  expect(f.commands()).toHaveLength(1)
  await f.view.open()
  expect(f.checkboxes()).toHaveLength(4)
  expect(f.checkboxes().every((input) => input.checked)).toBe(true)
  expect(f.commands()).toHaveLength(2)
  expect(f.button('save').textContent).toBe('Save 4 skills')
  expect(f.button('save').disabled).toBe(false)
  expect(f.saves()).toHaveLength(0)
  expect(document.getElementById('instructions')!.textContent).toBe('Keep reading')
  f.view.invalidate()
  await f.view.observe()
  expect(f.commands()).toHaveLength(3)
})
it('reobserves invalidation during an opening read before proposing all current skills', async () => {
  const f = setup()
  f.holdInventory(2)
  const opening = f.view.open()
  await f.flush()
  f.all.pop()
  f.inventory.summary.total = f.inventory.summary.eligible = 1
  f.inventory.default_selection.pop()
  f.view.invalidate()
  void f.view.observe()
  expect(f.commands()).toHaveLength(1)
  expect(f.button('save').disabled).toBe(true)
  f.inventoryResult()
  await f.flush()
  expect(f.commands()).toHaveLength(2)
  expect(document.getElementById('project-save-count')!.textContent).not.toContain(
    '2 skills',
  )
  expect(f.checkboxes()).toHaveLength(0)
  expect(f.button('save').disabled).toBe(true)
  f.inventoryResult()
  await opening
  expect(f.commands().filter((args) => !args.includes('--review-manifest'))).toHaveLength(
    2,
  )
  expect(document.getElementById('project-save-count')!.textContent).toBe(
    '1 skill ready to save',
  )
  expect(f.checkboxes()).toHaveLength(1)
  expect(f.button('save').textContent).toBe('Save 1 skill')
  expect(f.button('save').disabled).toBe(false)
  await f.view.observe()
  expect(f.commands()).toHaveLength(3)
})
it('joins an entry observation when opening instead of retiring or duplicating that read', async () => {
  const f = setup()
  f.holdInventory()
  const observing = f.view.observe(),
    opening = f.view.open()
  await f.flush()
  expect(f.commands()).toHaveLength(1)
  f.inventoryResult()
  await Promise.all([observing, opening])
  expect(f.commands().filter((args) => !args.includes('--review-manifest'))).toHaveLength(
    1,
  )
  expect(f.checkboxes().every((input) => input.checked)).toBe(true)
  expect(f.button('save').textContent).toBe('Save 2 skills')
  expect(f.button('save').disabled).toBe(false)
})
it('bounds repeated invalidation and leaves a fresh review action without using stale all-selection', async () => {
  const f = setup()
  f.holdInventory(2)
  const opening = f.view.open()
  await f.flush()
  f.view.invalidate()
  f.inventoryResult()
  await f.flush()
  expect(f.commands()).toHaveLength(2)
  f.view.invalidate()
  f.inventoryResult()
  await opening
  await f.flush()
  expect(f.commands()).toHaveLength(2)
  expect(f.checkboxes()).toHaveLength(0)
  expect(f.button('save').disabled).toBe(true)
  expect(f.button('state').textContent).toBe('Skills changed. Review this project again.')
  expect(f.button('refresh').hidden).toBe(false)
  f.button('refresh').click()
  await f.flush()
  expect(f.commands().filter((args) => !args.includes('--review-manifest'))).toHaveLength(
    3,
  )
  expect(document.getElementById('project-save-count')!.textContent).toBe(
    '2 skills ready to save',
  )
  expect(f.saves()).toHaveLength(0)
})
it('waits for a fresh inventory when a still-opening review hides and returns', async () => {
  const f = setup()
  f.holdInventory()
  const opening = f.view.open()
  await f.flush()
  f.context.visible = false
  f.view.visibilityChanged()
  f.context.visible = true
  f.view.visibilityChanged()
  await f.flush()
  expect(f.commands()).toHaveLength(1)
  f.inventoryResult()
  await opening
  await f.flush()
  expect(f.commands().filter((args) => !args.includes('--review-manifest'))).toHaveLength(
    2,
  )
  expect(f.commands().filter((args) => args.includes('--review-manifest'))).toHaveLength(
    1,
  )
  expect(f.button('save').disabled).toBe(false)
  expect(f.saves()).toHaveLength(0)
})
it('stops on a current inventory error and retries only through explicit fresh review', async () => {
  const f = setup()
  f.inventoryFailure(new Error('Native metadata unavailable.'))
  await f.view.open()
  await f.flush()
  expect(f.commands()).toHaveLength(1)
  expect(f.button('state').textContent).toBe(
    'Save options unavailable. Refresh skills to check again.',
  )
  expect(f.button('refresh').hidden).toBe(false)
  f.inventoryFailure()
  f.button('refresh').click()
  await f.flush()
  expect(f.commands().filter((args) => !args.includes('--review-manifest'))).toHaveLength(
    2,
  )
  expect(f.saves()).toHaveLength(0)
})
it('keeps the bulk owner quiet outside an exact local workspace, including context replacement', async () => {
  const f = setup()
  const local = f.context.workspace
  f.context.workspace = {
    ...local,
    host: 'ssh:example',
    root: { ...local.root, hostId: 'ssh:example' },
  }
  await f.view.observe()
  await f.view.open()
  expect(f.requests).toHaveLength(0)
  expect(document.getElementById('project-save-entry')!.hidden).toBe(true)
  f.context.workspace = local
  f.view.contextChanged()
  await f.view.observe()
  expect(document.getElementById('project-save-entry')!.hidden).toBe(false)
  const before = f.requests.length
  f.context.workspace = { ...local, root: { ...local.root, hostId: 'ssh:example' } }
  f.view.contextChanged()
  await f.view.observe()
  await f.view.open()
  expect(f.requests).toHaveLength(before)
  expect(document.getElementById('project-save-entry')!.hidden).toBe(true)
  expect(f.button('state').textContent).not.toContain('unavailable')
})
it('displays and enforces the selection limit reported by Skillager', async () => {
  const f = setup(5)
  f.inventory.limits.selection_items = 2
  f.inventory.default_selection = null as unknown as string[]
  await f.view.observe()
  await f.view.open()
  expect(f.checkboxes().filter((input) => input.checked)).toHaveLength(2)
  expect(f.button('selection').textContent).toBe(
    '2 of 5 selected · 3 remaining. Up to 2 per save.',
  )
  f.checkboxes()[2]!.click()
  expect(f.checkboxes()[2]!.checked).toBe(false)
  expect(f.button('state').textContent).toBe(
    'Choose up to 2 skills. Uncheck one to choose another.',
  )
})
it('proposes at most 32 across managed-only pages with explicit remainder and optional additional choices', async () => {
  const f = setup(140, 230)
  await f.view.observe()
  expect(document.getElementById('project-save-open')!.textContent).toBe('Save skills…')
  await f.view.open()
  expect(f.checkboxes().filter((input) => input.checked)).toHaveLength(32)
  expect(f.button('selection').textContent).toContain(
    '32 of 140 selected · 108 remaining',
  )
  expect(f.commands().filter((args) => args.includes('--cursor'))).toHaveLength(2)
  expect(f.button('more').hidden).toBe(false)
  f.button('more').click()
  await f.flush()
  expect(f.checkboxes()).toHaveLength(140)
  f.checkboxes()[32]!.click()
  expect(f.checkboxes().filter((input) => input.checked)).toHaveLength(32)
  expect(f.button('state').textContent).toContain('Uncheck one')
})
it('keeps checkboxes responsive and coalesces pending previews to the latest exact selection', async () => {
  const f = setup(4)
  await f.view.observe()
  await f.view.open()
  f.holdPreview()
  f.checkboxes()[0]!.click()
  await f.flush()
  expect(f.button('save').disabled).toBe(true)
  expect(f.checkboxes().some((input) => input.disabled)).toBe(false)
  f.checkboxes()[1]!.click()
  f.checkboxes()[2]!.click()
  await f.flush()
  expect(f.commands().filter((args) => args.includes('--review-manifest'))).toHaveLength(
    2,
  )
  f.previewResult()
  await f.flush()
  expect(f.commands().filter((args) => args.includes('--review-manifest'))).toHaveLength(
    3,
  )
  expect(f.button('save').disabled).toBe(false)
  expect(f.button('save').textContent).toBe('Save 1 skill')
  f.button('save').click()
  f.button('save').click()
  await f.flush()
  expect(f.saves()).toHaveLength(1)
  const selected = JSON.parse(
    (f.saves()[0]!.input.input as { selection: string }).selection,
  ) as string[]
  expect(selected).toEqual([f.all[3]!.occurrence_id])
  expect(f.button('state').textContent).toBe('Saved 1 skill.')
})
it('disables only the decision for empty selection, retains optional files and discloses initialization', async () => {
  const f = setup(1)
  await f.view.observe()
  await f.view.open()
  expect(f.button('initialization').textContent).toContain('Creates your library')
  document.querySelector<HTMLButtonElement>('#project-import-choices button')!.click()
  expect(f.button('inspection').hidden).toBe(false)
  expect(f.button('files').textContent).toContain('SKILL.md')
  expect(f.requests.some((request) => request.capability.startsWith('source.'))).toBe(
    false,
  )
  f.checkboxes()[0]!.click()
  await f.flush()
  expect(f.button('save').disabled).toBe(true)
  expect(f.checkboxes()[0]!.disabled).toBe(false)
  expect(f.button('state').textContent).toBe('Choose skills to save.')
})
it('retains submitted results through hide and early return without replay or new previews', async () => {
  const f = setup()
  await f.view.observe()
  await f.view.open()
  const before = f.commands().length
  f.holdSave()
  f.button('save').click()
  f.context.visible = false
  f.view.visibilityChanged()
  f.context.visible = true
  f.view.visibilityChanged()
  expect(f.view.submitted).toBe(true)
  expect(f.checkboxes().every((input) => input.disabled)).toBe(true)
  f.saveResult()
  await f.flush()
  expect(f.button('state').textContent).toBe('Saved 2 skills.')
  f.context.visible = false
  f.view.visibilityChanged()
  f.context.visible = true
  f.view.visibilityChanged()
  await f.flush()
  expect(f.commands()).toHaveLength(before)
  expect(f.saves()).toHaveLength(1)
  expect(f.button('state').textContent).toBe('Saved 2 skills.')
})
it('retains exact partial and uncertain items with explicit existing reconciliation', async () => {
  const f = setup()
  await f.view.observe()
  await f.view.open()
  f.holdSave()
  f.button('save').click()
  f.context.visible = false
  f.view.visibilityChanged()
  f.saveResult({
    outcome: 'partial',
    operationId: 'batch-operation',
    message: '1 skill saved; check the remaining skill.',
    counts: { accepted: 1 },
    items: [
      { index: 0, status: 'accepted' },
      { index: 1, status: 'uncertain' },
    ],
  })
  await f.flush()
  f.context.visible = true
  f.view.visibilityChanged()
  expect(f.button('outcomes').textContent).toBe('Skill 1 · uncertain')
  expect(f.button('reconcile').hidden).toBe(false)
  expect(f.button('save').hidden).toBe(true)
  f.button('reconcile').click()
  await f.flush()
  expect(f.button('reconcile').textContent).toBe('Finish review')
  expect(f.requests.at(-1)!.input).toEqual({
    action: 'operation-state',
    input: { mode: 'observe', operationId: 'batch-operation' },
  })
  expect(f.saves()).toHaveLength(1)
})
it('quarantines late completion after actual workspace replacement, even if the original returns', async () => {
  const f = setup()
  await f.view.observe()
  await f.view.open()
  f.holdSave()
  f.button('save').click()
  const original = f.context.workspace
  f.context.workspace = { ...original, id: 'other' }
  f.view.contextChanged()
  f.context.workspace = original
  f.view.contextChanged()
  f.saveResult()
  await f.flush()
  expect(f.button('save').disabled).toBe(true)
  expect(document.getElementById('project-import')!.hidden).toBe(true)
  expect(f.changed).toHaveBeenCalledOnce()
  expect(f.changed.mock.calls[0]![1]).toEqual(original)
})
it('retires held preview authority on close and never admits a hidden save', async () => {
  const f = setup()
  await f.view.observe()
  f.holdPreview()
  const opening = f.view.open()
  await f.flush()
  f.view.close()
  f.previewResult()
  await opening
  expect(document.getElementById('project-import')!.hidden).toBe(true)
  f.button('save').click()
  await f.flush()
  expect(f.saves()).toHaveLength(0)
})
it('keeps discovery limitations concise and never calls a partial inventory all', async () => {
  const f = setup()
  f.inventory.observation = {
    status: 'partial',
    errors: [{ code: 'unreadable', path: null } as never],
    error_count: 1,
  }
  await f.view.observe()
  expect(document.getElementById('project-save-count')!.textContent).toContain(
    'discovery incomplete',
  )
  expect(document.getElementById('project-save-open')!.textContent).toBe('Save skills…')
  f.scope(false)
  expect(document.getElementById('project-save-entry')!.hidden).toBe(true)
})

it('restarts a stale page once, retiring its prepared selection before a fresh exact review', async () => {
  const f = setup(140)
  await f.view.observe()
  await f.view.open()
  f.staleCursors()
  f.holdPreview()
  f.button('more').click()
  await f.flush()
  expect(f.button('save').disabled).toBe(true)
  expect(f.saves()).toHaveLength(0)
  expect(
    f
      .commands()
      .filter(
        (args) => !args.includes('--review-manifest') && !args.includes('--cursor'),
      ),
  ).toHaveLength(2)
  f.previewResult()
  await f.flush()
  expect(f.button('save').disabled).toBe(false)
  expect(f.button('state').textContent).toBe(
    'Skills changed. Review this selection again.',
  )
})

it('does not loop if the restarted traversal expires again', async () => {
  const f = setup(40, 230)
  await f.view.observe()
  f.staleCursors(2)
  await f.view.open()
  expect(f.commands().filter((args) => args.includes('--cursor'))).toHaveLength(2)
  expect(f.button('save').disabled).toBe(true)
  expect(f.commands().some((args) => args.includes('--review-manifest'))).toBe(false)
})

it('refreshes displayed selected names from the newly prepared public review', async () => {
  const f = setup()
  await f.view.observe()
  await f.view.open()
  f.all[0]!.name = 'Renamed source'
  f.checkboxes()[1]!.click()
  await f.flush()
  expect(document.querySelector('#project-import-choices label')!.textContent).toBe(
    'Renamed source',
  )
})

it('retires prepared authority when the next page names a different library', async () => {
  const f = setup(140)
  await f.view.observe()
  await f.view.open()
  expect(f.button('save').disabled).toBe(false)
  f.inventory.library.root = '/different-library'
  f.button('more').click()
  await f.flush()
  expect(f.button('save').disabled).toBe(true)
  expect(f.button('state').textContent).toContain('changed')
  expect(f.button('refresh').hidden).toBe(false)
  f.button('save').click()
  await f.flush()
  expect(f.saves()).toHaveLength(0)
})

it('renews a prepared subset on same-workspace return without resetting its selection', async () => {
  const f = setup(4)
  await f.view.observe()
  await f.view.open()
  f.checkboxes()[0]!.click()
  await f.flush()
  f.context.visible = false
  f.view.visibilityChanged()
  const before = f.commands().length
  f.context.visible = true
  f.view.visibilityChanged()
  // IPC context renewal must start the owner without waiting for another DOM event.
  expect(f.commands()).toHaveLength(before + 1)
  await f.flush()
  expect(f.button('save').disabled).toBe(false)
  expect(f.button('save').textContent).toBe('Save 3 skills')
  expect(f.checkboxes().filter((input) => input.checked)).toHaveLength(3)
})

it('preserves the chosen subset for fresh review after refusal and eligibility invalidation', async () => {
  const f = setup(4)
  await f.view.observe()
  await f.view.open()
  f.checkboxes()[0]!.click()
  await f.flush()
  f.holdSave()
  f.button('save').click()
  f.saveResult(undefined, new Error('Skills changed. Review again.'))
  await f.flush()
  f.view.invalidate()
  f.button('refresh').click()
  await f.flush()
  expect(f.button('save').disabled).toBe(false)
  expect(f.button('save').textContent).toBe('Save 3 skills')
  expect(f.checkboxes()[0]!.checked).toBe(false)
  f.view.close()
  await f.view.open()
  expect(f.button('save').textContent).toBe('Save 4 skills')
})

it('drops retained choices that fresh inventory identifies as already saved', async () => {
  const f = setup(3)
  await f.view.observe()
  await f.view.open()
  f.holdSave()
  f.button('save').click()
  f.saveResult(undefined, new Error('Skills changed. Review again.'))
  await f.flush()
  Object.assign(f.all[0]!, {
    eligibility: 'already_saved',
    canonical: {
      skill_id: f.all[0]!.destination_id,
      path: `${f.inventory.library.root}/skills/skill-0`,
      acceptance: 'accepted',
      working_hash: f.all[0]!.source_hash,
      accepted_hash: f.all[0]!.source_hash,
    },
  })
  f.inventory.summary.eligible = 2
  f.inventory.summary.already_saved = 1
  f.inventory.default_selection = f.all.slice(1).map((item) => item.occurrence_id)
  f.view.invalidate()
  f.button('refresh').click()
  await f.flush()
  expect(f.checkboxes()).toHaveLength(2)
  expect(f.checkboxes().every((input) => input.checked)).toBe(true)
  expect(f.button('save').textContent).toBe('Save 2 skills')
  expect(f.button('save').disabled).toBe(false)
  const last = f.commands().at(-1)!
  expect(JSON.parse(last[last.indexOf('--select') + 1]!)).toEqual(
    f.all.slice(1).map((item) => item.occurrence_id),
  )
})

it('keeps retained off-page choices visible and removable when fresh preparation refuses them', async () => {
  const f = setup(3, 100)
  await f.view.observe()
  await f.view.open()
  f.holdSave()
  f.button('save').click()
  f.saveResult(undefined, new Error('Skills changed. Review again.'))
  await f.flush()
  f.previewFailure(new Error('One source is no longer eligible.'))
  f.view.invalidate()
  f.button('refresh').click()
  await f.flush()
  expect(f.checkboxes()).toHaveLength(3)
  expect(f.checkboxes().every((input) => input.checked)).toBe(true)
  const source = f.all[100]!,
    label = f.checkboxes()[0]!.closest('label')!
  expect(label.textContent).toBe(source.name)
  expect(label.title).toBe(`local: ${source.skill_file}`)
  expect(f.button('save').disabled).toBe(true)
  expect(f.button('state').textContent).toBe('One source is no longer eligible.')
  expect(f.button('selection').textContent).toBe('3 selected')
  f.previewFailure()
  f.checkboxes()[0]!.click()
  await f.flush()
  expect(f.button('save').textContent).toBe('Save 2 skills')
  expect(f.button('save').disabled).toBe(false)
  expect(f.saves()).toHaveLength(1)
  const last = f.commands().at(-1)!
  expect(JSON.parse(last[last.indexOf('--select') + 1]!)).not.toContain(
    source.occurrence_id,
  )
})

it('resolves retained off-page choices from fresh paging before preparing another decision', async () => {
  const f = setup(2, 100)
  await f.view.observe()
  await f.view.open()
  f.holdSave()
  f.button('save').click()
  f.saveResult(undefined, new Error('Skills changed. Review again.'))
  await f.flush()
  f.all[100]!.eligibility = 'blocked'
  f.inventory.summary.eligible = 1
  f.inventory.summary.blocked = 1
  f.inventory.default_selection = [f.all[101]!.occurrence_id]
  f.previewFailure(new Error('One source is no longer eligible.'))
  f.view.invalidate()
  f.button('refresh').click()
  await f.flush()
  expect(f.button('selection').textContent).toBe('2 selected')
  expect(f.checkboxes()).toHaveLength(2)
  f.previewFailure()
  f.button('more').click()
  await f.flush()
  expect(f.checkboxes()).toHaveLength(1)
  expect(f.checkboxes()[0]!.dataset.occurrence).toBe(f.all[101]!.occurrence_id)
  expect(f.button('save').textContent).toBe('Save 1 skill')
  expect(f.button('save').disabled).toBe(false)
  expect(f.saves()).toHaveLength(1)
})

it('retains a finished recovery review across hide without reviving the consumed pending operation', async () => {
  const f = setup()
  f.result({
    outcome: 'partial',
    operationId: 'batch-operation',
    counts: { accepted: 1 },
    items: [],
  })
  await f.view.observe()
  await f.view.open()
  f.button('save').click()
  await f.flush()
  f.button('reconcile').click()
  await f.flush()
  expect(f.button('reconcile').textContent).toBe('Finish review')
  f.button('reconcile').click()
  f.context.visible = false
  f.view.visibilityChanged()
  await f.flush()
  const before = f.commands().length
  f.context.visible = true
  f.view.visibilityChanged()
  await f.flush()
  expect(f.button('reconcile').hidden).toBe(true)
  expect(f.button('save').hidden).toBe(true)
  expect(f.button('state').textContent).toBe('Current facts acknowledged.')
  expect(f.commands()).toHaveLength(before)
  expect(f.saves()).toHaveLength(1)
})

it('ends acknowledgment authority when a recovery observation completes while hidden', async () => {
  const f = setup()
  f.result({
    outcome: 'uncertain',
    operationId: 'batch-operation',
    counts: { accepted: 0 },
    items: [],
  })
  await f.view.observe()
  await f.view.open()
  f.button('save').click()
  await f.flush()
  f.button('reconcile').click()
  f.context.visible = false
  f.view.visibilityChanged()
  await f.flush()
  f.context.visible = true
  f.view.visibilityChanged()
  expect(f.button('reconcile').textContent).toBe('Check saved skills')
  expect(f.button('save').hidden).toBe(true)
  f.button('reconcile').click()
  await f.flush()
  expect(f.requests.at(-1)!.input).toEqual({
    action: 'operation-state',
    input: { mode: 'observe', operationId: 'batch-operation' },
  })
  expect(f.saves()).toHaveLength(1)
})

it('does not repeat preparation when an older queued DOM callback runs after direct renewal', async () => {
  const f = setup()
  const queued: Array<() => void> = []
  vi.spyOn(document.defaultView!, 'queueMicrotask').mockImplementation((callback) =>
    queued.push(callback),
  )
  await f.view.observe()
  await f.view.open()
  expect(f.button('save').disabled).toBe(false)
  const before = f.commands().length
  queued.splice(0).forEach((callback) => callback())
  await f.flush()
  expect(f.commands()).toHaveLength(before)
})
