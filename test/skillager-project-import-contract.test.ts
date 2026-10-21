import { describe, expect, it } from 'vitest'
import { importModule } from './fixtures/skillager-import'
import { projectImportFixture } from './fixtures/skillager-project-import'
const contract = importModule<{
  observeProjectImport(io: unknown, workspace: unknown, paging: unknown): Promise<unknown>
  exactProjectImport(value: unknown, selection: string, workspace: unknown): unknown
  projectImportInventory(value: unknown, workspace: unknown): unknown
  projectImportSelection(value: string): string[]
  projectImportArgs(value: string, token?: string): string[]
  prepareProjectImport(
    io: unknown,
    selection: string,
    workspace: unknown,
  ): Promise<unknown>
}>('project-import-contract')
const result = importModule<{
  projectImportCompletion(value: unknown, code: number, preview: unknown): unknown
}>('project-import-result')

it('consumes real public project inventory and one complete two-skill review with ordinary argv', () => {
  const f = projectImportFixture()
  expect(contract.projectImportInventory(f.inventory, f.workspace)).toEqual(f.inventory)
  expect(contract.exactProjectImport(f.preview, f.input.selection, f.workspace)).toEqual(
    f.preview,
  )
  expect([
    'skillager',
    ...contract.projectImportArgs(f.input.selection, f.input.token),
  ]).toEqual(f.preview.next_command_argv)
  expect(result.projectImportCompletion(f.result, 0, f.preview)).toEqual(f.result)
  expect(contract.projectImportInventory(f.after, f.workspace)).toEqual(f.after)
})
it('preserves whole-project eligible counts and selection independently of a one-row page', () => {
  const f = projectImportFixture()
  f.inventory.items = f.inventory.items.slice(0, 1)
  Object.assign(f.inventory, { next_cursor: 'public-page-cursor' })
  const observed = contract.projectImportInventory(
    f.inventory,
    f.workspace,
  ) as typeof f.inventory
  expect(observed.summary.eligible).toBe(2)
  expect(observed.default_selection).toHaveLength(2)
})
it('keeps partial discovery visible without discarding an explicit complete known subset review', () => {
  const f = projectImportFixture(),
    partial = {
      status: 'partial',
      error_count: 1,
      errors: [{ code: 'unreadable-path', path: null }],
    }
  Object.assign(f.inventory, { observation: partial })
  Object.assign(f.preview, { observation: partial })
  expect(contract.projectImportInventory(f.inventory, f.workspace)).toMatchObject({
    observation: partial,
  })
  expect(
    contract.exactProjectImport(f.preview, f.input.selection, f.workspace),
  ).toMatchObject({ observation: partial })
})
it.each([
  '[]',
  '["project:bad"]',
  JSON.stringify(Array(33).fill(`project:${'a'.repeat(64)}`)),
  JSON.stringify([`project:${'a'.repeat(64)}`, `project:${'a'.repeat(64)}`]),
  ' '.repeat(4097),
])('rejects empty, malformed, duplicate or over-bound selection %s', (selection) => {
  expect(() => contract.projectImportSelection(selection)).toThrow()
})
it('canonicalizes the selected order without changing the selected occurrences', () => {
  const f = projectImportFixture()
  expect(
    contract.projectImportSelection(JSON.stringify([...f.preview.selection].reverse())),
  ).toEqual(f.preview.selection)
})
describe('complete exact review identity', () => {
  it.each([
    'source',
    'destination',
    'file',
    'files',
    'library',
    'selection',
    'project',
    'scan',
    'command',
    'total',
    'bound',
  ])('refuses changed %s', (field) => {
    const f = projectImportFixture(),
      item = f.preview.items[0]!
    if (field === 'source') item.source_hash = 'a'.repeat(64)
    if (field === 'destination') item.destination.path = '/different'
    if (field === 'file') item.source.file = '/other/SKILL.md'
    if (field === 'files') item.review_manifest.files = []
    if (field === 'library') item.review_manifest.library.root = '/other-library'
    if (field === 'selection') f.preview.selection.reverse()
    if (field === 'project') f.preview.project_root = '/other-project'
    if (field === 'scan') item.scan.risk = 'high'
    if (field === 'command') f.preview.next_command_argv.push('--force')
    if (field === 'total') item.review_manifest.total_bytes++
    if (field === 'bound') f.preview.limits.selection_items = 33
    expect(() =>
      contract.exactProjectImport(f.preview, f.input.selection, f.workspace),
    ).toThrow()
  })
})
it.each(['total', 'default', 'canonical', 'duplicate', 'schema', 'coverage', 'scope'])(
  'rejects incoherent inventory %s facts',
  (change) => {
    const f = projectImportFixture(),
      item = f.inventory.items[0]!
    if (change === 'total') f.inventory.summary.total++
    if (change === 'default') f.inventory.default_selection.pop()
    if (change === 'canonical')
      Object.assign(item, {
        canonical: { ...f.state.items[0]!.canonical, path: '/wrong' },
      })
    if (change === 'duplicate') f.inventory.items.push(item)
    if (change === 'schema') f.inventory.schema = 'skillager.list.v1'
    if (change === 'coverage') f.inventory.observation.error_count = 1
    if (change === 'scope') f.inventory.scope = 'all'
    expect(() => contract.projectImportInventory(f.inventory, f.workspace)).toThrow()
  },
)
it.each(['identity', 'count', 'hash', 'coverage', 'initialization', 'exit'])(
  'refuses incomplete submitted %s evidence',
  (change) => {
    const f = projectImportFixture()
    if (change === 'identity')
      f.result.items[0]!.occurrence_id = f.result.items[1]!.occurrence_id
    if (change === 'count') f.result.counts.accepted--
    if (change === 'hash') f.result.items[0]!.accepted_hash = 'b'.repeat(64)
    if (change === 'coverage') f.result.items.pop()
    if (change === 'initialization') f.result.initialization.library_id = 'b'.repeat(36)
    expect(() =>
      result.projectImportCompletion(f.result, change === 'exit' ? 2 : 0, f.preview),
    ).toThrow()
  },
)
it('gives unsupported CLI guidance without falling back to one-item imports', async () => {
  const f = projectImportFixture()
  const io = {
    run() {
      const error = new Error('invalid JSON')
      Object.assign(error, {
        nativeExit: 2,
        nativeStderr: "invalid choice: 'import-project'",
      })
      return Promise.reject(error)
    },
  }
  await expect(
    contract.prepareProjectImport(io, f.input.selection, f.workspace),
  ).rejects.toThrow('Update Skillager')
})

it('preserves only the public stale-cursor failure for the metadata consumer to restart once', async () => {
  const f = projectImportFixture(),
    cursor = importModule<{ isStaleCatalogCursor(error: unknown): boolean }>(
      'catalog-cli',
    ),
    value = {
      schema: 'skillager.error.v1',
      error: { code: 'stale_cursor', message: 'Inventory changed' },
    },
    io = {
      run(
        _args: unknown,
        _operation: unknown,
        _retry: unknown,
        validate: (value: unknown, code: number) => void,
      ) {
        validate(value, 15)
        return Promise.resolve(value)
      },
    }
  const error: unknown = await contract
    .observeProjectImport(io, f.workspace, { cursor: 'old-page' })
    .catch((reason: unknown) => reason)
  expect(cursor.isStaleCatalogCursor(error)).toBe(true)
  await expect(
    contract.prepareProjectImport(io, f.input.selection, f.workspace),
  ).rejects.toThrow('Update Skillager')
})

it('accepts public Unicode metadata bounds without treating code points as UTF-16 units', () => {
  const f = projectImportFixture()
  f.inventory.items[0]!.name = '𐐨'.repeat(160)
  f.inventory.items[0]!.description = '𐐨'.repeat(1000)
  expect(contract.projectImportInventory(f.inventory, f.workspace)).toEqual(f.inventory)
})
