import { connectorOutputFixture } from './fixtures/connector-output'
import { readFileSync } from 'node:fs'
import { createHash, webcrypto } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { buildSync } from 'esbuild'
import { expect, it } from 'vitest'

type Value = Record<string, unknown>
function fixture(
  outcomes = ['created', 'updated', 'unchanged', 'skipped', 'conflict', 'failed'],
) {
  const status = JSON.parse(
      readFileSync('test/fixtures/skillager-management/first-no-git-status.json', 'utf8'),
    ) as { library: { library_id: string; root: string } },
    library = {
      id: status.library.library_id,
      root: { hostId: 'local', path: status.library.root },
      gitMode: 'disabled',
    },
    identity = { library_id: library.id, root: library.root.path, git_mode: 'disabled' }
  const plan = {
      schema: 'skillager.library-sync-status.v1',
      library: identity,
      coverage: {
        complete: true,
        discovered_origins: outcomes.length,
        approved_origins: outcomes.length,
        selected_sources: outcomes.length,
        processed_sources: outcomes.length,
        discovery_error_count: 0,
      },
      candidates: outcomes.map((_outcome, n) => ({
        source_identity: `source-${n}`,
        canonical_skill_id: `lib/skill-${n}`,
        state: 'eligible-create',
        reason_code: 'approved',
      })),
    },
    result = {
      schema: 'skillager.library-sync.v1',
      status: outcomes.includes('uncertain')
        ? 'uncertain'
        : outcomes.some((item) => ['conflict', 'failed'].includes(item))
          ? 'partial'
          : 'completed',
      library: identity,
      coverage: { ...plan.coverage },
      counts: Object.fromEntries(
        [
          'created',
          'updated',
          'unchanged',
          'skipped',
          'conflict',
          'failed',
          'uncertain',
        ].map((key) => [key, outcomes.filter((value) => value === key).length]),
      ),
      items: outcomes.map((outcome, n) => ({
        source_identity: `source-${n}`,
        canonical_skill_id: `lib/skill-${n}`,
        outcome,
        phase: 'canonical-copy',
        reason_code: `reason-${n}`,
        repair: 'public CLI',
      })),
    }
  const bundle = buildSync({
      entryPoints: ['packages/skillager-extension/src/management-operation.mjs'],
      bundle: true,
      format: 'iife',
      globalName: 'Module',
      write: false,
    }),
    sandbox = { TextEncoder, crypto: webcrypto, Module: undefined as unknown }
  runInNewContext(bundle.outputFiles[0]!.text, sandbox)
  const module = sandbox.Module as {
    executeManagement(client: unknown, invocation: Value): Promise<Value>
  }
  let serial = 0
  let overrideCode: number | undefined
  const outputs = new Map<string, unknown>(),
    calls: string[][] = [],
    executions: Value[] = [],
    native = connectorOutputFixture(),
    client = {
      alive: true,
      request(capability: string, input: Value) {
        if (capability === 'connector.output') return Promise.resolve(native.read(input))
        const args = input['args'] as string[],
          receipt = String(++serial)
        calls.push(args)
        executions.push(input)
        outputs.set(
          receipt,
          args.includes('sync') ? (args.includes('--approved') ? result : plan) : status,
        )
        return Promise.resolve(
          native.complete(
            {
              outcome: 'completed',
              code: args.includes('--approved')
                ? (overrideCode ?? (result.status === 'completed' ? 0 : 2))
                : 0,
              truncated: false,
              receipt,
            },
            JSON.stringify(outputs.get(receipt)),
          ),
        )
      },
    }
  const invoke = (
    action: string,
    input: unknown = {},
    caller = 'agent',
    context: Value = {},
  ) =>
    module.executeManagement(client, {
      id: `main-${++serial}`,
      action,
      input,
      context,
      caller,
      authorization: 'standing',
    })
  return {
    plan,
    result,
    library,
    calls,
    executions,
    invoke,
    nativeCode: (code: number) => {
      overrideCode = code
    },
  }
}
it('returns complete code-two partial conflicts and failures without claiming overall success', async () => {
  const f = fixture(),
    result = await f.invoke('sync-library', { library: f.library })
  expect(result['outcome']).toBe('partial')
  expect(result['status']).toBe('partial')
  expect(result['items']).toEqual(
    f.result.items.map((item) => [
      item.source_identity,
      item.canonical_skill_id,
      item.outcome,
      item.phase,
      item.reason_code,
      item.repair,
      null,
    ]),
  )
  expect(result['counts']).toEqual(f.result.counts)
  expect(await f.invoke('operation-state', { mode: 'list' })).toEqual({ ids: [] })
  expect(f.calls.filter((args) => args.includes('--approved'))).toHaveLength(1)
})
it('retains incomplete coverage even when all reported item outcomes are known', async () => {
  const f = fixture(['created'])
  f.result.status = 'partial'
  f.result.coverage.complete = false
  f.result.coverage.processed_sources = 0
  const result = await f.invoke('sync-library', { library: f.library })
  expect(result['outcome']).toBe('uncertain')
  expect(result['items']).toHaveLength(1)
  expect(await f.invoke('operation-state', { mode: 'list' })).toEqual({
    ids: [result['operationId']],
  })
})
it.each(['selected', 'processed', 'errors', 'approved', 'missing', 'duplicate'])(
  'retains submitted uncertainty for inconsistent %s coverage',
  async (problem) => {
    const f = fixture(['created', 'unchanged'])
    if (problem === 'selected') f.result.coverage.selected_sources = 1
    if (problem === 'processed') f.result.coverage.processed_sources = 1
    if (problem === 'errors') f.result.coverage.discovery_error_count = 1
    if (problem === 'approved') f.result.coverage.approved_origins = 3
    if (problem === 'missing')
      Reflect.deleteProperty(f.result.coverage, 'processed_sources')
    if (problem === 'duplicate')
      f.result.items[1]!.source_identity = f.result.items[0]!.source_identity
    const result = await f.invoke('sync-library', { library: f.library })
    expect(result['outcome']).toBe('uncertain')
    expect(result['message']).toMatch(/coverage/)
    expect(await f.invoke('operation-state', { mode: 'list' })).toEqual({
      ids: [result['operationId']],
    })
    expect(f.calls.filter((args) => args.includes('--approved'))).toHaveLength(1)
  },
)
it.each(['code', 'status', 'count', 'identity', 'outcome'])(
  'retains submitted uncertainty for a mismatched sync %s',
  async (problem) => {
    const f = fixture(['conflict'])
    if (problem === 'code') f.nativeCode(0)
    if (problem === 'status') {
      f.result.status = 'completed'
      f.nativeCode(2)
    }
    if (problem === 'count') f.result.counts['conflict'] = 0
    if (problem === 'identity')
      f.result.library = { ...f.result.library, root: '/different-library' }
    if (problem === 'outcome') f.result.items[0]!.outcome = 'invented'
    const result = await f.invoke('sync-library', { library: f.library })
    expect(result['outcome']).toBe('uncertain')
    expect(typeof result['operationId']).toBe('string')
    expect(await f.invoke('operation-state', { mode: 'list' })).toEqual({
      ids: [result['operationId']],
    })
    expect(f.calls.filter((args) => args.includes('--approved'))).toHaveLength(1)
  },
)
it('requires code zero for a complete successful report and rejects code two with completed status', async () => {
  const good = fixture(['created'])
  expect((await good.invoke('sync-library', { library: good.library }))['outcome']).toBe(
    'verified',
  )
  const wrong = fixture(['created'])
  wrong.nativeCode(2)
  expect(
    (await wrong.invoke('sync-library', { library: wrong.library }))['outcome'],
  ).toBe('uncertain')
})
it.each([33, 32])(
  'refuses %i-source or result-envelope excess before submitting synchronization',
  async (count) => {
    const f = fixture(Array<string>(count).fill('created'))
    const result = await f.invoke('sync-library', { library: f.library })
    expect(result['outcome']).toBe('refused')
    expect(result['message']).toMatch(count === 33 ? /32-source/ : /action-result bound/)
    expect(f.calls.some((args) => args.includes('--approved'))).toBe(false)
  },
)
it('retains complete admitted native output and exact uncertainty when post-dispatch report expands beyond the action envelope', async () => {
  const f = fixture(['created'])
  f.result.items[0]!.reason_code = 'long-reason-'.repeat(1000)
  const result = await f.invoke('sync-library', { library: f.library }),
    operationId = result['operationId'] as string
  expect(result['outcome']).toBe('uncertain')
  expect(result['message']).toMatch(/Submitted synchronization report exceeds/)
  let output = '',
    offset = 0
  for (;;) {
    const page = await f.invoke('operation-state', {
      mode: 'report',
      operationId,
      offset,
    })
    output += page['data'] as string
    if (page['nextOffset'] === null) break
    offset = page['nextOffset'] as number
  }
  const retained = JSON.parse(output) as {
    operation: { library: unknown }
    output: { stdout: string }
  }
  expect(retained.operation.library).toEqual(f.library)
  expect(JSON.parse(retained.output.stdout)).toEqual(f.result)
  expect(await f.invoke('operation-state', { mode: 'list' })).toEqual({
    ids: [operationId],
  })
  const repeat = await f.invoke('sync-library', { library: f.library })
  expect(repeat['outcome']).toBe('refused')
  expect(f.calls.filter((args) => args.includes('--approved'))).toHaveLength(1)
})
it('reports all admitted uncertain outcomes while retaining the exact operation for explicit reconciliation', async () => {
  const f = fixture(['created', 'uncertain']),
    result = await f.invoke('sync-library', { library: f.library })
  expect(result['outcome']).toBe('uncertain')
  expect(result['items']).toHaveLength(2)
  expect(typeof result['operationId']).toBe('string')
  expect(await f.invoke('operation-state', { mode: 'list' })).toEqual({
    ids: [result['operationId']],
  })
})

function reviewedHash(value: unknown): string {
  const canonical = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(canonical)
      : item && typeof item === 'object'
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, val]) => [key, canonical(val)]),
          )
        : item
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')
}
it('binds human confirmation to every field of the complete public synchronization review', async () => {
  const f = fixture(['created'])
  const reviewHash = reviewedHash(f.plan)
  expect(
    (await f.invoke('sync-library', { library: f.library, reviewHash }, 'guest'))[
      'outcome'
    ],
  ).toBe('verified')
})
it.each(['missing', 'selection', 'canonical', 'state', 'coverage', 'lineage'])(
  'refuses human sync when reviewed %s changes before submission',
  async (problem) => {
    const f = fixture(['created'])
    const reviewHash = reviewedHash(f.plan)
    if (problem === 'selection') f.plan.candidates[0]!.source_identity = 'changed-source'
    if (problem === 'canonical') f.plan.candidates[0]!.canonical_skill_id = 'lib/changed'
    if (problem === 'state') f.plan.candidates[0]!.state = 'eligible-update'
    if (problem === 'coverage') f.plan.coverage.approved_origins = 0
    if (problem === 'lineage')
      Reflect.set(f.plan, 'lineages', [{ canonical: { working_hash: 'b'.repeat(64) } }])
    const result = await f.invoke(
      'sync-library',
      { library: f.library, ...(problem === 'missing' ? {} : { reviewHash }) },
      'guest',
    )
    expect(result['outcome']).toBe('refused')
    expect(result['message']).toMatch(/Review the fresh plan/)
    expect(f.calls.some((args) => args.includes('--approved'))).toBe(false)
    expect(await f.invoke('operation-state', { mode: 'list' }, 'guest')).toEqual({
      ids: [],
    })
  },
)

function noEffect(f: ReturnType<typeof fixture>, index: number, state = 'skipped') {
  Object.assign(f.plan.candidates[index]!, {
    state,
    reason_code: state === 'current' ? null : 'source-not-approved',
  })
  Object.assign(f.result.items[index]!, {
    phase: state === 'current' ? 'accepted' : 'not-started',
    repair: 'none',
    reason_code: state === 'current' ? null : 'source-not-approved',
  })
}
it('reports exactly 68 sources, 7 effects and 61 not-approved sources with original coverage', async () => {
  const f = fixture([
    ...Array<string>(7).fill('created'),
    ...Array<string>(61).fill('skipped'),
  ])
  for (let i = 7; i < 68; i++) noEffect(f, i)
  f.plan.coverage.approved_origins = f.result.coverage.approved_origins = 7
  const result = await f.invoke(
    'sync-library',
    { library: f.library, reviewHash: reviewedHash(f.plan) },
    'guest',
  )
  expect(result['outcome']).toBe('verified')
  expect(result['items']).toHaveLength(7)
  expect(result['summary']).toEqual({
    total: 68,
    detailed: 7,
    notApproved: { label: 'not approved for sync', count: 61 },
    unchanged: { label: 'unchanged', count: 0 },
  })
  expect(result['coverage']).toEqual(f.result.coverage)
  expect(result['counts']).toEqual(f.result.counts)
  expect(f.calls.filter((args) => args.includes('--approved'))).toHaveLength(1)
})
it('admits inventories above 32 when every exact outcome is unchanged', async () => {
  const f = fixture(Array<string>(68).fill('unchanged'))
  for (let i = 0; i < 68; i++) noEffect(f, i, 'current')
  const result = await f.invoke('sync-library', { library: f.library })
  expect(result['outcome']).toBe('verified')
  expect(result['items']).toEqual([])
  expect(result['summary']).toMatchObject({
    total: 68,
    detailed: 0,
    unchanged: { count: 68 },
  })
})

it('admits the exact 32-source preview and apply with 31 no-effect rows and one effect', async () => {
  const f = fixture(['created', ...Array<string>(31).fill('skipped')])
  for (let i = 1; i < 32; i++) noEffect(f, i)
  f.plan.coverage.approved_origins = f.result.coverage.approved_origins = 1
  const result = await f.invoke(
    'sync-library',
    { library: f.library, reviewHash: reviewedHash(f.plan) },
    'guest',
  )
  expect(result['outcome']).toBe('verified')
  expect(result['items']).toHaveLength(1)
  expect(result['summary']).toEqual({
    total: 32,
    detailed: 1,
    notApproved: { label: 'not approved for sync', count: 31 },
    unchanged: { label: 'unchanged', count: 0 },
  })
  expect(result['coverage']).toEqual(f.result.coverage)
  expect(result['counts']).toEqual(f.result.counts)
  expect(f.calls.filter((args) => args.includes('--approved'))).toHaveLength(1)
})
it.each(['phase', 'repair', 'recovery_path', 'reason_code'])(
  'retains a nominal no-effect row with consequential %s information',
  async (field) => {
    const f = fixture(['unchanged'])
    noEffect(f, 0, 'current')
    Reflect.set(
      f.result.items[0]!,
      field,
      field === 'recovery_path' ? '/owned/完整-recovery' : 'needs-inspection',
    )
    const result = await f.invoke('sync-library', { library: f.library })
    expect(result['items']).toHaveLength(1)
    expect(result['summary']).toMatchObject({ detailed: 1, unchanged: { count: 0 } })
    if (field === 'recovery_path')
      expect((result['items'] as unknown[][])[0]![6]).toBe('/owned/完整-recovery')
  },
)
it('does not inherit preview exclusions when the actual operation creates 33 sources', async () => {
  const f = fixture(Array<string>(33).fill('created'))
  for (const row of f.plan.candidates)
    Object.assign(row, { state: 'skipped', reason_code: 'source-not-approved' })
  const result = await f.invoke('sync-library', { library: f.library })
  expect(result['outcome']).toBe('uncertain')
  expect(result['operationId']).toBeTypeOf('string')
  let report = '',
    offset = 0
  for (;;) {
    const page = await f.invoke('operation-state', {
      mode: 'report',
      operationId: result['operationId'],
      offset,
    })
    report += page['data'] as string
    if (page['nextOffset'] === null) break
    offset = page['nextOffset'] as number
  }
  const retained = JSON.parse(report) as { output: { stdout: string } }
  expect(JSON.parse(retained.output.stdout)).toEqual(f.result)
  expect((await f.invoke('sync-library', { library: f.library }))['outcome']).toBe(
    'refused',
  )
})
it('retains an exact long recovery path as paged uncertainty instead of losing the repair location', async () => {
  const f = fixture(['failed'])
  const recovery = '/owned/' + 'long-recovery-'.repeat(600)
  Reflect.set(f.result.items[0]!, 'recovery_path', recovery)
  const result = await f.invoke('sync-library', { library: f.library })
  expect(result['outcome']).toBe('uncertain')
  expect(result['operationId']).toBeTypeOf('string')
})
it('binds fresh summarized reconciliation to all identities and lineage while original completion stays unknown', async () => {
  const f = fixture(Array<string>(68).fill('skipped'))
  for (let i = 0; i < 68; i++) noEffect(f, i)
  f.result.status = 'uncertain'
  const result = await f.invoke('sync-library', { library: f.library })
  const operationId = result['operationId']
  const observed = await f.invoke('operation-state', { mode: 'observe', operationId })
  const value = JSON.parse(observed['observation'] as string) as {
    summary: { notApproved: { count: number } }
    originalCompletion: string
    observationHash: string
  }
  expect(value.summary.notApproved.count).toBe(68)
  expect(value.originalCompletion).toBe('unknown')
  expect(value.observationHash).toBe(reviewedHash(f.plan))
  f.plan.candidates[67]!.source_identity = 'different-summarized-identity'
  const stale = await f.invoke('operation-state', {
    mode: 'acknowledge',
    operationId,
    observation: observed['observation'],
  })
  expect(stale['outcome']).toBe('refused')
  const fresh = await f.invoke('operation-state', { mode: 'observe', operationId })
  Reflect.set(f.plan, 'lineages', [{ changed: true }])
  expect(
    (
      await f.invoke('operation-state', {
        mode: 'acknowledge',
        operationId,
        observation: fresh['observation'],
      })
    )['outcome'],
  ).toBe('refused')
  const latest = await f.invoke('operation-state', { mode: 'observe', operationId })
  expect(
    (
      await f.invoke('operation-state', {
        mode: 'acknowledge',
        operationId,
        observation: latest['observation'],
      })
    )['outcome'],
  ).toBe('reconciled')
})
it('routes local sync to project-cli, untargeted to library-cli and refuses SSH before execution', async () => {
  const local = fixture(['created']),
    global = fixture(['created']),
    remote = fixture(['created'])
  const workspace = {
    id: 'project',
    host: 'local',
    root: { hostId: 'local', path: '/owned/project' },
  }
  await local.invoke('sync-library', { library: local.library }, 'agent', { workspace })
  expect(
    local.executions.every(
      (value) => value['connector'] === 'project-cli' && value['workspace'] === 'project',
    ),
  ).toBe(true)
  await global.invoke('sync-library', { library: global.library })
  expect(
    global.executions.every(
      (value) => value['connector'] === 'library-cli' && value['workspace'] === undefined,
    ),
  ).toBe(true)
  const result = await remote.invoke(
    'sync-library',
    { library: remote.library },
    'agent',
    { workspace: { ...workspace, host: 'ssh' } },
  )
  expect(result['outcome']).toBe('refused')
  expect(result['message']).toMatch(/SSH sync is unavailable/)
  expect(remote.executions).toEqual([])
})
