import { expect, it } from 'vitest'
import { fixture } from './fixtures/skillager-delivery'
type Value = Record<string, unknown>
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
