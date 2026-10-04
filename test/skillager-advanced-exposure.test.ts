import { readFileSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { buildSync } from 'esbuild'
import { expect, it } from 'vitest'
import { validateExtensionManifest } from '../src/shared/extensions/manifest'

type Value = Record<string, unknown>
interface Target extends Value {
  target_id: string
  path: string
  action: string
  before: { state_hash: string } | null
  after: { state_hash: string } | null
  file_effects: unknown[] | null
}
interface Plan extends Value {
  library_id: string
  project: string
  agent: string
  confirmation_token: string
  request: Value
  targets: Target[]
  sources: unknown[]
}
interface Reply extends Value {
  outcome?: string
  operationId?: string
  data?: string
  nextOffset?: number | null
  observation?: string
  results?: Value[]
}
interface Module {
  executeManagement(client: unknown, invocation: Value): Promise<Reply>
}
function fixture(caller = 'guest', authorization = 'unapproved') {
  const bundle = buildSync({
    entryPoints: ['packages/skillager-extension/src/management-operation.mjs'],
    bundle: true,
    format: 'iife',
    globalName: 'Module',
    write: false,
  })
  const sandbox = { TextEncoder, crypto: webcrypto, Module: undefined as unknown }
  runInNewContext(bundle.outputFiles[0]!.text, sandbox)
  const module = sandbox.Module as Module
  const plan = JSON.parse(
    readFileSync(
      'test/fixtures/skillager-management/advanced-adoption-preview.json',
      'utf8',
    ),
  ) as Plan
  const status = JSON.parse(
    readFileSync(
      'test/fixtures/skillager-management/advanced-library-status.json',
      'utf8',
    ),
  ) as Value & { library: { root: string } }
  const library = {
      id: plan.library_id,
      root: { hostId: 'local', path: status.library.root },
    },
    workspace = {
      id: 'exact-advanced',
      host: 'local',
      root: { hostId: 'local', path: plan.project },
    },
    input = {
      library,
      agent: plan.agent,
      request: JSON.stringify(plan.request),
      token: plan.confirmation_token,
    }
  let serial = 0,
    completion = 'completed',
    code = 0,
    changedToken = false,
    apply: Value | undefined
  const outputs = new Map<string, Value>(),
    calls: string[][] = []
  const client = {
    alive: true,
    request(this: void, capability: string, args: Value): Promise<unknown> {
      if (capability === 'connector.output')
        return Promise.resolve(
          args.release
            ? null
            : {
                data:
                  args.stream === 'stderr'
                    ? ''
                    : JSON.stringify(outputs.get(String(args.receipt))),
                nextOffset: null,
              },
        )
      const argv = args.args as string[]
      calls.push(argv)
      const receipt = String(++serial),
        mutate = argv.includes('--yes')
      if (mutate && completion !== 'completed')
        return Promise.resolve({ outcome: completion, receipt })
      outputs.set(
        receipt,
        argv[0] === 'library'
          ? status
          : mutate
            ? (apply ?? {
                ...Object.fromEntries(
                  Object.entries(plan).filter(
                    ([key]) => !['confirmation_token', 'next_command_argv'].includes(key),
                  ),
                ),
                status: 'applied',
                plan_hash: plan.confirmation_token,
                reason_code: null,
                results: plan.targets.map((target: Target) => ({
                  target_id: target.target_id,
                  path: target.path,
                  status: target.action === 'keep' ? 'unchanged' : 'applied',
                  reason_code: null,
                  observed_state_hash: target.after?.state_hash ?? null,
                  recovery_path: null,
                })),
              })
            : {
                ...plan,
                confirmation_token: changedToken
                  ? 'a'.repeat(64)
                  : plan.confirmation_token,
              },
      )
      return Promise.resolve({
        outcome: 'completed',
        receipt,
        code: mutate ? code : 0,
        truncated: false,
      })
    },
  }
  const invoke = (
    action = 'change-exposure',
    selected: Value = input,
    context: Value = { workspace },
    admitted = caller,
  ) =>
    module.executeManagement(client, {
      id: `advanced-${++serial}`,
      action,
      input: selected,
      context,
      caller: admitted,
      authorization,
    })
  return {
    input,
    plan,
    calls,
    client,
    invoke,
    workspace,
    drift: () => {
      changedToken = true
    },
    lost: () => {
      completion = 'interrupted'
    },
    result: (value: Value, exit = 2) => {
      apply = value
      code = exit
    },
  }
}
it('keeps exactly eight semantic exports with separate create-only Add and delete-only Remove', () => {
  const manifest = validateExtensionManifest(
    JSON.parse(readFileSync('packages/skillager-extension/hvir-extension.json', 'utf8')),
  ).manifest
  expect(manifest.actions).toHaveLength(8)
  expect(manifest.actions?.find((a) => a.id === 'change-exposure')).toMatchObject({
    agents: true,
    effects: { delete: true, replace: true },
  })
  expect(manifest.actions?.find((a) => a.id === 'add-copy')?.effects).toEqual({
    delete: false,
    replace: false,
  })
  expect(manifest.actions?.find((a) => a.id === 'remove-copy')?.effects).toEqual({
    delete: true,
    replace: false,
  })
  expect(manifest.actions?.some((a) => a.id === 'update-copy')).toBe(false)
})
it.each([
  ['guest', 'unapproved'],
  ['agent', 'standing'],
  ['agent', 'confirmed'],
])(
  'applies one whole preservation plan for %s/%s without force or approval policy',
  async (caller, authorization) => {
    const f = fixture(caller, authorization)
    const reply = await f.invoke()
    expect(reply.outcome).toBe('verified')
    expect(reply.results).toHaveLength(f.plan.targets.length)
    const writes = f.calls.filter((args) => args.includes('--yes'))
    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain(f.input.token)
    expect(writes[0]).toContain(f.input.request)
    expect(f.calls.flat()).not.toContain('--force')
    expect(await f.invoke('operation-state', { mode: 'list' })).toEqual({ ids: [] })
  },
)
it('refuses source/membership token drift and SSH before mutation', async () => {
  const f = fixture()
  f.drift()
  expect(await f.invoke()).toMatchObject({ outcome: 'refused' })
  expect(f.calls.some((args) => args.includes('--yes'))).toBe(false)
  expect(
    await f.invoke('change-exposure', f.input, {
      workspace: { ...f.workspace, host: 'ssh' },
    }),
  ).toMatchObject({ outcome: 'refused' })
})
it.each(['source', 'outside-target', 'incomplete-files', 'oversized-argv'])(
  'rejects %s before apply without truncation',
  async (problem) => {
    const f = fixture()
    if (problem === 'source') f.plan.sources = []
    if (problem === 'outside-target') f.plan.targets[0]!.path = '/outside'
    if (problem === 'incomplete-files') f.plan.targets[0]!.file_effects = null
    if (problem === 'oversized-argv')
      f.input.request = JSON.stringify({ ...f.plan.request, extra: 'x'.repeat(9000) })
    expect(await f.invoke()).toMatchObject({ outcome: 'refused' })
    expect(f.calls.some((args) => args.includes('--yes'))).toBe(false)
  },
)
it.each(['guest', 'agent'])(
  'retains lost completion for %s, scopes provenance and blocks only overlapping writes',
  async (caller) => {
    const f = fixture(caller, caller === 'agent' ? 'standing' : 'unapproved')
    f.lost()
    const reply = await f.invoke(),
      id = reply.operationId
    expect(reply.outcome).toBe('uncertain')
    expect(await f.invoke()).toMatchObject({ outcome: 'refused' })
    expect(f.calls.filter((args) => args.includes('--yes'))).toHaveLength(1)
    let report = '',
      offset = 0
    for (;;) {
      const page = await f.invoke('operation-state', {
        mode: 'report',
        operationId: id,
        offset,
      })
      report += page.data as string
      if (page.nextOffset === null) break
      offset = page.nextOffset as number
    }
    expect((JSON.parse(report) as Value).operation).toMatchObject({
      caller,
      authorization: caller === 'agent' ? 'standing' : 'unapproved',
      workspace: f.workspace,
      plan: f.plan,
    })
    expect(
      await f.invoke(
        'operation-state',
        { mode: 'list' },
        { workspace: { ...f.workspace, id: 'other' } },
      ),
    ).toEqual({ ids: [] })
    await expect(
      f.invoke(
        'operation-state',
        { mode: 'report', operationId: id },
        { workspace: f.workspace },
        caller === 'agent' ? 'guest' : 'agent',
      ),
    ).rejects.toThrow(/caller class/)
    const observed = await f.invoke('operation-state', {
      mode: 'observe',
      operationId: id,
    })
    expect(observed.outcome).toBe('observed')
    f.drift()
    expect(
      await f.invoke('operation-state', {
        mode: 'acknowledge',
        operationId: id,
        observation: observed.observation,
      }),
    ).toMatchObject({ outcome: 'refused' })
    expect(await f.invoke('operation-state', { mode: 'list' })).toEqual({ ids: [id] })
  },
)
it('retains complete nonzero per-target recovery outcomes and never treats rollback as overall success', async () => {
  const f = fixture(),
    recovery = f.plan.targets[0]!.path + '/.skillager-exposure-plan-owned/previous'
  f.result({
    ...f.plan,
    status: 'partial',
    plan_hash: f.input.token,
    reason_code: 'disposal-failed',
    results: f.plan.targets.map((target: Target, index: number) => ({
      target_id: target.target_id,
      path: target.path,
      status: index ? 'rolled_back' : 'recovery_required',
      reason_code: 'disposal-failed',
      recovery_path: index ? null : recovery,
      observed_state_hash: target.before?.state_hash ?? null,
    })),
  })
  const reply = await f.invoke()
  expect(reply.outcome).toBe('uncertain')
  expect(reply.results![0]).toMatchObject({
    status: 'recovery_required',
    recoveryPath: { hostId: 'local', path: recovery },
  })
  expect(await f.invoke('operation-state', { mode: 'list' })).toEqual({
    ids: [reply.operationId],
  })
})
it('rejects late completion after admission revocation', async () => {
  const f = fixture()
  const original = f.client.request
  f.client.request = async (capability, args) => {
    const reply = await original(capability, args)
    if (capability === 'connector.output' && !args.release) f.client.alive = false
    return reply
  }
  expect(await f.invoke()).toMatchObject({ outcome: 'refused' })
  expect(f.calls.some((args) => args.includes('--yes'))).toBe(false)
})

it('retains a lost adoption without blocking a different original under unchanged shared parents', async () => {
  const f = fixture('agent', 'standing')
  f.lost()
  const first = await f.invoke()
  const target = f.plan.targets.find((item) => item.action === 'replace')!
  target.path += '-other'
  target.target_id = 'b'.repeat(64)
  f.plan.request['origin_id'] = 'c'.repeat(64)
  f.input.request = JSON.stringify(f.plan.request)
  const independent = await f.invoke()
  expect(independent.outcome).toBe('uncertain')
  expect(independent.operationId).not.toBe(first.operationId)
  expect(f.calls.filter((args) => args.includes('--yes'))).toHaveLength(2)
  expect(await f.invoke('operation-state', { mode: 'list' })).toEqual({
    ids: [first.operationId, independent.operationId],
  })
})
