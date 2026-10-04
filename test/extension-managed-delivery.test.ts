import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { deliveryFixture, deliveryBarrier } from './fixtures/extension-delivery'
import { hostPath } from '../src/shared/host-path'
import { deliveryPage } from '../src/main/extensions/delivery-message'
import { readDeliveryJournal } from '../src/main/extensions/delivery-journal'
const fixtures: Awaited<ReturnType<typeof deliveryFixture>>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.dispose()
})
async function fixture() {
  const f = await deliveryFixture()
  fixtures.push(f)
  return f
}
it('journals before every first remote effect, creates disclosed parents and delivers exact file modes', async () => {
  const f = await fixture(),
    plan = await f.preview('add')
  expect(plan.parents.map((path) => path.path)).toEqual([
    join(f.root.path, '.agents'),
    join(f.root.path, '.agents', 'skills'),
  ])
  const create = vi.mocked(f.remote.createDirectoryExclusive).getMockImplementation()!
  vi.spyOn(f.remote, 'createDirectoryExclusive').mockImplementation(
    async (path, options) => {
      expect(f.persisted().operations[0]).toMatchObject({
        id: plan.operation,
        phase: 'intent',
      })
      return create(path, options)
    },
  )
  const result = await f.owner.apply(f.caller, plan)
  expect(result.outcome).toBe('completed')
  expect(await fs.readFile(join(f.target.path, 'SKILL.md'), 'utf8')).toBe('approved')
  expect((await fs.stat(join(f.target.path, 'SKILL.md'))).mode & 0o777).toBe(0o664)
  expect(f.persisted().records[0]?.record.operation).toBe(result.operation)
  const restarted = await f.make()
  expect(restarted.status(f.caller, { offset: 0 })).toMatchObject({
    entries: [{ id: result.record!.id }],
  })
  await restarted.dispose()
})
it('refuses missing write ownership or intent persistence before any remote mutation', async () => {
  const f = await fixture(),
    plan = await f.preview('add')
  f.writable(false)
  expect((await f.owner.apply(f.caller, plan)).outcome).toBe('refused')
  expect(f.remote.createDirectoryExclusive).not.toHaveBeenCalled()
  f.writable(true)
  f.authority.saveManagedDeliveries.mockRejectedValueOnce(new Error('disk full'))
  expect((await f.owner.apply(f.caller, await f.preview('add'))).outcome).toBe('refused')
  expect(f.remote.createDirectoryExclusive).not.toHaveBeenCalled()
})
it('keeps completion pending after a save failure and refuses dependent Update/Remove until durable recovery', async () => {
  const f = await fixture(),
    plan = await f.preview('add')
  f.failCompletion()
  const result = await f.owner.apply(f.caller, plan)
  expect(result.outcome).toBe('uncertain')
  expect(f.persisted().operations[0]?.phase).toBe('publishing')
  expect(f.persisted().records).toEqual([])
  await expect(f.preview('update', f.owner, plan.operation, 'next')).rejects.toThrow(
    /authority/,
  )
  await expect(f.preview('remove', f.owner, plan.operation)).rejects.toThrow(/authority/)
  await expect(
    f.owner.trustedRecovery(
      'reconcile',
      plan.operation,
      () => {},
      new AbortController().signal,
    ),
  ).rejects.toThrow(/save failed/)
  expect(f.owner.recoveryStatus()[0]?.phase).toBe('publishing')
  await expect(f.preview('add')).rejects.toThrow(/unfinished/)
  f.failCompletion(false)
  expect(
    await f.owner.trustedRecovery(
      'reconcile',
      plan.operation,
      () => {},
      new AbortController().signal,
    ),
  ).toMatchObject({ outcome: 'completed', replayed: false })
  expect(vi.spyOn(f.remote.fileTransfer!, 'renameNoReplace')).toHaveBeenCalledTimes(1)
  expect(
    (
      await f.owner.apply(
        f.caller,
        await f.preview('update', f.owner, plan.operation, 'next'),
      )
    ).outcome,
  ).toBe('completed')
})
it('preserves displaced copies and resolves historical completed operations without removing newer authority', async () => {
  const f = await fixture(),
    a = await f.owner.apply(f.caller, await f.preview('add')),
    b = await f.owner.apply(
      f.caller,
      await f.preview('update', f.owner, a.record!.id, 'new'),
    )
  expect(b.outcome).toBe('completed')
  expect(await fs.readFile(join(b.preserved!.path, 'SKILL.md'), 'utf8')).toBe('approved')
  expect(
    await f.owner.trustedRecovery(
      'cleanup',
      a.operation!,
      () => {},
      new AbortController().signal,
    ),
  ).toMatchObject({ outcome: 'cleanup-completed' })
  expect(f.persisted().records[0]?.record.operation).toBe(b.operation)
  const c = await f.owner.apply(
    f.caller,
    await f.preview('update', f.owner, b.record!.id, 'newest'),
  )
  const inspected = await f.owner.trustedRecovery(
    'inspect',
    b.operation!,
    () => {},
    new AbortController().signal,
  )
  expect(
    await f.owner.trustedRecovery(
      'keep',
      inspected.token!,
      () => {},
      new AbortController().signal,
    ),
  ).toMatchObject({ outcome: 'resolved-by-retaining-files', completion: 'proven' })
  expect(f.persisted().records[0]?.record.operation).toBe(c.operation)
  const removed = await f.owner.apply(
    f.caller,
    await f.preview('remove', f.owner, c.record!.id),
  )
  expect(removed.outcome).toBe('completed')
  await expect(fs.stat(f.target.path)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await fs.readFile(join(removed.preserved!.path, 'SKILL.md'), 'utf8')).toBe(
    'newest',
  )
})
it('refuses occupied, changed, and identical foreign targets without hash adoption', async () => {
  const f = await fixture(),
    add = await f.owner.apply(f.caller, await f.preview('add'))
  await expect(f.preview('add')).rejects.toThrow(/occupied/)
  await fs.writeFile(join(f.target.path, 'SKILL.md'), 'user edit')
  await expect(f.preview('update', f.owner, add.record!.id)).rejects.toThrow(
    /changed|unproven/,
  )
  await fs.rename(f.target.path, `${f.target.path}-original`)
  await fs.mkdir(f.target.path)
  await fs.writeFile(join(f.target.path, 'SKILL.md'), 'approved')
  await fs.chmod(join(f.target.path, 'SKILL.md'), 0o664)
  await expect(f.preview('remove', f.owner, add.record!.id)).rejects.toThrow(
    /changed|unproven/,
  )
  expect(await fs.readFile(join(f.target.path, 'SKILL.md'), 'utf8')).toBe('approved')
})
it('revokes dependent previews on release and charges physically retained snapshots until settlement', async () => {
  const f = await fixture(),
    plan = await f.preview('add')
  f.owner.manifest(f.caller, { receipt: plan.capture, release: true })
  await expect(f.owner.apply(f.caller, plan)).rejects.toThrow(/Inspect/)
  expect(f.remote.createDirectoryExclusive).not.toHaveBeenCalled()
  const blocked = deliveryBarrier(),
    write = vi
      .spyOn(f.remote.managedTransfer!, 'writeFileChunksExclusive')
      .getMockImplementation()!
  vi.spyOn(f.remote.managedTransfer!, 'writeFileChunksExclusive').mockImplementation(
    async (...args) => {
      blocked.enter()
      await blocked.blocked
      return write(...args)
    },
  )
  const physical = await f.preview('add'),
    pending = f.owner.apply(f.caller, physical)
  await blocked.reached
  f.owner.manifest(f.caller, { receipt: physical.capture, release: true })
  await f.capture('second')
  await expect(f.capture('third')).rejects.toThrow(/capacity/)
  blocked.resume()
  expect((await pending).outcome).toBe('uncertain')
  await expect(f.capture('after settlement')).resolves.toHaveProperty('receipt')
  await expect(fs.stat(f.target.path)).rejects.toMatchObject({ code: 'ENOENT' })
})
it('cancels source capture on disposal and joins physical reads before releasing its owner', async () => {
  const f = await fixture(),
    blocked = deliveryBarrier()
  const read = f.local.fileTransfer.readFileChunks.bind(f.local.fileTransfer)
  let signal: AbortSignal | undefined
  vi.spyOn(f.local.fileTransfer, 'readFileChunks').mockImplementation(
    async function* (path, options) {
      signal = options?.signal
      blocked.enter()
      await blocked.blocked
      yield* read(path, options)
    },
  )
  const captured = f.capture().then(
    () => 'published',
    () => 'refused',
  )
  await blocked.reached
  let settled = false
  const disposed = f.owner.dispose().then(() => {
    settled = true
  })
  await Promise.resolve()
  expect(signal?.aborted).toBe(true)
  expect(settled).toBe(false)
  blocked.resume()
  expect(await captured).toBe('refused')
  await disposed
  expect(settled).toBe(true)
  expect(f.persisted()).toEqual({ records: [], operations: [] })
})
it('refuses a replaced staging parent before writing outside its granted destination', async () => {
  const f = await fixture(),
    captured = await f.capture(),
    sub = join(captured.root.path, 'support')
  await fs.mkdir(sub)
  await fs.writeFile(join(sub, 'extra'), 'support')
  f.owner.manifest(f.caller, { receipt: captured.receipt, release: true })
  const recaptured = (await f.owner.capture(f.caller, {
    source: 'delivery-source',
    path: captured.root,
    nativeReceipt: 'native',
  })) as { receipt: string }
  const plan = (await f.owner.preview(f.caller, {
    destination: 'delivery-target',
    target: f.target,
    kind: 'add',
    capture: recaptured.receipt,
    sourceVersion: 'exact',
  })) as { receipt: string }
  const outside = join(f.directory, 'outside')
  await fs.mkdir(outside)
  const create = vi.mocked(f.remote.createDirectoryExclusive).getMockImplementation()!
  vi.spyOn(f.remote, 'createDirectoryExclusive').mockImplementation(
    async (path, options) => {
      await create(path, options)
      if (path.path.endsWith('/support')) {
        await fs.rename(path.path, `${path.path}-retained`)
        await fs.symlink(outside, path.path)
      }
    },
  )
  expect((await f.owner.apply(f.caller, plan)).outcome).toBe('uncertain')
  expect(await fs.readdir(outside)).toEqual([])
})
it('retains orphan evidence after forgetting identity, rejects stale facts, and offers keep-files without gaining authority', async () => {
  const f = await fixture(),
    plan = await f.preview('add')
  f.failCompletion()
  expect((await f.owner.apply(f.caller, plan)).outcome).toBe('uncertain')
  f.forget()
  f.failCompletion(false)
  const inspected = await f.owner.trustedRecovery(
    'inspect',
    plan.operation,
    () => {},
    new AbortController().signal,
  )
  expect(inspected.objects!.length).toBe(5)
  await fs.writeFile(join(f.target.path, 'SKILL.md'), 'user changed')
  await expect(
    f.owner.trustedRecovery(
      'keep',
      inspected.token!,
      () => {},
      new AbortController().signal,
    ),
  ).rejects.toThrow(/changed/)
  const fresh = await f.owner.trustedRecovery(
    'inspect',
    plan.operation,
    () => {},
    new AbortController().signal,
  )
  expect(
    await f.owner.trustedRecovery(
      'keep',
      fresh.token!,
      () => {},
      new AbortController().signal,
    ),
  ).toMatchObject({ completion: 'unproven', outcome: 'resolved-by-retaining-files' })
  expect(f.persisted().records).toEqual([])
  expect(f.persisted().operations).toEqual([])
  expect(await fs.readFile(join(f.target.path, 'SKILL.md'), 'utf8')).toBe('user changed')
})
it('leaves cleanup evidence pending on persistence failure and keeps shared native parents', async () => {
  const f = await fixture(),
    a = await f.owner.apply(f.caller, await f.preview('add')),
    removed = await f.owner.apply(
      f.caller,
      await f.preview('remove', f.owner, a.record!.id),
    )
  f.authority.saveManagedDeliveries.mockRejectedValueOnce(
    new Error('cleanup disk failure'),
  )
  expect(
    await f.owner.trustedRecovery(
      'cleanup',
      removed.operation!,
      () => {},
      new AbortController().signal,
    ),
  ).toMatchObject({ outcome: 'cleanup-uncertain' })
  expect(f.owner.recoveryStatus().some((entry) => entry.id === removed.operation)).toBe(
    true,
  )
  expect((await fs.stat(join(f.root.path, '.agents', 'skills'))).isDirectory()).toBe(true)
})
it('bounds complete escaped metadata and refuses an unrepresentable operation before effects', async () => {
  const f = await fixture(),
    captured = await f.capture(),
    target = hostPath(
      f.root.hostId,
      `${f.root.path}/${Array.from({ length: 10 }, () => '"'.repeat(80)).join('/')}`,
    )
  await expect(
    f.owner.preview(f.caller, {
      destination: 'delivery-target',
      target,
      kind: 'add',
      capture: captured.receipt,
      sourceVersion: 'version',
    }),
  ).rejects.toThrow(/bound/)
  // Short ordinary paths fit the preview alone, but both recovery identity witnesses
  // for every disclosed supporting parent would exceed the unchanged bridge bound.
  await expect(
    f.owner.preview(f.caller, {
      destination: 'delivery-target',
      target: hostPath(f.root.hostId, `${f.root.path}/one/two/three/four/five/six/seven`),
      kind: 'add',
      capture: captured.receipt,
      sourceVersion: 'version',
    }),
  ).rejects.toThrow(/bound/)
  expect(f.remote.createDirectoryExclusive).not.toHaveBeenCalled()
  const page = deliveryPage([{ text: 'a'.repeat(4000) }, { text: 'b'.repeat(4000) }], 0)
  expect(page.entries).toHaveLength(1)
  expect(page.nextOffset).toBe(1)
  expect(() => deliveryPage([{ text: '\u0001'.repeat(2000) }], 0)).toThrow(/entry/)
})
it('does not broaden instruction permission or trust a supplied native hash as export custody', async () => {
  const f = await fixture()
  f.native.assertCaptureReceipt.mockImplementationOnce(() => {
    throw new Error('Wrong caller custody')
  })
  await expect(f.capture()).rejects.toThrow(/custody/)
  const journal = f.persisted()
  expect(readDeliveryJournal(journal)).toEqual(journal)
})
it('publishes domain revisions only after durable save and refuses stale overwrites', async () => {
  const f = await fixture(),
    snapshot = (await f.owner.domain(f.caller, {})) as {
      value: unknown
      revision: string
    }
  await f.owner.domain(f.caller, {
    write: true,
    expected: snapshot.revision,
    value: { skill: 'data-only' },
  })
  await expect(
    f.owner.domain(f.caller, { write: true, expected: snapshot.revision, value: {} }),
  ).rejects.toThrow(/changed/)
  expect(await f.owner.domain(f.caller, {})).toMatchObject({
    value: { skill: 'data-only' },
  })
  expect(f.persisted().records).toEqual([])
})

it('retains deterministic generic fingerprints for non-ASCII files across process locale changes', async () => {
  const f = await fixture(),
    captured = await f.capture()
  for (const name of ['é.txt', 'Z.txt', 'α.txt'])
    await fs.writeFile(join(captured.root.path, name), name)
  f.owner.manifest(f.caller, { receipt: captured.receipt, release: true })
  const capture = (await f.owner.capture(f.caller, {
    source: 'delivery-source',
    path: captured.root,
    nativeReceipt: 'native',
  })) as { receipt: string }
  const preview = await f.owner.preview(f.caller, {
    destination: 'delivery-target',
    target: f.target,
    kind: 'add',
    capture: capture.receipt,
    sourceVersion: 'unicode',
  })
  expect((await f.owner.apply(f.caller, preview)).outcome).toBe('completed')
  const locale = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(() => {
    throw new Error('process locale changed')
  })
  try {
    expect(readDeliveryJournal(f.persisted()).records).toHaveLength(1)
    const restarted = await f.make()
    const record = f.persisted().records[0]!.record
    const next = await f.preview('update', restarted, record.id, 'unicode-next')
    expect(next).toHaveProperty('receipt')
    await restarted.dispose()
  } finally {
    locale.mockRestore()
  }
})
it('refuses source descendant-parent replacement before reading an outside file', async () => {
  const f = await fixture(),
    captured = await f.capture(),
    parent = join(captured.root.path, 'parent'),
    outside = join(f.directory, 'outside')
  await fs.mkdir(parent)
  await fs.writeFile(join(parent, 'payload'), 'inside')
  await fs.mkdir(outside)
  await fs.writeFile(join(outside, 'payload'), 'outside')
  f.owner.manifest(f.caller, { receipt: captured.receipt, release: true })
  const readdir = f.local.readdir.bind(f.local),
    stream = vi.spyOn(f.local.fileTransfer, 'readFileChunks')
  vi.spyOn(f.local, 'readdir').mockImplementation(async (path) => {
    const result = await readdir(path)
    if (path.path === parent) {
      await fs.rename(parent, `${parent}-saved`)
      await fs.symlink(outside, parent)
    }
    return result
  })
  await expect(
    f.owner.capture(f.caller, {
      source: 'delivery-source',
      path: captured.root,
      nativeReceipt: 'native',
    }),
  ).rejects.toThrow(/link|directory/)
  expect(stream.mock.calls.some(([path]) => path.path === join(parent, 'payload'))).toBe(
    false,
  )
})
