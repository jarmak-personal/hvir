import { expect, it } from 'vitest'
import { importModule } from './fixtures/skillager-import'
import { importPlacementFixture } from './fixtures/skillager-import-placement'

type Value = Record<string, unknown>
const { managementActionError } = importModule<{
  managementActionError: (message: unknown) => string
}>('management-action-reply')
const contract = importModule<{
  exactImportPlacement(
    value: unknown,
    input: unknown,
    workspace: unknown,
  ): { eligible: boolean }
  placementCompletion(
    value: unknown,
    code: number,
    preview: unknown,
    input: unknown,
    workspace: unknown,
  ): unknown
}>('import-placement-contract')
it('binds the complete prospective import and replacement without a nested acceptance token', () => {
  const f = importPlacementFixture()
  expect(contract.exactImportPlacement(f.preview, f.input, f.workspace).eligible).toBe(
    true,
  )
  expect(f.preview.import.review_manifest).not.toHaveProperty('confirmation_token')
  expect(
    contract.placementCompletion(f.applied, 0, f.preview, f.input, f.workspace),
  ).toEqual(f.applied)
})
it.each([
  'project',
  'agent',
  'mode',
  'library',
  'original',
  'request',
  'target',
  'missing-effect',
  'staging',
  'nested-token',
])('refuses incomplete or changed compound %s before dispatch', (change) => {
  const f = importPlacementFixture(),
    p = f.preview,
    replacement = p['replacement'] as Value
  if (change === 'project') p['project'] = '/another'
  if (change === 'agent') p.agent = 'claude'
  if (change === 'mode') p.mode = 'native'
  if (change === 'library')
    (p['library_identity'] as Value)['library_id'] = 'a'.repeat(36)
  if (change === 'original') (p['original'] as Value)['entrypoint'] = '/other/SKILL.md'
  if (change === 'request') (replacement['request'] as Value)['mode'] = 'native'
  if (change === 'target') (replacement['targets'] as Value[])[2]!['path'] = '/outside'
  if (change === 'missing-effect')
    delete (replacement['targets'] as Value[])[2]!['file_effects']
  if (change === 'staging')
    (replacement['staging'] as Value)['peak_bytes'] = Number.MAX_SAFE_INTEGER
  if (change === 'nested-token')
    p.import.review_manifest.confirmation_token = 'a'.repeat(64)
  expect(() => contract.exactImportPlacement(p, f.input, f.workspace)).toThrow()
})
it('dispatches one public combined mutation and verifies the actual saved library version', async () => {
  const f = importPlacementFixture(),
    result = await f.invoke()
  expect(result['outcome']).toBe('verified')
  expect(
    f.calls.filter((call) => {
      const args = call['args'] as string[]
      return args[0] === 'import' && !args.includes('--yes')
    }),
  ).toHaveLength(1)
  expect(
    f.calls.filter((call) => (call['args'] as string[]).includes('--yes')),
  ).toHaveLength(1)
  expect(
    f.calls.every(
      (call) =>
        call['connector'] === 'project-cli' && call['workspace'] === f.workspace.id,
    ),
  ).toBe(true)
  expect(await f.invoke('operation-state', { mode: 'list' })).toEqual({ ids: [] })
})
it.each(['agent', 'ssh', 'hash', 'token'])(
  'refuses %s authority/drift before the mutation',
  async (failure) => {
    const f = importPlacementFixture()
    if (failure === 'hash') f.input.hash = 'b'.repeat(64)
    if (failure === 'token') f.input.token = 'b'.repeat(64)
    const result = await f.invoke(
      undefined,
      undefined,
      failure === 'agent' ? 'agent' : 'guest',
      failure === 'ssh' ? { workspace: { ...f.workspace, host: 'remote' } } : undefined,
    )
    expect(result['outcome']).toBe('refused')
    expect(f.calls.some((call) => (call['args'] as string[]).includes('--yes'))).toBe(
      false,
    )
  },
)
it.each(['lost', 'revoked', 'initialization', 'hash', 'target-result', 'stage'])(
  'retains %s uncertainty and never repeats the mutation',
  async (failure) => {
    const f = importPlacementFixture()
    if (failure === 'lost') f.lose()
    if (failure === 'revoked') f.revoke()
    if (failure === 'initialization') delete f.applied['initialization']
    if (failure === 'hash')
      ((f.applied['save'] as Value)['destination'] as Value)['accepted_hash'] =
        'b'.repeat(64)
    if (failure === 'target-result')
      ((f.applied['placement'] as Value)['results'] as Value[]).pop()
    if (failure === 'stage') (f.applied['placement'] as Value)['status'] = 'uncertain'
    const result = await f.invoke()
    expect(result['outcome']).toBe('uncertain')
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
it('retains the accepted canonical and reports known failed placement without an automatic retry', async () => {
  const f = importPlacementFixture()
  f.applied['status'] = 'saved-not-replaced'
  f.applied['placement'] = { status: 'not-applied' }
  f.applied['error'] = {
    code: 'replacement-changed',
    message: 'Project changed after saving.',
  }
  f.fail()
  const result = await f.invoke()
  expect(result['outcome']).toBe('saved-not-replaced')
  expect((result['save'] as Value)['status']).toBe('accepted')
  expect(result['message']).toContain('choose Use full copy or Use stub')
  expect(await f.invoke('operation-state', { mode: 'list' })).toEqual({ ids: [] })
  expect(
    f.calls.filter((call) => (call['args'] as string[]).includes('--yes')),
  ).toHaveLength(1)
})
it('retains separate stage facts when cleanup fails after successful replacement', async () => {
  const f = importPlacementFixture()
  f.applied['status'] = 'partial'
  f.applied['cleanup'] = { status: 'incomplete', path: '/owned-scratch' }
  f.fail()
  const result = await f.invoke()
  expect(result['outcome']).toBe('uncertain')
  expect((result['save'] as Value)['status']).toBe('accepted')
  expect((result['placement'] as Value)['status']).toBe('applied')
  expect(result['operationId']).toBeTypeOf('string')
})
it('offers a concrete update instruction for old CLIs and never chains standalone operations', async () => {
  const f = importPlacementFixture()
  f.older()
  const result = await f.invoke()
  expect(result['outcome']).toBe('refused')
  expect(result['message']).toContain('Update Skillager to use Full or Stub')
  expect(f.calls).toHaveLength(1)
  expect(f.calls[0]!['args'] as string[]).toContain('--project-mode')
})

it.each([
  {
    code: 2,
    output: '',
    stderr: `usage: skillager import ${'[existing-option] '.repeat(100)}\nskillager: error: unrecognized arguments: --project-mode stub --agent codex`,
    expected: 'Update Skillager',
  },
  {
    code: 0,
    output: JSON.stringify({ schema: 'skillager.import-placement.v2' }),
    stderr: '',
    expected: 'Update Skillager',
  },
  {
    code: 1,
    output: JSON.stringify({
      schema: 'skillager.error.v1',
      error: { message: 'The library is locked by another operation.' },
    }),
    stderr: '',
    expected: 'library is locked',
  },
  {
    code: 1,
    output: '',
    stderr: `${'traceback frame\n'.repeat(100)}PermissionError: owned library is read-only`,
    expected: 'PermissionError',
  },
  {
    code: 1,
    output: JSON.stringify({ schema: 'skillager.error.v1' }),
    stderr: `${'traceback frame\n'.repeat(100)}OSError: owned disk is full`,
    expected: 'OSError: owned disk is full',
  },
  { code: 2, output: 'invalid', stderr: '', expected: 'invalid JSON' },
])('reports the actual preview failure: $expected / exit $code', async (failure) => {
  const f = importPlacementFixture()
  f.nativeFailure(failure)
  const result = await f.invoke()
  expect(result['outcome']).toBe('refused')
  expect(result['message']).toContain(failure.expected)
  expect(managementActionError(result['message'])).toContain(failure.expected)
  if (failure.expected !== 'Update Skillager')
    expect(result['message']).not.toContain('Update Skillager')
  expect(f.calls).toHaveLength(1)
})

it('observes exact current saved and managed state after a lost reply without replaying', async () => {
  const f = importPlacementFixture()
  f.lose()
  const result = await f.invoke(),
    operationId = result['operationId']
  const observed = await f.invoke('operation-state', { mode: 'observe', operationId })
  expect(observed['outcome']).toBe('observed')
  const facts = JSON.parse(observed['observation'] as string) as Value
  expect(facts['originalCompletion']).toBe('unknown')
  expect(facts['project']).toMatchObject({ state: 'unchanged-managed', mode: 'stub' })
  const acknowledged = await f.invoke('operation-state', {
    mode: 'acknowledge',
    operationId,
    observation: observed['observation'],
  })
  expect(acknowledged['outcome']).toBe('reconciled')
  expect(
    f.calls.filter((call) => (call['args'] as string[]).includes('--yes')),
  ).toHaveLength(1)
  expect(f.calls.some((call) => (call['args'] as string[]).includes('sync'))).toBe(false)
})

it.each(['absent', 'pending'] as const)(
  'acknowledges current %s destination and exact original without asserting historical completion',
  async (state) => {
    const f = importPlacementFixture()
    f.existing()
    f.lose()
    const result = await f.invoke(),
      operationId = result['operationId']
    expect(result['outcome']).toBe('uncertain')
    f.recover(state)
    const observed = await f.invoke('operation-state', { mode: 'observe', operationId })
    expect(observed['outcome']).toBe('observed')
    const facts = JSON.parse(observed['observation'] as string) as Value
    expect(facts).toMatchObject({
      originalCompletion: 'unknown',
      partialFiles: 'unknown',
      project: {
        state: 'original-present',
        target: { hostId: 'local', path: f.preview.import.source.path },
        content: 'not-asserted',
      },
    })
    if (state === 'absent') expect(facts['state']).toBe('destination-absent')
    else expect(facts['acceptance']).toBe('pending')
    expect((facts['project'] as Value)['publicFacts']).toMatch(/^[a-f0-9]{64}$/u)
    const acknowledged = await f.invoke('operation-state', {
      mode: 'acknowledge',
      operationId,
      observation: observed['observation'],
    })
    expect(acknowledged['outcome']).toBe('reconciled')
    expect(await f.invoke('operation-state', { mode: 'list' })).toEqual({ ids: [] })
    expect(
      f.calls.filter((call) => (call['args'] as string[]).includes('--yes')),
    ).toHaveLength(1)
    f.resume()
    if (state === 'pending') {
      f.preview['status'] = 'refused'
      f.preview['error'] = {
        code: 'destination-exists',
        message: 'Destination already exists.',
      }
    }
    const previousPreviews = f.calls.length,
      next = await f.invoke()
    expect(f.calls.length).toBeGreaterThan(previousPreviews)
    expect(next['outcome']).toBe(state === 'absent' ? 'verified' : 'refused')
    if (state === 'pending') expect(next['message']).toContain('already exists')
  },
)

it.each(['unresolved', 'origin', 'project', 'agent', 'library'])(
  'retains uncertain operation when current original %s identity is unresolved or changed',
  async (change) => {
    const f = importPlacementFixture()
    f.existing()
    f.lose()
    const result = await f.invoke(),
      operationId = result['operationId']
    f.recover('absent')
    const original = f.preview['original'] as Value
    if (change === 'unresolved') f.preview['original'] = null
    if (change === 'origin') original['origin_id'] = 'f'.repeat(64)
    if (change === 'project') (original['native'] as Value)['project_root'] = '/changed'
    if (change === 'agent') (original['native'] as Value)['agent'] = 'changed'
    if (change === 'library')
      (f.status['library'] as Value)['library_id'] = 'f'.repeat(36)
    const observed = await f.invoke('operation-state', { mode: 'observe', operationId })
    expect(observed['outcome']).toBe('refused')
    expect(await f.invoke('operation-state', { mode: 'list' })).toEqual({
      ids: [operationId],
    })
    expect(
      f.calls.filter((call) => (call['args'] as string[]).includes('--yes')),
    ).toHaveLength(1)
  },
)
