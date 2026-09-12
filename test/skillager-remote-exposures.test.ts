import { expect, it, vi } from 'vitest'
import { remoteFixture } from './skillager-remote-fixture'
import { ManagedDirectoryError } from '../src/main/project-host/managed-directory-contract'

it('previews every byte/record effect, retains source buffers, and publishes only after explicit apply', async () => {
  const f = remoteFixture(),
    signal = AbortSignal.timeout(1000)
  const preview = await f.adapter.previewExposure(f.selection, f.request, signal)
  expect(f.port.stage).not.toHaveBeenCalled()
  expect(f.port.commit).not.toHaveBeenCalled()
  expect(preview.detail.effects.map((effect) => effect.path)).toEqual([
    '.hvir-skillager.json',
    'SKILL.md',
  ])
  expect(preview.detail.remote?.declarations[0]).toContain('FIXTURE_DECLARATION')
  expect(preview.detail.sourceHash).toBe('a'.repeat(64))
  expect((await f.store.read())[0]?.intent?.state).toBe('prepared')
  expect(await f.adapter.applyExposure(f.selection, preview, signal)).toMatchObject({
    status: 'exposed',
    mode: 'native',
  })
  expect((await f.store.read())[0]?.installed?.deployment.sourceHash).toBe('a'.repeat(64))
  expect(f.port.stage.mock.calls[0]?.[3].get('SKILL.md')).toEqual(Buffer.from('test'))
  await preview.dispose!()
  expect(f.sourceSnapshots[0]?.bytes.size).toBe(0)
  expect(f.listeners.size).toBe(0)
  expect((await f.observe())?.[0]).toMatchObject({
    status: 'current',
    currentHash: 'a'.repeat(64),
  })
})
it('protects unmanaged and modified targets, while removing unchanged copies without canonical source availability', async () => {
  const f = remoteFixture()
  await f.add()
  const target = f.request.exposure?.target.path ?? '.agents/skills/lib-café'
  const entry = f.trees.get(target)!
  entry.modified = true
  await expect(
    f.adapter.previewExposure(
      f.selection,
      await f.existing('remove'),
      AbortSignal.timeout(1000),
    ),
  ).rejects.toMatchObject({ reason: 'review-refused' })
  entry.modified = false
  f.unavailable()
  const sourceCalls = f.local.nativeSnapshot.mock.calls.length
  const snapshot = await f.adapter.previewExposure(
    f.selection,
    await f.existing('remove'),
    AbortSignal.timeout(1000),
  )
  expect(f.local.nativeSnapshot).toHaveBeenCalledTimes(sourceCalls)
  expect(
    await f.adapter.applyExposure(f.selection, snapshot, AbortSignal.timeout(1000)),
  ).toMatchObject({ status: 'removed' })
  await snapshot.dispose!()
  expect(await f.store.read()).toEqual([])
  f.trees.set(target, entry)
  await expect(
    f.adapter.previewExposure(
      f.selection,
      {
        ...f.request,
        action: 'remove',
        exposure: {
          id: 'lib-café',
          skillId: f.request.skillId,
          target: { ...f.root, path: f.root.path + '/' + target },
          mode: 'native',
          status: 'current',
        },
      },
      AbortSignal.timeout(1000),
    ),
  ).rejects.toBeDefined()
})
it('keeps accepted pinned fresh Add and blocks source advancement', async () => {
  const f = remoteFixture()
  f.source('test', 'a'.repeat(64), true)
  await f.add()
  f.source('new', 'b'.repeat(64), true)
  await expect(
    f.adapter.previewExposure(
      f.selection,
      await f.existing('update'),
      AbortSignal.timeout(1000),
    ),
  ).rejects.toMatchObject({ reason: 'review-refused' })
  expect(f.port.commit).toHaveBeenCalledTimes(1)
})
it('retains the exact old canonical version and rejects source changes after preview', async () => {
  const f = remoteFixture()
  await f.add()
  f.source('next', 'b'.repeat(64))
  const snapshot = await f.adapter.previewExposure(
    f.selection,
    await f.existing('update'),
    AbortSignal.timeout(1000),
  )
  expect(
    await f.adapter.updateSourceHash(f.selection, snapshot, AbortSignal.timeout(1000)),
  ).toBe('a'.repeat(64))
  f.source('changed', 'c'.repeat(64))
  await expect(
    f.adapter.applyExposure(f.selection, snapshot, AbortSignal.timeout(1000)),
  ).rejects.toMatchObject({ reason: 'stale-review' })
  await snapshot.dispose!()
  expect(f.port.commit).toHaveBeenCalledTimes(1)
  expect((await f.store.read())[0]?.installed?.deployment.sourceHash).toBe('a'.repeat(64))
})
it('reconciles a lost update completion from persisted intent and retains a visible cleanup marker until explicit action', async () => {
  const f = remoteFixture()
  await f.add()
  f.source('next', 'b'.repeat(64))
  const snapshot = await f.adapter.previewExposure(
    f.selection,
    await f.existing('update'),
    AbortSignal.timeout(1000),
  )
  f.loseCompletion()
  await expect(
    f.adapter.applyExposure(f.selection, snapshot, AbortSignal.timeout(1000)),
  ).rejects.toMatchObject({ reason: 'uncertain' })
  await snapshot.dispose!()
  const cleanups = f.port.cleanup.mock.calls.length
  expect((await f.observe())?.[0]).toMatchObject({
    status: 'current',
    currentHash: 'b'.repeat(64),
    reconciliation: 'cleanup-pending',
  })
  expect(f.port.cleanup).toHaveBeenCalledTimes(cleanups)
  const removal = await f.adapter.previewExposure(
    f.selection,
    await f.existing('remove'),
    AbortSignal.timeout(1000),
  )
  expect(f.port.cleanup).toHaveBeenCalledTimes(cleanups + 1)
  await removal.dispose!()
  expect((await f.store.read())[0]?.intent).toBeUndefined()
  expect((await f.observe())?.[0]?.reconciliation).toBeUndefined()
})
it('does not adopt a copied deployment record after a lost completion', async () => {
  const f = remoteFixture(),
    signal = AbortSignal.timeout(1000)
  const snapshot = await f.adapter.previewExposure(f.selection, f.request, signal)
  f.loseCompletion()
  await expect(
    f.adapter.applyExposure(f.selection, snapshot, signal),
  ).rejects.toMatchObject({ reason: 'uncertain' })
  await snapshot.dispose!()
  const current = f.trees.get('.agents/skills/lib-café')!
  current.receipt = { ...current.receipt, inode: 'unrelated' }
  expect((await f.observe())?.[0]?.status).toBe('uncertain')
  await expect(
    f.adapter.previewExposure(f.selection, await f.existing('remove'), signal),
  ).rejects.toMatchObject({ reason: 'uncertain' })
})
it('shows completed removal with retained cleanup without treating it as installed or adopting a replacement', async () => {
  const f = remoteFixture(),
    signal = AbortSignal.timeout(1000)
  await f.add()
  const remove = await f.adapter.previewExposure(
    f.selection,
    await f.existing('remove'),
    signal,
  )
  f.cleanupFailure()
  const completion = await f.adapter.applyExposure(f.selection, remove, signal)
  expect(completion.status).toBe('removed')
  expect(completion.notice).toBeTypeOf('string')
  await remove.dispose!()
  const stored = (await f.store.read())[0]!
  expect(stored.installed).toBeUndefined()
  expect(stored.intent?.removedDeployment?.sourceHash).toBe('a'.repeat(64))
  const cleanups = f.port.cleanup.mock.calls.length
  expect((await f.observe())?.[0]).toMatchObject({
    status: 'removed',
    currentHash: undefined,
    reconciliation: 'cleanup-pending',
  })
  expect(f.port.cleanup).toHaveBeenCalledTimes(cleanups)
  f.cleanupFailure(false)
  const displaced = f.trees.get(stored.intent!.cleanup!.entry)!
  const target = stored.identity.targetEntry
  f.trees.set(target, {
    ...displaced,
    receipt: { ...displaced.receipt, entry: target, inode: 'new-object' },
    modified: true,
  })
  await expect(
    f.adapter.previewExposure(f.selection, f.request, signal),
  ).rejects.toMatchObject({ reason: 'uncertain' })
  expect(f.port.cleanup).toHaveBeenCalledTimes(cleanups)
  expect(f.trees.get(target)?.modified).toBe(true)
  f.trees.delete(target)
  const add = await f.adapter.previewExposure(f.selection, f.request, signal)
  expect(f.port.cleanup).toHaveBeenCalledTimes(cleanups + 1)
  expect((await f.store.read())[0]?.intent?.removedDeployment).toBeUndefined()
  await add.dispose!()
  expect(await f.store.read()).toEqual([])
  expect(await f.observe()).toEqual([])
})
it('revokes a retained preview on host loss and releases it without further remote commands', async () => {
  const f = remoteFixture(),
    snapshot = await f.adapter.previewExposure(
      f.selection,
      f.request,
      AbortSignal.timeout(1000),
    )
  f.disconnect()
  f.reconnect()
  expect(() =>
    f.adapter.applyExposure(f.selection, snapshot, AbortSignal.timeout(1000)),
  ).toThrow('disconnected')
  await snapshot.dispose!()
  expect(f.port.stage).not.toHaveBeenCalled()
  expect(f.listeners.size).toBe(0)
  expect(await f.store.read()).toEqual([])
})
it('batches workspace observations and keeps a partial search from declaring unrelated sources unavailable', async () => {
  const f = remoteFixture()
  await f.add()
  f.port.inspectMany.mockClear()
  const rows = await f.adapter.observe(
    f.selection,
    f.request,
    { rows: [], complete: false },
    AbortSignal.timeout(1000),
  )
  expect(rows?.[0]?.status).toBe('source_unverified')
  expect(f.port.inspectMany).toHaveBeenCalledOnce()
  expect(f.port.stage).toHaveBeenCalledTimes(1)
})
it('blocks publication if the intent cannot be persisted', async () => {
  const f = remoteFixture()
  f.fileHost.writeFile.mockRejectedValueOnce(Error('save failed'))
  await expect(
    f.adapter.previewExposure(f.selection, f.request, AbortSignal.timeout(1000)),
  ).rejects.toMatchObject({ reason: 'uncertain' })
  expect(f.port.stage).not.toHaveBeenCalled()
  expect(f.port.commit).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(f.listeners.size).toBe(0))
})

it('revalidates source after staging and cleans only its exact candidate without publishing', async () => {
  const f = remoteFixture(),
    signal = AbortSignal.timeout(1000)
  await f.add()
  f.source('next', 'b'.repeat(64))
  const snapshot = await f.adapter.previewExposure(
    f.selection,
    await f.existing('update'),
    signal,
  )
  const stage = f.port.stage.getMockImplementation()!
  f.port.stage.mockImplementationOnce(async (...args) => {
    const receipt = await stage(...args)
    f.source('later', 'c'.repeat(64))
    return receipt
  })
  await expect(
    f.adapter.applyExposure(f.selection, snapshot, signal),
  ).rejects.toMatchObject({ reason: 'stale-review' })
  expect(f.port.commit).toHaveBeenCalledTimes(1)
  expect(f.port.cleanup).toHaveBeenCalledTimes(1)
  expect(f.trees.get('.agents/skills/lib-café')?.bytes.get('SKILL.md')).toEqual(
    Uint8Array.from(Buffer.from('test')),
  )
  expect((await f.store.read())[0]?.intent).toBeUndefined()
  await snapshot.dispose!()
})
it('retains uncertain partial staging and refuses adoption without a candidate receipt', async () => {
  const f = remoteFixture(),
    signal = AbortSignal.timeout(1000)
  const snapshot = await f.adapter.previewExposure(f.selection, f.request, signal)
  const stage = f.port.stage.getMockImplementation()!
  f.port.stage.mockImplementationOnce(async (...args) => {
    await stage(...args)
    throw new ManagedDirectoryError('uncertain', 'Stage completion lost')
  })
  await expect(
    f.adapter.applyExposure(f.selection, snapshot, signal),
  ).rejects.toMatchObject({ reason: 'uncertain' })
  await snapshot.dispose!()
  expect((await f.store.read())[0]?.intent).toMatchObject({
    state: 'staging',
    candidate: undefined,
  })
  expect(f.port.commit).not.toHaveBeenCalled()
  expect(f.port.cleanup).not.toHaveBeenCalled()
  await expect(
    f.adapter.previewExposure(f.selection, f.request, signal),
  ).rejects.toMatchObject({ reason: 'uncertain' })
  expect(f.trees.size).toBe(1)
})
it.each(['add', 'update'] as const)(
  'reconciles a %s stage failure with no effects before retrying',
  async (action) => {
    const f = remoteFixture(),
      signal = AbortSignal.timeout(1000)
    if (action === 'update') {
      await f.add()
      f.source('next', 'b'.repeat(64))
    }
    const request = action === 'add' ? f.request : await f.existing('update')
    const snapshot = await f.adapter.previewExposure(f.selection, request, signal)
    const commits = f.port.commit.mock.calls.length
    f.port.stage.mockRejectedValueOnce(
      new ManagedDirectoryError('uncertain', 'stage connection lost before effects'),
    )
    await expect(
      f.adapter.applyExposure(f.selection, snapshot, signal),
    ).rejects.toMatchObject({ reason: 'uncertain' })
    await snapshot.dispose!()
    expect((await f.store.read())[0]!.intent).toMatchObject({
      state: 'staging',
      candidate: undefined,
    })
    const writes = f.fileHost.writeFile.mock.calls.length
    await f.observe()
    expect(f.fileHost.writeFile).toHaveBeenCalledTimes(writes)
    const retry = await f.adapter.previewExposure(f.selection, request, signal)
    expect(f.port.commit).toHaveBeenCalledTimes(commits)
    await f.adapter.applyExposure(f.selection, retry, signal)
    await retry.dispose!()
    expect((await f.store.read())[0]!.intent).toBeUndefined()
    expect((await f.observe())?.[0]?.status).toBe('current')
  },
)
it('revokes late preparation at disconnect and bounds same-target concurrent admission', async () => {
  const f = remoteFixture(),
    signal = AbortSignal.timeout(1000)
  const source = f.local.nativeSnapshot.getMockImplementation()!
  let finish!: () => void
  f.local.nativeSnapshot.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    return source()
  })
  const pending = f.adapter.previewExposure(f.selection, f.request, signal)
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  f.disconnect()
  f.reconnect()
  finish()
  await expect(pending).rejects.toMatchObject({ reason: 'cancelled' })
  expect(f.port.inspect).not.toHaveBeenCalled()
  expect(f.sourceSnapshots[0]?.bytes.size).toBe(0)
  const held = await f.adapter.previewExposure(f.selection, f.request, signal)
  await expect(
    f.adapter.previewExposure(f.selection, f.request, signal),
  ).rejects.toMatchObject({ reason: 'busy' })
  await held.dispose!()
  expect(await f.store.read()).toEqual([])
})
it('disposal waits for late preparation ownership and releases every retained buffer', async () => {
  const f = remoteFixture(),
    source = f.local.nativeSnapshot.getMockImplementation()!
  let finish!: () => void
  f.local.nativeSnapshot.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    return source()
  })
  const pending = f.adapter.previewExposure(
    f.selection,
    f.request,
    AbortSignal.timeout(1000),
  )
  const rejected = expect(pending).rejects.toMatchObject({ reason: 'cancelled' })
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  let done = false
  const disposal = f.adapter.dispose().then(() => {
    done = true
  })
  await Promise.resolve()
  expect(done).toBe(false)
  finish()
  await rejected
  await disposal
  expect(f.sourceSnapshots[0]?.bytes.size).toBe(0)
  expect(f.port.inspect).not.toHaveBeenCalled()
  expect(f.listeners.size).toBe(0)
  expect(await f.store.read()).toEqual([])
})
it('admits one remote preparation through source, apply, and full release without overlapping store ownership', async () => {
  const f = remoteFixture(),
    signal = AbortSignal.timeout(2000)
  const other = {
    ...f.request,
    destination: { ...f.request.destination, workspaceId: 'other-workspace' },
  }
  const source = f.local.nativeSnapshot.getMockImplementation()!
  let sourceReady!: () => void
  f.local.nativeSnapshot.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      sourceReady = resolve
    })
    return source()
  })
  const pending = f.adapter.previewExposure(f.selection, f.request, signal)
  await vi.waitFor(() => expect(sourceReady).toBeTypeOf('function'))
  await expect(
    f.adapter.previewExposure(f.selection, other, signal),
  ).rejects.toMatchObject({ reason: 'busy' })
  expect(f.local.nativeSnapshot).toHaveBeenCalledOnce()
  sourceReady()
  const snapshot = await pending
  const stage = f.port.stage.getMockImplementation()!
  let stageReady!: () => void
  f.port.stage.mockImplementationOnce(async (...args) => {
    await new Promise<void>((resolve) => {
      stageReady = resolve
    })
    return stage(...args)
  })
  const applying = f.adapter.applyExposure(f.selection, snapshot, signal)
  await vi.waitFor(() => expect(stageReady).toBeTypeOf('function'))
  const writes = f.fileHost.writeFile.mock.calls.length
  await expect(
    f.adapter.previewExposure(f.selection, other, signal),
  ).rejects.toMatchObject({ reason: 'busy' })
  expect(f.fileHost.writeFile).toHaveBeenCalledTimes(writes)
  stageReady()
  expect(await applying).toMatchObject({ status: 'exposed', notice: undefined })
  await expect(
    f.adapter.previewExposure(f.selection, other, signal),
  ).rejects.toMatchObject({ reason: 'busy' })
  const disposal = f.sourceSnapshots[0]!.dispose.getMockImplementation()!
  let releaseReady!: () => void
  f.sourceSnapshots[0]!.dispose.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      releaseReady = resolve
    })
    return disposal()
  })
  const releasing = snapshot.dispose!()
  await vi.waitFor(() => expect(releaseReady).toBeTypeOf('function'))
  await expect(
    f.adapter.previewExposure(f.selection, other, signal),
  ).rejects.toMatchObject({ reason: 'busy' })
  expect(f.local.nativeSnapshot).toHaveBeenCalledOnce()
  releaseReady()
  await releasing
  expect(f.sourceSnapshots[0]!.bytes.size).toBe(0)
  const remove = await f.adapter.previewExposure(
    f.selection,
    await f.existing('remove'),
    signal,
  )
  await remove.dispose!()
})
