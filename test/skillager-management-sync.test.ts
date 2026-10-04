import { readFileSync } from 'node:fs'
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
    identity = { library_id: library.id, root: library.root.path }
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
    sandbox = { TextEncoder, Module: undefined as unknown }
  runInNewContext(bundle.outputFiles[0]!.text, sandbox)
  const module = sandbox.Module as {
    executeManagement(client: unknown, invocation: Value): Promise<Value>
  }
  let serial = 0
  let overrideCode: number | undefined
  const outputs = new Map<string, unknown>(),
    calls: string[][] = [],
    client = {
      alive: true,
      request(capability: string, input: Value) {
        if (capability === 'connector.output')
          return Promise.resolve(
            input['release']
              ? null
              : {
                  data:
                    input['stream'] === 'stderr'
                      ? ''
                      : JSON.stringify(outputs.get(String(input['receipt']))),
                  nextOffset: null,
                },
          )
        const args = input['args'] as string[],
          receipt = String(++serial)
        calls.push(args)
        outputs.set(
          receipt,
          args.includes('sync') ? (args.includes('--approved') ? result : plan) : status,
        )
        return Promise.resolve({
          outcome: 'completed',
          code: args.includes('--approved')
            ? (overrideCode ?? (result.status === 'completed' ? 0 : 2))
            : 0,
          truncated: false,
          receipt,
        })
      },
    }
  const invoke = (action: string, input: unknown = {}) =>
    module.executeManagement(client, {
      id: `main-${++serial}`,
      action,
      input,
      context: {},
      caller: 'agent',
      authorization: 'standing',
    })
  return {
    plan,
    result,
    library,
    calls,
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
