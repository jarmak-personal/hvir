import { expect, it } from 'vitest'
import {
  importContractFixture,
  importModule,
  importOperationFixture,
  publicImportCases,
} from './fixtures/skillager-import'
const contract = importModule<{
  exactImportManifest(
    value: unknown,
    selection: unknown,
    workspace: unknown,
  ): { eligible: boolean }
  importArgs(selection: unknown, token?: string): string[]
  externalImportLibrary(value: unknown): unknown
}>('import-contract')
it('consumes the public external manifest, exact occurrence and ordinary token-bound argv', () => {
  const f = importContractFixture()
  expect(contract.exactImportManifest(f.preview, f.input, f.workspace).eligible).toBe(
    true,
  )
  expect(['skillager', ...contract.importArgs(f.input, f.input.token)]).toEqual(
    f.preview.next_command_argv,
  )
})
it.each(publicImportCases())(
  'preserves captured public $case identity, destination and complete confirmation argv',
  ({ preview }) => {
    const f = importContractFixture(preview)
    expect(contract.exactImportManifest(f.preview, f.input, f.workspace).eligible).toBe(
      true,
    )
    expect(['skillager', ...contract.importArgs(f.input, f.input.token)]).toEqual(
      preview.next_command_argv,
    )
    expect(
      contract.exactImportManifest(
        f.preview,
        { ...f.input, name: undefined },
        f.workspace,
      ).eligible,
    ).toBe(true)
  },
)
it.each([
  123,
  { toString: () => 'valid-name' },
  '',
  '保存-𐐀',
  '𐐨'.repeat(32) + 'a'.repeat(33),
  'cafe\u0301',
  'a--b',
  'a_b',
  '../a',
  'a/b',
  'a\n',
  'a\ud800',
])('rejects noncanonical destination %j without coercion or normalization', (name) => {
  const f = importContractFixture(),
    destination = `${f.preview.review_manifest.library.root}/skills/${String(name)}`
  expect(() => contract.importArgs({ ...f.input, name })).toThrow()
  expect(() =>
    contract.exactImportManifest(
      {
        ...f.preview,
        destination: {
          ...f.preview.destination,
          name,
          id: `lib/${String(name)}`,
          path: destination,
        },
        review_manifest: {
          ...f.preview.review_manifest,
          destination_id: `lib/${String(name)}`,
          destination_path: destination,
        },
      },
      { ...f.input, name: undefined },
      f.workspace,
    ),
  ).toThrow()
})
it.each([
  'lib/保存',
  'Project/item',
  'project//item',
  '/project/item',
  'project/item/',
  'project/./item',
  'project/../item',
  'project/item_name',
  'project/item.name',
  'project/item\\name',
  'project/item\0',
  'project/item\n',
  'project/item\u2028',
  'project/item\ud800',
  're\u0301visions--保存/保存/𐐨-guide',
])('rejects unsupported external identity %j without rewriting it', (skillId) => {
  const f = importContractFixture()
  expect(() => contract.importArgs({ ...f.input, skillId })).toThrow()
})
it.each([
  'source',
  'file',
  'destination',
  'library',
  'provenance',
  'hash',
  'total',
  'missing-file',
  'schema',
  'project',
])('refuses changed or incomplete external %s metadata', (change) => {
  const f = importContractFixture(),
    manifest = f.preview.review_manifest
  if (change === 'source') manifest.source_id = 'project/other'
  if (change === 'file') manifest.source_file = '/different/SKILL.md'
  if (change === 'destination') manifest.destination_path = '/different'
  if (change === 'library') manifest.library.root = '/different'
  if (change === 'provenance') manifest.source_provenance['collection'] = 'other'
  if (change === 'hash') manifest.working_hash = 'b'.repeat(64)
  if (change === 'total') manifest.total_bytes++
  if (change === 'missing-file') manifest.files.pop()
  if (change === 'schema') manifest.schema = 'skillager.library-review-manifest.v1'
  if (change === 'project') f.workspace.root.path = '/another'
  expect(() => contract.exactImportManifest(f.preview, f.input, f.workspace)).toThrow()
})
it.each(['blocked', 'override', 'command'])(
  'leaves public %s gates authoritative',
  (gate) => {
    const f = importContractFixture()
    if (gate === 'blocked') f.preview.blocked = true
    if (gate === 'override') f.preview.requires_override = true
    if (gate === 'command') f.preview.next_command_argv.push('--override-lint')
    expect(contract.exactImportManifest(f.preview, f.input, f.workspace).eligible).toBe(
      false,
    )
  },
)
it('saves one exact occurrence with project-cli and verifies public accepted status', async () => {
  const f = importOperationFixture(),
    result = await f.invoke()
  expect(result['outcome']).toBe('verified')
  expect(result['original']).toEqual({ file: f.input.file, preserved: true })
  expect(
    f.calls.every(
      (call) =>
        call['connector'] === 'project-cli' && call['workspace'] === f.workspace.id,
    ),
  ).toBe(true)
  expect(
    f.calls.filter((call) => (call['args'] as string[]).includes('--yes')),
  ).toHaveLength(1)
  expect(await f.invoke('operation-state', { mode: 'list' })).toEqual({ ids: [] })
})
it('rejects agent acceptance before any native request', async () => {
  const f = importOperationFixture()
  expect((await f.invoke('save-and-accept', f.input, 'agent'))['outcome']).toBe('refused')
  expect(f.calls).toEqual([])
})
it.each(['token', 'hash', 'path'])(
  'rejects stale selected %s before mutation',
  async (change) => {
    const f = importOperationFixture()
    if (change === 'token') f.input.token = 'a'.repeat(64)
    if (change === 'hash') f.input.hash = 'a'.repeat(64)
    if (change === 'path') f.input.file.path = '/other/SKILL.md'
    expect((await f.invoke())['outcome']).toBe('refused')
    expect(f.calls.some((call) => (call['args'] as string[]).includes('--yes'))).toBe(
      false,
    )
  },
)
it('allows a disclosed first-use identity to become the verified initialized registration', async () => {
  const f = importOperationFixture()
  f.preview.library.status = f.preview.review_manifest.library.status = 'will-initialize'
  f.preview.review_manifest.library.library_id = null
  f.result.library = {
    status: 'initialized',
    root: f.preview.library.root,
    git_mode: 'disabled',
  }
  expect((await f.invoke())['outcome']).toBe('verified')
})
it.each(['git', 'lost', 'revoked', 'accepted-hash', 'library', 'copied-files'])(
  'retains submitted %s uncertainty and prevents import replay',
  async (failure) => {
    const f = importOperationFixture()
    if (failure === 'git') f.fail()
    if (failure === 'lost') f.lose()
    if (failure === 'revoked') f.revoke()
    if (failure === 'accepted-hash') f.status.skill.accepted_hash = 'a'.repeat(64)
    if (failure === 'library') f.status.library.library_id = 'a'.repeat(36)
    if (failure === 'copied-files') f.result.copied_file_count--
    const result = await f.invoke()
    expect(result['outcome']).toBe('uncertain')
    expect(result['operationId']).toBeTypeOf('string')
    f.client.alive = true
    expect(await f.invoke('operation-state', { mode: 'list' })).toEqual({
      ids: [result['operationId']],
    })
    expect((await f.invoke())['outcome']).toBe('refused')
    expect(
      f.calls.filter((call) => (call['args'] as string[]).includes('--yes')),
    ).toHaveLength(1)
  },
)
it('acknowledges exact current imported state without asserting historical completion', async () => {
  const f = importOperationFixture()
  f.lose()
  const result = await f.invoke(),
    operationId = result['operationId']
  const current = await f.invoke('operation-state', { mode: 'observe', operationId })
  expect(current['outcome']).toBe('observed')
  expect(
    (JSON.parse(current['observation'] as string) as { originalCompletion: string })
      .originalCompletion,
  ).toBe('unknown')
  f.status.skill.working_hash = 'a'.repeat(64)
  expect(
    (
      await f.invoke('operation-state', {
        mode: 'acknowledge',
        operationId,
        observation: current['observation'],
      })
    )['outcome'],
  ).toBe('refused')
})

it('positively observes an absent destination through fresh public preview and rejects stale acknowledgment', async () => {
  const f = importOperationFixture()
  f.fail()
  const result = await f.invoke(),
    operationId = result['operationId']
  f.missing()
  const observed = await f.invoke('operation-state', { mode: 'observe', operationId })
  expect(observed['outcome']).toBe('observed')
  expect(JSON.parse(observed['observation'] as string)).toMatchObject({
    state: 'destination-absent',
    originalCompletion: 'unknown',
  })
  const writes = () =>
    f.calls.filter((call) => (call['args'] as string[]).includes('--yes'))
  expect(writes()).toHaveLength(1)
  f.preview.review_manifest.confirmation_token = 'b'.repeat(64)
  f.preview.next_command_argv[f.preview.next_command_argv.length - 1] = 'b'.repeat(64)
  expect(
    (
      await f.invoke('operation-state', {
        mode: 'acknowledge',
        operationId,
        observation: observed['observation'],
      })
    )['outcome'],
  ).toBe('refused')
  const fresh = await f.invoke('operation-state', { mode: 'observe', operationId })
  expect(
    (
      await f.invoke('operation-state', {
        mode: 'acknowledge',
        operationId,
        observation: fresh['observation'],
      })
    )['outcome'],
  ).toBe('reconciled')
  expect(await f.invoke('operation-state', { mode: 'list' })).toEqual({ ids: [] })
  expect(writes()).toHaveLength(1)
})

it('does not infer destination absence from an unavailable selected status', async () => {
  const f = importOperationFixture()
  f.fail()
  const result = await f.invoke()
  f.missing()
  f.preview.destination.exists = true
  expect(
    (
      await f.invoke('operation-state', {
        mode: 'observe',
        operationId: result['operationId'],
      })
    )['outcome'],
  ).toBe('refused')
  expect(await f.invoke('operation-state', { mode: 'list' })).toEqual({
    ids: [result['operationId']],
  })
})

it('acknowledges no registration without claiming absent files or replaying failed first import', async () => {
  const f = importOperationFixture()
  f.preview.library.status = f.preview.review_manifest.library.status = 'will-initialize'
  f.preview.review_manifest.library.library_id = null
  f.fail()
  const result = await f.invoke(),
    operationId = result['operationId']
  const unregistered = {
    schema: 'skillager.library-status.v1',
    status: 'not-initialized',
    initialized: false,
    library: null,
    git: null,
    skill: null,
  }
  f.registration(unregistered)
  const observed = await f.invoke('operation-state', { mode: 'observe', operationId })
  expect(JSON.parse(observed['observation'] as string)).toMatchObject({
    state: 'registration-absent',
    registered: null,
    destination: 'unknown',
    partialFiles: 'unknown',
    originalCompletion: 'unknown',
  })
  f.registration(f.status)
  expect(
    (
      await f.invoke('operation-state', {
        mode: 'acknowledge',
        operationId,
        observation: observed['observation'],
      })
    )['outcome'],
  ).toBe('refused')
  f.registration(unregistered)
  expect(
    (
      await f.invoke('operation-state', {
        mode: 'acknowledge',
        operationId,
        observation: observed['observation'],
      })
    )['outcome'],
  ).toBe('reconciled')
  expect(await f.invoke('operation-state', { mode: 'list' })).toEqual({ ids: [] })
  expect(
    f.calls.filter((call) => (call['args'] as string[]).includes('--yes')),
  ).toHaveLength(1)
})

it('shares external-import library identity without admitting a null registered identity or unsupported history', () => {
  const library = importContractFixture().preview.review_manifest.library
  expect(contract.externalImportLibrary(library)).toEqual(library)
  expect(
    contract.externalImportLibrary({
      ...library,
      status: 'will-initialize',
      library_id: null,
    }),
  ).toMatchObject({ library_id: null })
  for (const change of [
    { status: 'ready', library_id: null },
    { library_id: 'unknown' },
    { status: 'initialized' },
    { git_mode: 'automatic' },
    { root: 'relative' },
  ])
    expect(() => contract.externalImportLibrary({ ...library, ...change })).toThrow()
})
