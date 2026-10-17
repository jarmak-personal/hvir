import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { deliveryFixture, deliveryBarrier } from './fixtures/extension-delivery'
import { extensionInstallationFixture } from './fixtures/extension-installation'
import { hostPath } from '../src/shared/host-path'
import {
  retainedDeliveryBytes,
  proveDeliveryJournalCapacity,
} from '../src/main/extensions/delivery-journal'
import type { DeliveryJournal } from '../src/main/extensions/delivery-journal'
const fixtures: Awaited<ReturnType<typeof deliveryFixture>>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.dispose()
})
async function fixture() {
  const f = await deliveryFixture()
  fixtures.push(f)
  return f
}
it('never replaces an unreadable delivery journal during Settings forgetting', async () => {
  const f = await fixture(),
    data = await extensionInstallationFixture()
  f.authority.readManagedDeliveries.mockRejectedValueOnce(new Error('bad journal'))
  const failed = await f.make()
  const activation = data.make(undefined, (id, persisted) => failed.forget(id, persisted))
  try {
    await data.packageAt('reference')
    await activation.start(data.lock)
    await activation.enable(
      'reference',
      activation.snapshot().installations[0]!.revision!,
    )
    const path = join(data.root, 'deliveries.json'),
      raw = '{broken evidence'
    await fs.writeFile(path, raw)
    const selected = activation.snapshot().installations[0]!
    await expect(
      activation.remove(selected.source, selected.sourceIdentity, true),
    ).rejects.toThrow(/Delivery state/)
    expect(await fs.readFile(path, 'utf8')).toBe(raw)
    expect(() => failed.forget('any', { records: [], operations: [] })).toThrow(
      /cannot be read safely/,
    )
  } finally {
    await activation.dispose()
    await failed.dispose()
    await data.dispose()
  }
})
it('stages forgetting from persisted evidence and publishes cache removal only after a successful write', async () => {
  const f = await fixture(),
    add = await f.owner.apply(f.caller, await f.preview('add'))
  const persisted = f.persisted()
  const update = await f.owner.apply(
    f.caller,
    await f.preview('update', f.owner, add.record!.id, 'new'),
  )
  const fresh = f.persisted()
  // Simulate a newer persisted operation than a staged cache snapshot: forgetting uses the exact D2 read.
  const decision = f.owner.forget(f.activation.installationId, fresh)
  expect(decision.journal.operations[0]?.id).toBe(update.operation)
  expect(f.owner.status(f.caller, { offset: 0 })).toMatchObject({
    entries: [{ operation: update.operation }],
  })
  f.authority.saveManagedDeliveries.mockRejectedValueOnce(
    new Error('failed forgetting write'),
  )
  await expect(
    f.authority.saveManagedDeliveries(decision.journal, () => {}),
  ).rejects.toThrow(/failed/)
  expect(f.owner.status(f.caller, { offset: 0 })).toMatchObject({
    entries: [{ operation: update.operation }],
  })
  await f.authority.saveManagedDeliveries(decision.journal, () => {})
  decision.commitJournal()
  decision.commitDomain()
  expect(f.owner.status(f.caller, { offset: 0 })).toMatchObject({ entries: [] })
  expect(f.persisted().operations[0]?.id).toBe(update.operation)
  expect(persisted.records[0]?.record.operation).toBe(add.operation)
})
it('forgets through the real D2 queue after an in-flight completion without losing retained evidence or deadlocking', async () => {
  const data = await extensionInstallationFixture()
  let f: Awaited<ReturnType<typeof deliveryFixture>> | undefined
  const activation = data.make(undefined, (id, persisted) =>
    f!.owner.forget(id, persisted),
  )
  const blocked = deliveryBarrier()
  try {
    await data.packageAt('reference')
    await activation.start(data.lock)
    await activation.enable(
      'reference',
      activation.snapshot().installations[0]!.revision!,
    )
    const selected = activation.snapshot().installations[0]!
    f = await deliveryFixture(selected.installationId)
    fixtures.push(f)
    const current = f
    current.authority.saveManagedDeliveries.mockImplementation(async (value, check) => {
      await activation.saveManagedDeliveries(value, check)
      current.setPersisted(value as DeliveryJournal)
    })
    data.revoke.mockImplementation((id: string) => {
      current.active.delete(id)
      current.owner.revoke(id)
    })
    const add = await current.owner.apply(current.caller, await current.preview('add'))
    const plan = await current.preview('update', current.owner, add.record!.id, 'new')
    const write = data.host.writeFile.bind(data.host)
    vi.spyOn(data.host, 'writeFile').mockImplementation(
      async (path, content, options) => {
        if (
          path.path.endsWith('/deliveries.json') &&
          typeof content === 'string' &&
          content.includes('"phase":"completed"')
        ) {
          blocked.enter()
          await blocked.blocked
        }
        return write(path, content, options)
      },
    )
    const applying = current.owner.apply(current.caller, plan)
    await blocked.reached
    const forgetting = activation.remove(selected.source, selected.sourceIdentity, true)
    blocked.resume()
    await Promise.allSettled([applying, forgetting]).then((results) => {
      expect(results[1].status).toBe('fulfilled')
    })
    const saved = (await activation.readManagedDeliveries()) as DeliveryJournal
    expect(saved.records).toEqual([])
    expect(saved.operations).toMatchObject([
      { id: plan.operation, phase: 'completed', previous: { operation: add.operation } },
    ])
    expect(await fs.readFile(join(current.target.path, 'SKILL.md'), 'utf8')).toBe('new')
    expect(
      await fs.readFile(join(saved.operations[0]!.preserve.path, 'SKILL.md'), 'utf8'),
    ).toBe('approved')
    expect(activation.hasInstallationIdentity(selected.installationId!)).toBe(false)
  } finally {
    blocked.resume()
    await activation.dispose()
    await data.dispose()
  }
})
it.each([
  'changed-before-displacement',
  'occupied-after-displacement',
  'occupied-at-publication',
])(
  'persists known %s conflicts with exact retained locations instead of uncertain completion',
  async (kind) => {
    const f = await fixture(),
      add = await f.owner.apply(f.caller, await f.preview('add'))
    const plan = await f.preview('update', f.owner, add.record!.id, 'next')
    if (kind === 'changed-before-displacement') {
      const write = vi
        .spyOn(f.remote.managedTransfer!, 'writeFileChunksExclusive')
        .getMockImplementation()!
      vi.spyOn(f.remote.managedTransfer!, 'writeFileChunksExclusive').mockImplementation(
        async (...args) => {
          await write(...args)
          await fs.writeFile(join(f.target.path, 'SKILL.md'), 'foreign edit')
        },
      )
    } else {
      const rename = vi
        .spyOn(f.remote.fileTransfer!, 'renameNoReplace')
        .getMockImplementation()!
      vi.spyOn(f.remote.fileTransfer!, 'renameNoReplace').mockImplementation(
        async (from, to, options) => {
          if (kind === 'occupied-at-publication' && from.path.endsWith('-stage')) {
            await fs.mkdir(f.target.path)
            await fs.writeFile(join(f.target.path, 'foreign'), 'keep')
          }
          await rename(from, to, options)
          if (kind === 'occupied-after-displacement' && to.path.endsWith('-preserved')) {
            await fs.mkdir(f.target.path)
            await fs.writeFile(join(f.target.path, 'foreign'), 'keep')
          }
        },
      )
    }
    const result = await f.owner.apply(f.caller, plan)
    expect(result).toMatchObject({
      outcome: 'conflicted',
      operation: plan.operation,
      staging: expect.any(Object) as unknown,
      preserved: expect.any(Object) as unknown,
    })
    expect(f.persisted().operations[0]?.phase).toBe('conflicted')
    expect(await fs.readFile(join(result.staging!.path, 'SKILL.md'), 'utf8')).toBe('next')
    if (kind !== 'changed-before-displacement') {
      expect(await fs.readFile(join(result.preserved!.path, 'SKILL.md'), 'utf8')).toBe(
        'approved',
      )
      expect(await fs.readFile(join(f.target.path, 'foreign'), 'utf8')).toBe('keep')
    }
    expect(
      await f.owner.trustedRecovery(
        'reconcile',
        plan.operation,
        () => {},
        new AbortController().signal,
      ),
    ).toMatchObject({ outcome: 'conflicted', replayed: false })
  },
)
it('does not globally block domain observation, unrelated delivery or recovery behind a hung target', async () => {
  const f = await fixture(),
    add = await f.owner.apply(f.caller, await f.preview('add'))
  const previous = await f.owner.apply(
    f.caller,
    await f.preview('update', f.owner, add.record!.id, 'new'),
  )
  const preview = async (name: string) => {
    const captured = await f.capture(name)
    return await f.owner.preview(f.caller, {
      kind: 'add',
      destination: 'delivery-target',
      target: hostPath(f.root.hostId, join(f.root.path, '.agents', 'skills', name)),
      capture: captured.receipt,
      sourceVersion: name,
    })
  }
  const first = await preview('blocked'),
    second = await preview('independent'),
    blocked = deliveryBarrier()
  const write = vi
    .spyOn(f.remote.managedTransfer!, 'writeFileChunksExclusive')
    .getMockImplementation()!
  let once = true
  vi.spyOn(f.remote.managedTransfer!, 'writeFileChunksExclusive').mockImplementation(
    async (...args) => {
      if (once) {
        once = false
        blocked.enter()
        await blocked.blocked
      }
      return write(...args)
    },
  )
  const pending = f.owner.apply(f.caller, first)
  await blocked.reached
  try {
    let observed = false
    const observation = f.owner.domain(f.caller, {}).then(() => {
      observed = true
    })
    await vi.waitFor(() => expect(observed).toBe(true))
    await observation
    expect(
      await f.owner.trustedRecovery(
        'inspect',
        previous.operation!,
        () => {},
        new AbortController().signal,
      ),
    ).toHaveProperty('token')
    expect(await f.owner.apply(f.caller, second)).toMatchObject({ outcome: 'completed' })
    expect(
      f.persisted().operations.some((entry) => entry.id === previous.operation),
    ).toBe(true)
  } finally {
    blocked.resume()
  }
  expect(await pending).toMatchObject({ outcome: 'completed' })
  expect(f.persisted().records).toHaveLength(3)
})
it('ordinary completed Adds exceed retained-history count without losing current authority', async () => {
  const f = await fixture()
  for (let index = 0; index < 65; index++) {
    const capture = await f.capture('payload')
    const plan = await f.owner.preview(f.caller, {
      destination: 'delivery-target',
      kind: 'add',
      target: hostPath(
        f.root.hostId,
        join(f.root.path, '.agents', 'skills', `skill-${index}`),
      ),
      capture: capture.receipt,
      sourceVersion: 'approved',
    })
    expect(await f.owner.apply(f.caller, plan)).toMatchObject({ outcome: 'completed' })
  }
  expect(f.persisted().records).toHaveLength(65)
  expect(f.persisted().operations).toEqual([])
})
it('charges completed retained old versions and unfinished stages, never published payload history', async () => {
  const f = await fixture(),
    add = await f.owner.apply(f.caller, await f.preview('add'))
  await f.owner.apply(
    f.caller,
    await f.preview('update', f.owner, add.record!.id, 'new payload'),
  )
  const operation = f.persisted().operations[0]!
  expect(retainedDeliveryBytes(operation)).toBe(Buffer.byteLength('approved'))
  expect(retainedDeliveryBytes({ ...operation, phase: 'publishing' })).toBe(
    Buffer.byteLength('approvednew payload'),
  )
})
it('refuses evidence-dependent domain compaction after the observed journal changes', async () => {
  const f = await fixture()
  const domain = (await f.owner.domain(f.caller, {})) as { revision: string }
  const observed = f.owner.status(f.caller, { offset: 0 }) as { revision: string }
  await f.owner.apply(f.caller, await f.preview('add'))
  await expect(
    f.owner.domain(f.caller, {
      write: true,
      expected: domain.revision,
      journalRevision: observed.revision,
      value: { tracking: 'obsolete snapshot' },
    }),
  ).rejects.toThrow(/Delivery evidence changed/)
  expect(f.authority.saveDeliveryDomain).not.toHaveBeenCalled()
})
it('reserves current-record capacity for concurrent pending Adds in the serialized journal preflight', async () => {
  const f = await fixture(),
    add = await f.owner.apply(f.caller, await f.preview('add'))
  await f.owner.apply(f.caller, await f.preview('update', f.owner, add.record!.id, 'new'))
  const journal = f.persisted(),
    entry = journal.records[0]!,
    existing = journal.operations[0]!
  const records = Array.from({ length: 127 }, (_, index) => ({
    ...entry,
    record: { ...entry.record, id: `record-${index}`, operation: `completed-${index}` },
  }))
  const pending = {
    ...existing,
    id: 'pending-add',
    kind: 'add' as const,
    phase: 'intent' as const,
    previous: undefined,
    previousTree: undefined,
  }
  const state = { records, operations: [] }
  expect(() => proveDeliveryJournalCapacity(state, pending)).not.toThrow()
  expect(() =>
    proveDeliveryJournalCapacity(
      { records, operations: [pending] },
      { ...pending, id: 'second-add' },
    ),
  ).toThrow(/record capacity/)
  expect(state.records).toHaveLength(127)
})
it('refuses changed directory metadata at the cleanup effect boundary and retains evidence', async () => {
  const f = await fixture(),
    capture = await f.capture()
  await fs.mkdir(join(capture.root.path, 'a-empty'))
  f.owner.manifest(f.caller, { receipt: capture.receipt, release: true })
  const recaptured = (await f.owner.capture(f.caller, {
    source: 'delivery-source',
    path: capture.root,
    nativeReceipt: 'native',
  })) as { receipt: string }
  const plan = await f.owner.preview(f.caller, {
    kind: 'add',
    destination: 'delivery-target',
    target: f.target,
    capture: recaptured.receipt,
    sourceVersion: 'version',
  })
  const add = await f.owner.apply(f.caller, plan)
  const removed = await f.owner.apply(
    f.caller,
    await f.preview('remove', f.owner, add.record!.id),
  )
  const blocked = deliveryBarrier(),
    remove = vi.mocked(f.remote.removeFile).getMockImplementation()!
  vi.spyOn(f.remote, 'removeFile').mockImplementation(async (...args) => {
    blocked.enter()
    await blocked.blocked
    return remove(...args)
  })
  const cleaning = f.owner.trustedRecovery(
    'cleanup',
    removed.operation!,
    () => {},
    new AbortController().signal,
  )
  await blocked.reached
  await fs.chmod(join(removed.preserved!.path, 'a-empty'), 0o700)
  blocked.resume()
  expect(await cleaning).toMatchObject({ outcome: 'cleanup-uncertain' })
  expect((await fs.stat(join(removed.preserved!.path, 'a-empty'))).mode & 0o777).toBe(
    0o700,
  )
  expect(f.persisted().operations.some((entry) => entry.id === removed.operation)).toBe(
    true,
  )
})
it.each(['trusted-cancel', 'guest-timeout'])(
  'does not restore completed authority after %s during a blocked recovery save',
  async (kind) => {
    const f = await fixture(),
      plan = await f.preview('add')
    f.failCompletion()
    expect(await f.owner.apply(f.caller, plan)).toMatchObject({ outcome: 'uncertain' })
    f.failCompletion(false)
    const blocked = deliveryBarrier(),
      save = f.authority.saveManagedDeliveries.getMockImplementation()!
    f.authority.saveManagedDeliveries.mockImplementationOnce(async (...args) => {
      blocked.enter()
      await blocked.blocked
      return save(...args)
    })
    const controller = new AbortController()
    const deadline =
      kind === 'guest-timeout'
        ? vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(controller.signal)
        : undefined
    const signal = controller.signal
    const recovering =
      kind === 'trusted-cancel'
        ? f.owner.trustedRecovery('reconcile', plan.operation, () => {}, signal)
        : f.owner.reconcile(f.caller, {
            operation: plan.operation,
            destination: 'delivery-target',
          })
    const observed = recovering.then(
      () => 'completed',
      () => 'rejected',
    )
    await blocked.reached
    controller.abort(new DOMException('Deadline ended', 'TimeoutError'))
    if (deadline) expect(deadline).toHaveBeenCalledWith(180_000)
    blocked.resume()
    expect(await observed).toBe('rejected')
    expect(f.owner.status(f.caller, { offset: 0 })).toMatchObject({ entries: [] })
    expect(f.persisted().operations[0]?.phase).toBe('publishing')
    deadline?.mockRestore()
  },
)
