import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { buildSync } from 'esbuild'
import { expect, it } from 'vitest'

type Value = Record<string, unknown>
interface Operation {
  executeManagement(client: unknown, invocation: Value): Promise<Value>
}
interface Exposure {
  agent: string
  exposure_id: string
  mode: string
  skill_id: string
  scope: string
  target: string
  status: string
  preview: {
    confirmation_token: string
    source: {
      id: string
      root: string
      content_hash: string
      trust: string
      source: { library_id: string; library_root: string }
    }
  }
}
function fixture(caller = 'guest') {
  const bundle = buildSync({
    entryPoints: ['packages/skillager-extension/src/management-operation.mjs'],
    bundle: true,
    format: 'iife',
    globalName: 'Module',
    write: false,
  })
  const sandbox = { TextEncoder, Module: undefined as unknown }
  runInNewContext(bundle.outputFiles[0]!.text, sandbox)
  const module = sandbox.Module as Operation
  const previews = JSON.parse(
      readFileSync(
        'test/fixtures/skillager-management/codex-mode-initial-preview.json',
        'utf8',
      ),
    ) as Exposure[],
    preview = previews[0]!,
    source = preview.preview.source
  const status = JSON.parse(
    readFileSync('test/fixtures/skillager-management/first-no-git-status.json', 'utf8'),
  ) as { library: Value; skill: Value }
  status.library['library_id'] = source.source.library_id
  status.library['root'] = source.source.library_root
  Object.assign(status.skill, {
    id: source.id,
    path: source.root,
    accepted_hash: source.content_hash,
    working_hash: source.content_hash,
    acceptance: 'accepted',
  })
  const library = {
      id: source.source.library_id,
      root: { hostId: 'local', path: source.source.library_root },
      gitMode: 'disabled',
    },
    workspace = {
      id: 'exact-workspace',
      host: 'local',
      root: { hostId: 'local', path: '/owned-fixture/mode-change-codex' },
    }
  const input = {
    library,
    skillId: source.id,
    hash: source.content_hash,
    agent: 'codex',
    mode: 'native',
  }
  const calls: string[][] = [],
    outputs = new Map<string, unknown>()
  const removal = JSON.parse(
    readFileSync(
      'test/fixtures/skillager-management/codex-mode-remove-preview.json',
      'utf8',
    ),
  ) as { schema: string; results: Array<Value> }
  let serial = 0,
    outcome = 'interrupted',
    statusHash = source.content_hash,
    supportedRemoval = false,
    absent = false,
    canonicalPending = false,
    materializedHash: string | undefined,
    sourceBinding: Value = {},
    malformedExposures: unknown,
    applied = false
  const client = {
    alive: true,
    request(capability: string, input: Value) {
      if (capability === 'terminal.start')
        return Promise.resolve({ status: 'handed-off', request: input })
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
      const args = input['args'] as string[]
      calls.push(args)
      const receipt = String(++serial)
      let value: unknown = status
      if (args[0] === 'expose') {
        if (args.includes('--remove') && supportedRemoval) {
          value = args.includes('--yes')
            ? { ...removal, results: [{ ...removal.results[0], status: 'removed' }] }
            : removal
          if (args.includes('--yes')) absent = true
        } else if (args.includes('--dry-run')) value = previews
        else if (args.includes('--list'))
          value = {
            schema: 'skillager.exposures.v1',
            exposures: absent
              ? []
              : [
                  {
                    ...preview,
                    status: 'current',
                    source_library_id: library.id,
                    current_hash: materializedHash ?? statusHash,
                  },
                ],
          }
        else {
          if (outcome !== 'completed')
            return Promise.resolve({ outcome, reason: 'cancelled', receipt })
          applied = true
          value = [{ ...preview, status: 'exposed' }]
        }
      }
      status.skill['exposures'] = applied
        ? [
            {
              agent: preview.agent,
              scope: preview.scope,
              path: preview.target,
              kind: preview.mode,
              status: 'current',
              source_hash: statusHash,
              source_library_id: library.id,
              ...sourceBinding,
            },
          ]
        : []
      if (applied && malformedExposures !== undefined)
        status.skill['exposures'] = malformedExposures
      status.skill['working_hash'] = statusHash
      status.skill['accepted_hash'] = statusHash
      status.skill['acceptance'] = canonicalPending ? 'pending' : 'accepted'
      outputs.set(receipt, value)
      return Promise.resolve({ outcome: 'completed', code: 0, receipt, truncated: false })
    },
  }
  const invoke = (
    action: string,
    input: unknown = {},
    context: unknown = { workspace },
    admittedCaller = caller,
  ) =>
    module.executeManagement(client, {
      id: `main-issued-${++serial}`,
      action,
      input,
      context,
      caller: admittedCaller,
      authorization: admittedCaller === 'agent' ? 'standing' : 'unapproved',
    })
  return {
    invoke,
    input,
    calls,
    workspace,
    source,
    preview,
    client,
    removal,
    supportRemoval: () => {
      supportedRemoval = true
    },
    canonicalPending: () => {
      canonicalPending = true
    },
    outcome: (value: string) => {
      outcome = value
    },
    hash: (value: string) => {
      statusHash = value
    },
    stub: () => {
      const values = JSON.parse(
        readFileSync(
          'test/fixtures/skillager-management/codex-exact-mode-update-preview.json',
          'utf8',
        ),
      ) as Exposure[]
      Object.assign(preview, values[0])
      materializedHash = 'b'.repeat(64)
      return {
        ...input,
        mode: 'stub',
        exposureId: preview.exposure_id,
        target: { hostId: 'local', path: preview.target },
        token: preview.preview.confirmation_token,
      }
    },
    malformedExposures: (value: unknown) => {
      malformedExposures = value
    },
    sourceBinding: (value: Value) => {
      sourceBinding = value
    },
    pinAcceptedSource: () => {
      source.trust = 'pinned'
      status.skill['trust'] = 'pinned'
    },
  }
}
it('quietly adds an exact publicly accepted pinned canonical source without changing its decision', async () => {
  const f = fixture()
  f.pinAcceptedSource()
  f.outcome('completed')
  const result = await f.invoke('add-copy', f.input)
  expect(result['outcome']).toBe('verified')
  expect(f.calls.filter((args) => args.includes('--yes'))).toHaveLength(1)
  expect(
    f.calls.some(
      (args) =>
        args.includes('review') || args.includes('accept') || args.includes('--force'),
    ),
  ).toBe(false)
  expect(f.source.trust).toBe('pinned')
})
it.each(['', 'bad', undefined])(
  'rejects malformed/missing mutation hash %s before CLI dispatch',
  async (hash) => {
    const f = fixture()
    const result = await f.invoke('add-copy', { ...f.input, hash })
    expect(result['outcome']).toBe('refused')
    expect(result['message']).toMatch(/exact accepted source hash/)
    expect(f.calls).toEqual([])
  },
)
it('refuses accepted-version drift before mutation rather than silently selecting a newer hash', async () => {
  const f = fixture()
  f.hash('a'.repeat(64))
  const result = await f.invoke('add-copy', f.input)
  expect(result['outcome']).toBe('refused')
  expect(result['message']).toMatch(/version changed/)
  expect(f.calls.some((args) => args.includes('--yes'))).toBe(false)
})
it.each(['guest', 'agent'])(
  'retains exact unknown Add across later %s invocations; scopes reports and requires supported explicit reconciliation',
  async (caller) => {
    const f = fixture(caller)
    const first = await f.invoke('add-copy', f.input)
    expect(first['outcome']).toBe('uncertain')
    expect(typeof first['operationId']).toBe('string')
    const operationId = first['operationId'] as string
    expect(await f.invoke('operation-state', { mode: 'list' })).toEqual({
      ids: [operationId],
    })
    const report = await f.invoke('operation-state', { mode: 'report', operationId })
    expect(JSON.parse(report['data'] as string)).toMatchObject({
      operation: {
        caller,
        target: { hostId: 'local', path: f.preview.target },
        workspace: f.workspace,
        source: { hash: f.source.content_hash },
      },
    })
    expect(
      await f.invoke(
        'operation-state',
        { mode: 'list' },
        { workspace: { ...f.workspace, id: 'different-workspace' } },
      ),
    ).toEqual({ ids: [] })
    await expect(
      f.invoke(
        'operation-state',
        { mode: 'report', operationId },
        { workspace: f.workspace },
        caller === 'agent' ? 'guest' : 'agent',
      ),
    ).rejects.toThrow(/caller class/)
    f.outcome('completed')
    const result = await f.invoke('add-copy', f.input)
    expect(result['outcome']).toBe('refused')
    expect(result['message']).toMatch(/Reconcile exact unknown/)
    expect(f.calls.filter((args) => args.includes('--yes'))).toHaveLength(1)
    // Public removal preview is unavailable in this fake port; failed observations cannot release uncertainty.
    await expect(
      f.invoke('operation-state', {
        mode: 'acknowledge',
        operationId,
        observation: '{}',
      }),
    ).resolves.toMatchObject({ outcome: 'refused' })
    expect(await f.invoke('operation-state', { mode: 'list' })).toEqual({
      ids: [operationId],
    })
  },
)
it.each(['codex', 'claude'])(
  'binds %s setup agent and exact local destination without a library-readiness prerequisite',
  async (agent) => {
    const f = fixture()
    await expect(f.invoke('setup-project', { agent })).resolves.toMatchObject({
      status: 'handed-off',
      request: {
        connector: 'project-cli',
        workspace: f.workspace.id,
        args: ['setup', '--agent', agent],
      },
    })
    expect(f.calls).toEqual([])
    await expect(
      f.invoke(
        'setup-project',
        { agent },
        { workspace: { ...f.workspace, host: 'ssh' } },
      ),
    ).rejects.toThrow(/local/)
  },
)
it('verifies ordinary Add public result and exact current managed record, then leaves no uncertain descriptor', async () => {
  const f = fixture()
  f.outcome('completed')
  await expect(f.invoke('add-copy', f.input)).resolves.toMatchObject({
    outcome: 'verified',
    target: { hostId: 'local', path: f.preview.target },
  })
  expect(await f.invoke('operation-state', { mode: 'list' })).toEqual({ ids: [] })
  const mutations = f.calls.filter((args) => args.includes('--yes'))
  expect(mutations).toHaveLength(1)
  expect(mutations[0]).toContain(f.preview.preview.confirmation_token)
  expect(mutations[0]).not.toContain('--force')
})
it('verifies a transformed Stub using its public canonical source binding, independently of the target hash', async () => {
  const f = fixture()
  const input = f.stub()
  f.outcome('completed')
  const result = await f.invoke('update-copy', input)
  expect(result['outcome']).toBe('verified')
  expect(result['mode']).toBe('stub')
  expect(f.calls.at(-1)).toEqual(['library', 'status', f.source.id, '--json'])
  expect(await f.invoke('operation-state', { mode: 'list' })).toEqual({ ids: [] })
})
it.each([
  { source_hash: 'c'.repeat(64) },
  { source_library_id: '00000000-0000-0000-0000-000000000000' },
  { path: '/different-target' },
  { status: 'modified' },
  { kind: 'native' },
])(
  'retains uncertain Stub completion for mismatched public source binding %j',
  async (binding) => {
    const f = fixture()
    const input = f.stub()
    f.outcome('completed')
    f.sourceBinding(binding)
    const result = await f.invoke('update-copy', input)
    expect(result['outcome']).toBe('uncertain')
    expect(result['message']).toMatch(/source-bound exposure disagree/)
    expect(typeof result['operationId']).toBe('string')
    expect(f.calls.filter((args) => args.includes('--yes'))).toHaveLength(1)
    expect(await f.invoke('operation-state', { mode: 'list' })).toEqual({
      ids: [result['operationId']],
    })
  },
)
it.each([{ metadata: null }, { metadata: {} }, { metadata: [null] }])(
  'retains uncertain completion for malformed source exposure metadata %j',
  async ({ metadata }) => {
    const f = fixture()
    const input = f.stub()
    f.outcome('completed')
    f.malformedExposures(metadata)
    const result = await f.invoke('update-copy', input)
    expect(result['outcome']).toBe('uncertain')
    expect(result['message']).toMatch(/source-bound exposure disagree/)
    expect(await f.invoke('operation-state', { mode: 'list' })).toEqual({
      ids: [result['operationId']],
    })
  },
)
it.each(['guest', 'agent'])(
  'lets the original %s reconcile fresh current facts without claiming historical completion or replaying',
  async (caller) => {
    const f = fixture(caller)
    f.supportRemoval()
    const first = await f.invoke('add-copy', f.input),
      operationId = first['operationId'] as string
    const observed = await f.invoke('operation-state', { mode: 'observe', operationId })
    expect(observed['outcome']).toBe('observed')
    expect(observed['message']).toMatch(/Original completion remains unknown/)
    const facts = observed['observation'] as string
    f.hash('c'.repeat(64))
    await expect(
      f.invoke('operation-state', {
        mode: 'acknowledge',
        operationId,
        observation: facts,
      }),
    ).resolves.toMatchObject({ outcome: 'refused' })
    expect(await f.invoke('operation-state', { mode: 'list' })).toEqual({
      ids: [operationId],
    })
    const fresh = await f.invoke('operation-state', { mode: 'observe', operationId })
    const reconciled = await f.invoke('operation-state', {
      mode: 'acknowledge',
      operationId,
      observation: fresh['observation'],
    })
    expect(reconciled['outcome']).toBe('reconciled')
    expect(reconciled['message']).toContain('Original completion remains unknown')
    expect(await f.invoke('operation-state', { mode: 'list' })).toEqual({ ids: [] })
    expect(f.calls.filter((args) => args.includes('--yes'))).toHaveLength(1)
  },
)
it('removes the reviewed managed target while its canonical source is pending without canonical reacceptance', async () => {
  const f = fixture()
  f.supportRemoval()
  f.canonicalPending()
  const argv = f.removal.results[0]!['next_command_argv'] as string[],
    token = argv[argv.indexOf('--confirmation-token') + 1]
  await expect(
    f.invoke('remove-copy', {
      library: f.input.library,
      exposureId: f.preview.exposure_id,
      agent: 'codex',
      target: { hostId: 'local', path: f.preview.target },
      token,
    }),
  ).resolves.toMatchObject({ outcome: 'verified' })
  expect(f.calls.filter((args) => args[0] === 'library')).toEqual([
    ['library', 'status', '--json'],
  ])
  expect(f.calls.filter((args) => args.includes('--yes'))).toHaveLength(1)
  expect(await f.invoke('operation-state', { mode: 'list' })).toEqual({ ids: [] })
})
