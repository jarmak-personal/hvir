import { expect, it } from 'vitest'
import { importModule } from './fixtures/skillager-import'
import { projectImportOperationFixture } from './fixtures/skillager-project-import'

it('saves the complete selection once and verifies all accepted versions in one targeted status read', async () => {
  const f = projectImportOperationFixture(),
    result = await f.invoke()
  expect(result).toMatchObject({
    outcome: 'verified',
    counts: { accepted: 2, uncertain: 0 },
    originals: 'unchanged',
  })
  expect(f.calls).toHaveLength(3)
  expect(
    f.calls.every(
      (call) =>
        call['connector'] === 'project-cli' && call['workspace'] === f.workspace.id,
    ),
  ).toBe(true)
  expect(
    f.calls.filter((call) => (call['args'] as string[]).includes('--yes')),
  ).toHaveLength(1)
  expect(f.calls[2]!['args'] as string[]).toContain('--status')
  expect(await f.invoke('operation-state', { mode: 'list' })).toEqual({ ids: [] })
})
it.each(['agent', 'ssh', 'no-project', 'stale-token'])(
  'refuses %s without native mutation',
  async (kind) => {
    const f = projectImportOperationFixture()
    if (kind === 'stale-token') f.input.token = 'a'.repeat(64)
    const context =
      kind === 'no-project'
        ? {}
        : { workspace: { ...f.workspace, ...(kind === 'ssh' ? { host: 'ssh' } : {}) } }
    const result = await f.invoke(
      'save-project-skills',
      f.input,
      kind === 'agent' ? 'agent' : 'guest',
      context,
    )
    expect(result['outcome']).toBe('refused')
    expect(f.calls.some((call) => (call['args'] as string[]).includes('--yes'))).toBe(
      false,
    )
    if (kind !== 'stale-token') expect(f.calls).toHaveLength(0)
  },
)
it.each(['uncertain', 'failed', 'skipped'] as const)(
  'preserves already saved items and complete raw details when a later selected save is %s',
  async (status) => {
    const f = projectImportOperationFixture()
    f.result.status = 'partial'
    Object.assign(f.result.items[1]!, {
      status,
      accepted_hash: null,
      reason_code: 'save-incomplete',
    })
    f.result.counts.accepted = 1
    f.result.counts[status] = 1
    Object.assign(f.state.items[1]!.canonical, {
      acceptance: 'pending',
      accepted_hash: null,
    })
    f.reply(f.result)
    const result = await f.invoke()
    expect(result).toMatchObject({
      outcome: 'partial',
      counts: { accepted: 1, [status]: 1 },
      message: `1 saved · 1 ${status}. Review results.`,
      details: 'operation-report',
    })
    expect(result['operationId']).toBeTypeOf('string')
    expect(await f.invoke('operation-state', { mode: 'list' })).toEqual({
      ids: [result['operationId']],
    })
    let offset: number | null = 0,
      report = ''
    do {
      const page = await f.invoke('operation-state', {
        mode: 'report',
        operationId: result['operationId'],
        offset,
      })
      report += page['data'] as string
      offset = page['nextOffset'] as number | null
    } while (offset !== null)
    const retained = JSON.parse(report) as { output: { stdout: string } }
    expect(JSON.parse(retained.output.stdout)).toEqual(f.result)
    expect((await f.invoke())['outcome']).toBe('refused')
    expect(
      f.calls.filter((call) => (call['args'] as string[]).includes('--yes')),
    ).toHaveLength(1)
  },
)
it('clears a definite public refusal and a definite not-started admission without claiming unknown effects', async () => {
  const f = projectImportOperationFixture()
  f.reply({
    schema: 'skillager.project-import.v1',
    status: 'refused',
    error: { code: 'selection-changed', message: 'Review again' },
    limits: f.preview.limits,
  })
  expect((await f.invoke())['outcome']).toBe('refused')
  expect(await f.invoke('operation-state', { mode: 'list' })).toEqual({ ids: [] })
  f.notStarted()
  expect((await f.invoke())['outcome']).toBe('refused')
  expect(await f.invoke('operation-state', { mode: 'list' })).toEqual({ ids: [] })
})
it.each(['lost', 'revoked', 'accepted-hash', 'destination', 'registration'])(
  'retains %s uncertainty and never retries the mutation',
  async (failure) => {
    const f = projectImportOperationFixture()
    if (failure === 'lost') f.lose()
    if (failure === 'revoked') f.revoke()
    if (failure === 'accepted-hash')
      f.state.items[0]!.canonical.accepted_hash = 'b'.repeat(64)
    if (failure === 'destination') f.state.items[0]!.canonical.path = '/different'
    if (failure === 'registration') f.state.library.library_id = 'a'.repeat(36)
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
it('binds all current destination facts to acknowledgment while missing originals never erase saved copies', async () => {
  const f = projectImportOperationFixture()
  f.lose()
  const result = await f.invoke(),
    operationId = result['operationId']
  Object.assign(f.state.items[0]!, { source: null })
  const current = await f.invoke('operation-state', { mode: 'observe', operationId })
  expect(current['outcome']).toBe('observed')
  expect(JSON.parse(current['observation'] as string)).toMatchObject({
    originalCompletion: 'unknown',
    counts: { accepted: 2 },
  })
  Object.assign(f.state.items[0]!.canonical, {
    acceptance: 'pending',
    working_hash: 'b'.repeat(64),
  })
  expect(
    (
      await f.invoke('operation-state', {
        mode: 'acknowledge',
        operationId,
        observation: current['observation'],
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
  expect(
    f.calls.filter((call) => (call['args'] as string[]).includes('--yes')),
  ).toHaveLength(1)
})
it('keeps an uncertain operation with its original caller and host-qualified project', async () => {
  const f = projectImportOperationFixture()
  f.lose()
  const result = await f.invoke(),
    operationId = result['operationId']
  expect(await f.invoke('operation-state', { mode: 'list' }, 'agent')).toEqual({
    ids: [],
  })
  const context = { workspace: { ...f.workspace, id: 'different-workspace' } }
  expect(await f.invoke('operation-state', { mode: 'list' }, 'guest', context)).toEqual({
    ids: [],
  })
  expect(
    (
      await f.invoke(
        'operation-state',
        { mode: 'observe', operationId },
        'guest',
        context,
      )
    )['outcome'],
  ).toBe('refused')
})
it('protects every selected target, initial registration and unknown sync without blocking another library', () => {
  const module = importModule<{
      pendingManagement(): {
        observe(id: string, operation: unknown): void
        assertAvailable(operation: unknown): void
        release(id: string): void
      }
    }>('management-pending'),
    pending = module.pendingManagement(),
    library = { id: 'library', root: { hostId: 'local', path: '/library' } },
    targets = [
      { hostId: 'local', path: '/library/skills/one' },
      { hostId: 'local', path: '/library/skills/two' },
    ],
    batch = { action: 'save-project-skills', library, targets, initializes: true }
  pending.observe('batch', batch)
  for (const target of targets) {
    expect(() =>
      pending.assertAvailable({ action: 'save-and-accept', library, target }),
    ).toThrow('batch')
    expect(() =>
      pending.assertAvailable({
        action: 'accept-version',
        library,
        source: { root: target },
      }),
    ).toThrow('batch')
  }
  expect(() =>
    pending.assertAvailable({
      action: 'initialize-library',
      selection: { location: 'default' },
    }),
  ).toThrow('batch')
  expect(() => pending.assertAvailable({ action: 'sync-library', library })).toThrow(
    'batch',
  )
  expect(() =>
    pending.assertAvailable({
      action: 'sync-library',
      library: { ...library, root: { hostId: 'local', path: '/other' } },
    }),
  ).not.toThrow()
  pending.release('batch')
  pending.observe('sync', { action: 'sync-library', library })
  expect(() => pending.assertAvailable(batch)).toThrow('sync')
})

it('rejects revocation during preflight before dispatching any mutation', async () => {
  const f = projectImportOperationFixture(),
    request = f.client.request.bind(f.client)
  f.client.request = async (capability, input) => {
    const result = await request(capability, input)
    if (capability === 'connector.execute') f.client.alive = false
    return result
  }
  expect((await f.invoke())['outcome']).toBe('refused')
  expect(f.calls.some((call) => (call['args'] as string[]).includes('--yes'))).toBe(false)
})
it('keeps a fully verified maximum batch compact without converting output size into uncertainty', async () => {
  const f = projectImportOperationFixture(),
    base = f.preview.items[0]!,
    completed = f.result.items[0]!,
    state = f.state.items[0]!
  f.preview.items = Array.from({ length: 32 }, (_, index) => {
    const item = structuredClone(base),
      name = `skill-${String(index).padStart(2, '0')}`,
      source = `${f.preview.project_root}/.skills/${name}`,
      destination = `${f.preview.library.root}/skills/${name}`
    item.occurrence_id = `project:${index.toString(16).padStart(64, '0')}`
    item.source.id = `project/${name}`
    item.source.path = source
    item.source.file = `${source}/SKILL.md`
    Object.assign(item.destination, { id: `lib/${name}`, name, path: destination })
    Object.assign(item.review_manifest, {
      source_id: item.source.id,
      source_root: source,
      source_file: item.source.file,
      destination_id: item.destination.id,
      destination_path: destination,
    })
    item.source_location.path = source
    item.source_file_identity.path = item.source.file
    return item
  })
  f.preview.selection = f.preview.items.map((item) => item.occurrence_id)
  f.input.selection = JSON.stringify(f.preview.selection)
  f.preview.next_command_argv[5] = f.input.selection
  f.result.selection = f.preview.selection
  f.result.items = f.preview.items.map((item) => ({
    ...completed,
    occurrence_id: item.occurrence_id,
    source_id: item.source.id,
    source_file: item.source.file,
    destination_id: item.destination.id,
    destination_path: item.destination.path,
  }))
  f.result.counts.accepted = 32
  f.state.items = f.preview.items.map((item) => ({
    ...structuredClone(state),
    occurrence_id: item.occurrence_id,
    destination_id: item.destination.id,
    source: { ...state.source, id: item.source.id, skill_file: item.source.file },
    canonical: {
      ...state.canonical,
      skill_id: item.destination.id,
      path: item.destination.path,
    },
  }))
  const result = await f.invoke()
  expect(result).toMatchObject({ outcome: 'verified', counts: { accepted: 32 } })
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(6144)
  expect(f.calls).toHaveLength(3)
})

it('pages complete Unicode and escaped operation reports within the encoded action bound', () => {
  const module = importModule<{
      pendingManagement(): {
        observe(id: string, operation: unknown): void
        retainOutput(id: string, output: unknown): void
        report(id: string, offset?: number): { data: string; nextOffset: number | null }
      }
    }>('management-pending'),
    pending = module.pendingManagement(),
    operation = { action: 'save-project-skills' },
    output = {
      stdout: '保存'.repeat(5000) + '\\"\n\t'.repeat(3000) + '𐐨'.repeat(2000),
      stderr: '',
    }
  pending.observe('unicode', operation)
  pending.retainOutput('unicode', output)
  let offset: number | null = 0,
    report = '',
    pages = 0
  do {
    const page = pending.report('unicode', offset)
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(6144)
    expect(page.data.length).toBeLessThanOrEqual(2048)
    if (page.nextOffset !== null) expect(page.nextOffset).toBe(offset + page.data.length)
    report += page.data
    offset = page.nextOffset
    pages++
  } while (offset !== null)
  expect(pages).toBeGreaterThan(10)
  expect(JSON.parse(report)).toEqual({ id: 'unicode', operation, output })
  expect(pending.report('unicode', report.length)).toEqual({ data: '', nextOffset: null })
  expect(() => pending.report('unicode', report.length + 1)).toThrow('offset')
})

it('describes a submitted uncertain batch as unknown effects while preserving exact results', async () => {
  const f = projectImportOperationFixture()
  f.result.status = 'uncertain'
  for (const item of f.result.items)
    Object.assign(item, {
      status: 'uncertain',
      accepted_hash: null,
      reason_code: 'save-incomplete',
    })
  f.result.counts.accepted = 0
  f.result.counts.uncertain = 2
  f.reply(f.result)
  const reply = await f.invoke()
  expect(reply).toMatchObject({
    outcome: 'uncertain',
    counts: { accepted: 0, uncertain: 2 },
    message: 'Save outcome unknown · 2 uncertain. Review results.',
    details: 'operation-report',
  })
  expect(f.calls).toHaveLength(2)
  expect(await f.invoke('operation-state', { mode: 'list' })).toEqual({
    ids: [reply['operationId']],
  })
})
