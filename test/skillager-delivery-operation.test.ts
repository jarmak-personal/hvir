import { buildSync } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
type Value = Record<string, unknown>
interface Module {
  prepareDelivery(
    client: unknown,
    input: Value,
    workspace: Value,
    kind?: string,
  ): Promise<Value>
  applyPreparedDelivery(client: unknown, prepared: Value): Promise<Value>
  executeDelivery(client: unknown, invocation: Value): Promise<Value>
  compactDeliveryMetadata(client: unknown, workspace: Value): Promise<void>
}
interface ViewModule {
  bindDeliveryView(document: unknown, client: unknown, ports: unknown): unknown
}
function fixture() {
  const sandbox = {
    TextEncoder,
    Module: undefined as unknown,
    View: undefined as unknown,
  }
  runInNewContext(
    buildSync({
      entryPoints: ['packages/skillager-extension/src/delivery-operation.mjs'],
      bundle: true,
      format: 'iife',
      globalName: 'Module',
      write: false,
    }).outputFiles[0]!.text,
    sandbox,
  )
  runInNewContext(
    buildSync({
      entryPoints: ['packages/skillager-extension/src/delivery-view.mjs'],
      bundle: true,
      format: 'iife',
      globalName: 'View',
      write: false,
    }).outputFiles[0]!.text,
    sandbox,
  )
  const module = sandbox.Module as Module,
    hash = 'a'.repeat(64),
    sha256 = createHash('sha256').update('payload').digest('hex'),
    library = {
      id: '01234567-89ab-cdef-0123-456789abcdef',
      root: { hostId: 'local', path: '/library' },
      gitMode: 'disabled',
    },
    workspace = {
      id: 'remote-workspace',
      host: 'ssh:remote',
      root: { hostId: 'ssh:remote', path: '/project' },
    },
    input = {
      library,
      skillId: 'lib/skill',
      hash,
      agent: 'codex',
      mode: 'native',
      exportDirectory: '/exports/one',
    },
    files = [{ path: 'SKILL.md', mode: 0o664, size: 7, sha256 }],
    calls: { capability: string; input: Value }[] = [],
    outputs = new Map<string, unknown>()
  let domain: unknown = null,
    revision = 'revision-0',
    serial = 0,
    statusHash = hash,
    exportChange: Value = {},
    application: Value = { outcome: 'completed', operation: 'operation' },
    applyFails = false
  let records: Value[] = [],
    operations: Value[] = [],
    pending: Value = {},
    previews = 0,
    journalRevision = 0
  const client = {
    alive: true,
    async request(capability: string, request: Value) {
      await Promise.resolve()
      calls.push({ capability, input: request })
      if (capability === 'connector.execute') {
        expect(request['connector']).toBe('library-cli')
        expect(request['host']).toBe('local')
        expect(request['workspace']).toBeUndefined()
        const args = request['args'] as string[],
          receipt = String(++serial)
        if (args[0] === 'library')
          outputs.set(receipt, {
            schema: 'skillager.library-status.v1',
            initialized: true,
            library: {
              library_id: library.id,
              root: library.root.path,
              registration: 'valid',
            },
            git: { mode: 'disabled' },
            skill: {
              id: input.skillId,
              acceptance: 'accepted',
              accepted_hash: statusHash,
              working_hash: statusHash,
              path: '/library/skills/skill',
            },
          })
        else if (args[0] === 'show')
          outputs.set(receipt, {
            skill: {
              id: input.skillId,
              content_hash: hash,
              trust: 'reviewed',
              compatibility: { env: ['API_TOKEN'] },
              targets: {},
              activation: 'manual',
            },
          })
        else if (args[0] === 'export')
          outputs.set(receipt, {
            schema: 'skillager.export.v1',
            status: 'exported',
            id: input.skillId,
            library_id: library.id,
            agent: 'codex',
            scope: 'export',
            destination: input.exportDirectory,
            content_hash: hash,
            files,
            ...exportChange,
          })
        else throw new Error('Unexpected native operation')
        return { outcome: 'completed', receipt, code: 0, truncated: false }
      }
      if (capability === 'connector.output')
        return request['release']
          ? null
          : {
              data:
                request['stream'] === 'stderr'
                  ? ''
                  : JSON.stringify(outputs.get(String(request['receipt']))),
              nextOffset: null,
            }
      if (capability === 'delivery.capture') {
        expect(
          calls.some(
            (call) =>
              call.capability === 'connector.output' &&
              call.input['receipt'] === request['nativeReceipt'] &&
              call.input['release'],
          ),
        ).toBe(false)
        return {
          receipt: 'capture',
          root: { hostId: 'local', path: input.exportDirectory },
        }
      }
      if (capability === 'delivery.manifest')
        return request['release']
          ? null
          : {
              entries: [
                { path: '', type: 'dir', mode: 0o755, size: 0 },
                ...files.map((file) => ({ ...file, type: 'file' })),
              ],
              nextOffset: null,
            }
      if (capability === 'delivery.status')
        return {
          entries: request['kind'] === 'operations' ? operations : records,
          nextOffset: null,
          revision: `journal-${journalRevision}`,
        }
      if (capability === 'delivery.domain') {
        if (request['write']) {
          expect(request['expected']).toBe(revision)
          if (request['journalRevision'])
            expect(request['journalRevision']).toBe(`journal-${journalRevision}`)
          domain = request['value']
          revision = `revision-${++serial}`
          return null
        }
        return { value: domain, revision }
      }
      if (capability === 'delivery.preview') {
        previews++
        pending = {
          ...request,
          operation: previews === 1 ? 'operation' : `operation-${previews}`,
        }
        return {
          receipt: 'preview',
          operation: pending['operation'],
          target: request['target'],
          parents: [
            { hostId: workspace.host, path: '/project/.agents' },
            { hostId: workspace.host, path: '/project/.agents/skills' },
          ],
          recordEffect: 'record-exact-delivery',
        }
      }
      if (capability === 'delivery.apply') {
        if (applyFails) throw new Error('Disconnected reply')
        if (application['outcome'] === 'completed') {
          const previous = records[0]
          records =
            pending['kind'] === 'remove'
              ? []
              : [
                  {
                    id: 'record',
                    operation: pending['operation'],
                    target: pending['target'],
                    sourceVersion: pending['sourceVersion'],
                    workspace: workspace.id,
                    root: workspace.root,
                  },
                ]
          if (previous)
            operations.push({
              id: pending['operation'],
              phase: 'completed',
              sourceVersion: pending['sourceVersion'] ?? previous['sourceVersion'],
              workspace: workspace.id,
              root: workspace.root,
              target: pending['target'],
              previousOperation: previous['operation'],
            })
          journalRevision++
        }
        return {
          ...application,
          operation: pending['operation'],
          ...(records[0] ? { record: records[0] } : {}),
        }
      }
      throw new Error(`Unexpected capability ${capability}`)
    },
  }
  return {
    module,
    view: sandbox.View as ViewModule,
    client,
    input,
    workspace,
    calls,
    files,
    changeExport: (value: Value) => {
      exportChange = value
    },
    changeSource: () => {
      statusHash = 'b'.repeat(64)
    },
    lostReply: (value = true) => {
      applyFails = value
    },
    result: (value: Value) => {
      application = value
    },
    domain: () => domain as { deliveries: Value[] },
    records: () => records,
    cleanup: (id: unknown) => {
      operations = operations.filter((entry) => entry['id'] !== id)
      journalRevision++
    },
  }
}
it('ordinary human delivery shows the complete public manifest before apply and rejects changed review selection', async () => {
  const f = fixture()
  const elements: Record<string, { value: string }> = {
    'copy-agent': { value: 'codex' },
    'copy-mode': { value: 'native' },
    'delivery-export': { value: '/exports/one' },
    'skill-id': { value: 'lib/skill' },
  }
  const callbacks = new Map<
    string,
    (event: unknown, current: () => boolean) => Promise<void>
  >()
  let reviewed: Value | undefined,
    task:
      | { validateSelection(): void; perform(): Promise<void>; release(): Promise<void> }
      | undefined
  f.view.bindDeliveryView({ getElementById: (id: string) => elements[id] }, f.client, {
    source: () => ({ id: f.input['skillId'], hash: f.input['hash'] }),
    library: () => f.input['library'],
    context: () => ({ workspace: f.workspace }),
    on: (
      id: string,
      _event: string,
      callback: (event: unknown, current: () => boolean) => Promise<void>,
    ) => callbacks.set(id, callback),
    onSelection: () => {},
    review: (_title: string, _message: string, value: Value, actions: typeof task) => {
      reviewed = value
      task = actions
    },
    show: () => {},
    say: () => {},
  })
  await callbacks.get('prepare-delivery')!(undefined, () => true)
  expect(reviewed).toMatchObject({
    files: [
      { path: '', type: 'dir' },
      { path: 'SKILL.md', mode: 0o664, sha256: f.files[0]!.sha256 },
    ],
    parents: expect.any(Array) as unknown,
    requirements: { compatibility: { env: ['API_TOKEN'] } },
  })
  expect(f.calls.some((call) => call.capability === 'delivery.apply')).toBe(false)
  elements['copy-agent']!.value = 'claude'
  expect(() => task!.validateSelection()).toThrow(/selection changed/)
  elements['copy-agent']!.value = 'codex'
  task!.validateSelection()
  await task!.perform()
  expect(f.calls.filter((call) => call.capability === 'delivery.apply')).toHaveLength(1)
  expect(
    f.calls.filter(
      (call) => call.capability === 'delivery.manifest' && call.input['release'],
    ),
  ).toHaveLength(1)
})
it('uses only the local installed connector to export, capture and compare every file/mode before SSH preview and apply', async () => {
  const f = fixture(),
    prepared = await f.module.prepareDelivery(f.client, f.input, f.workspace)
  expect(prepared['entries']).toEqual([
    { path: '', type: 'dir', mode: 0o755, size: 0 },
    ...f.files.map((file) => ({ ...file, type: 'file' })),
  ])
  expect(prepared['requirements']).toMatchObject({
    compatibility: { env: ['API_TOKEN'] },
  })
  expect(prepared['preview']).toMatchObject({
    target: { hostId: 'ssh:remote', path: '/project/.agents/skills/skill' },
    parents: expect.any(Array) as unknown,
  })
  expect(await f.module.applyPreparedDelivery(f.client, prepared)).toMatchObject({
    outcome: 'completed',
  })
  const native = f.calls
    .filter((call) => call.capability === 'connector.execute')
    .map((call) => call.input['args'] as string[])
  expect(native.some((args) => ['working', 'setup', 'expose'].includes(args[0]!))).toBe(
    false,
  )
  expect(native.find((args) => args[0] === 'export')).toEqual([
    'export',
    'lib/skill',
    '--version',
    'a'.repeat(64),
    '--agent',
    'codex',
    '--dest',
    '/exports/one',
    '--json',
  ])
  expect(
    f.calls.findIndex(
      (call) => call.capability === 'delivery.domain' && call.input['write'],
    ),
  ).toBeLessThan(f.calls.findIndex((call) => call.capability === 'delivery.apply'))
  expect(
    f.calls.filter(
      (call) => call.capability === 'delivery.manifest' && call.input['release'],
    ),
  ).toHaveLength(1)
})
it.each([
  { library_id: 'foreign' },
  { content_hash: 'b'.repeat(64) },
  { files: [{ path: '../outside', mode: 0o664, size: 7, sha256: 'a'.repeat(64) }] },
  { files: [{ path: 'SKILL.md', mode: 0o4755, size: 7, sha256: 'a'.repeat(64) }] },
])(
  'refuses a mismatched complete public export without remote preview or publication',
  async (mismatch) => {
    const f = fixture()
    f.changeExport(mismatch)
    await expect(
      f.module.prepareDelivery(f.client, f.input, f.workspace),
    ).rejects.toThrow()
    expect(
      f.calls.some(
        (call) =>
          call.capability === 'delivery.preview' || call.capability === 'delivery.apply',
      ),
    ).toBe(false)
  },
)
it('refuses Stub, source advancement, and target retargeting while releasing retained captures', async () => {
  const f = fixture()
  await expect(
    f.module.prepareDelivery(f.client, { ...f.input, mode: 'stub' }, f.workspace),
  ).rejects.toThrow(/Full only/)
  await expect(
    f.module.prepareDelivery(
      f.client,
      { ...f.input, target: { hostId: 'ssh:remote', path: '/other' } },
      f.workspace,
    ),
  ).rejects.toThrow(/target/)
  const prepared = await f.module.prepareDelivery(f.client, f.input, f.workspace)
  f.changeSource()
  await expect(f.module.applyPreparedDelivery(f.client, prepared)).rejects.toThrow(
    /version changed/,
  )
  expect(f.calls.some((call) => call.capability === 'delivery.apply')).toBe(false)
  expect(f.calls.at(-1)).toMatchObject({
    capability: 'delivery.manifest',
    input: { release: true },
  })
})
it('keeps a lost apply response uncertain with its exact operation and no automatic replay', async () => {
  const f = fixture()
  f.lostReply()
  expect(
    await f.module.executeDelivery(f.client, {
      action: 'add-copy',
      input: f.input,
      context: { workspace: f.workspace },
      caller: 'agent',
      authorization: 'standing',
    }),
  ).toMatchObject({ outcome: 'uncertain', operation: 'operation' })
  expect(f.calls.filter((call) => call.capability === 'delivery.apply')).toHaveLength(1)
  expect(f.domain().deliveries).toMatchObject([
    { state: 'pending', operation: 'operation' },
  ])
})
it('compacts proven historical metadata after retained cleanup while keeping current and preserved identities', async () => {
  const f = fixture()
  await f.module.applyPreparedDelivery(
    f.client,
    await f.module.prepareDelivery(f.client, f.input, f.workspace),
  )
  expect(f.domain().deliveries).toMatchObject([
    { state: 'settled', operation: 'operation' },
  ])
  const update = { ...f.input, record: 'record', target: f.records()[0]!['target'] }
  await f.module.applyPreparedDelivery(
    f.client,
    await f.module.prepareDelivery(f.client, update, f.workspace, 'update'),
  )
  expect(f.domain().deliveries.map((entry) => entry['operation'])).toEqual([
    'operation',
    'operation-2',
  ])
  f.cleanup('operation-2')
  await f.module.compactDeliveryMetadata(f.client, f.workspace)
  expect(f.domain().deliveries.map((entry) => entry['operation'])).toEqual([
    'operation-2',
  ])
  for (let index = 0; index < 12; index++) {
    const result = await f.module.applyPreparedDelivery(
      f.client,
      await f.module.prepareDelivery(f.client, update, f.workspace, 'update'),
    )
    expect(f.domain().deliveries).toHaveLength(2)
    f.cleanup(result['operation'])
    await f.module.compactDeliveryMetadata(f.client, f.workspace)
    expect(f.domain().deliveries).toHaveLength(1)
  }
  const removed = await f.module.applyPreparedDelivery(
    f.client,
    await f.module.prepareDelivery(f.client, update, f.workspace, 'remove'),
  )
  expect(f.domain().deliveries).toHaveLength(2)
  f.cleanup(removed['operation'])
  await f.module.compactDeliveryMetadata(f.client, f.workspace)
  expect(f.domain().deliveries).toEqual([])
})
it('discards only a proven effect-free refused intent while preserving old managed identity', async () => {
  const f = fixture()
  await f.module.applyPreparedDelivery(
    f.client,
    await f.module.prepareDelivery(f.client, f.input, f.workspace),
  )
  f.result({ outcome: 'refused' })
  const input = { ...f.input, record: 'record', target: f.records()[0]!['target'] }
  const result = await f.module.applyPreparedDelivery(
    f.client,
    await f.module.prepareDelivery(f.client, input, f.workspace, 'update'),
  )
  expect(result).toMatchObject({ outcome: 'refused' })
  expect(f.domain().deliveries).toMatchObject([
    { operation: 'operation', state: 'settled' },
  ])
  expect(f.domain().deliveries).toHaveLength(1)
})
it('keeps unknown pending metadata through a later proven update and cleanup', async () => {
  const f = fixture()
  await f.module.applyPreparedDelivery(
    f.client,
    await f.module.prepareDelivery(f.client, f.input, f.workspace),
  )
  const input = { ...f.input, record: 'record', target: f.records()[0]!['target'] }
  f.lostReply()
  expect(
    await f.module.applyPreparedDelivery(
      f.client,
      await f.module.prepareDelivery(f.client, input, f.workspace, 'update'),
    ),
  ).toMatchObject({ outcome: 'uncertain' })
  f.lostReply(false)
  const result = await f.module.applyPreparedDelivery(
    f.client,
    await f.module.prepareDelivery(f.client, input, f.workspace, 'update'),
  )
  f.cleanup(result['operation'])
  await f.module.compactDeliveryMetadata(f.client, f.workspace)
  expect(f.domain().deliveries).toMatchObject([
    { operation: 'operation-2', state: 'pending' },
    { operation: 'operation-3', state: 'settled' },
  ])
})
it('refuses finite retained metadata capacity without discarding identities needed for preserved copies', async () => {
  const f = fixture()
  await f.module.applyPreparedDelivery(
    f.client,
    await f.module.prepareDelivery(f.client, f.input, f.workspace),
  )
  const input = { ...f.input, record: 'record', target: f.records()[0]!['target'] }
  let refused = false
  for (let index = 0; index < 32; index++) {
    const before = structuredClone(f.domain())
    const effects = f.calls.filter((call) => call.capability === 'delivery.apply').length
    try {
      await f.module.applyPreparedDelivery(
        f.client,
        await f.module.prepareDelivery(f.client, input, f.workspace, 'update'),
      )
    } catch (reason) {
      expect(String(reason)).toMatch(/capacity is full/)
      expect(f.domain()).toEqual(before)
      expect(f.calls.filter((call) => call.capability === 'delivery.apply')).toHaveLength(
        effects,
      )
      refused = true
      break
    }
  }
  expect(refused).toBe(true)
  expect(f.domain().deliveries.length).toBeGreaterThan(1)
  expect(f.domain().deliveries.every((entry) => entry['state'] === 'settled')).toBe(true)
})
