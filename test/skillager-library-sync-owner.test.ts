import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { SkillagerLibrarySyncOwner } from '../src/main/skillager/skillager-library-sync-owner'
import { SkillagerError } from '../src/main/skillager/skillager-port'
import type { SkillagerSyncStatus } from '../src/shared/skillager-library-sync'
import { localPath } from '../src/shared/host-path'
import { createRendererResourceFixture } from './fixtures/renderer-resource-fixture'
import {
  syncSelection,
  syncContext,
  syncStatus,
  syncCompletion,
} from './fixtures/skillager-sync-fixture'
function fixture() {
  const resources = createRendererResourceFixture(),
    owner = resources.activateOwner()
  const cli = {
    syncStatus: vi.fn(
      (
        _selection: typeof syncSelection,
        _root: typeof syncContext,
        _signal: AbortSignal,
      ) => Promise.resolve(syncStatus()),
    ),
    syncApproved: vi.fn(
      (
        _selection: typeof syncSelection,
        _root: typeof syncContext,
        _signal: AbortSignal,
        submitted: () => void,
      ) => {
        submitted()
        return Promise.resolve(syncCompletion())
      },
    ),
  }
  let current = true
  const sync = new SkillagerLibrarySyncOwner(cli, resources.scopes, () => ({
    selection: syncSelection,
    assertCurrent: () => {
      if (!current) throw new SkillagerError('disconnected', 'Replaced connection')
    },
  }))
  onTestFinished(() => sync.dispose())
  const request = {
    connectionId: 'connected',
    requestId: 1,
    workspaceRoot: syncContext,
    agent: 'codex' as const,
  }
  const observe = (requestId: number) => sync.observe(owner, { ...request, requestId })
  async function prepare(requestId = 1) {
    const result = await observe(requestId)
    if (!result.ok || !result.value.observationId) throw new Error('No observation')
    return {
      ...request,
      requestId: requestId + 1,
      observationId: result.value.observationId,
    }
  }
  return {
    resources,
    owner,
    cli,
    sync,
    request,
    prepare,
    observe,
    revoke: () => {
      current = false
    },
  }
}
afterEach(() => vi.useRealTimers())
describe('main-owned library sync continuation and uncertainty', () => {
  it('requires a retained exact observation, consumes it once, and rejects renderer-invented checks', async () => {
    const f = fixture()
    expect(
      await f.sync.apply(f.owner, { ...f.request, observationId: 'invented' }),
    ).toMatchObject({ ok: false, reason: 'invalid-request' })
    const request = await f.prepare(2)
    expect(await f.sync.apply(f.owner, request)).toMatchObject({
      ok: true,
      value: { counts: { created: 1 } },
    })
    expect(await f.sync.apply(f.owner, { ...request, requestId: 4 })).toMatchObject({
      ok: false,
      reason: 'invalid-request',
    })
    expect(f.cli.syncApproved).toHaveBeenCalledOnce()
  })
  it.each(['incomplete', 'refused', 'null'])(
    'does not enable a write after %s observation',
    async (kind) => {
      const f = fixture(),
        report = syncStatus()
      f.cli.syncStatus.mockResolvedValueOnce({
        ...report,
        status: kind === 'refused' ? 'refused' : 'observed',
        library: kind === 'null' ? undefined : report.library,
        coverage: { ...report.coverage, complete: kind !== 'incomplete' },
      })
      expect(await f.observe(1)).toMatchObject({
        ok: true,
        value: { observationId: undefined },
      })
      expect(f.cli.syncApproved).not.toHaveBeenCalled()
    },
  )
  it('binds continuation to exact context and agent', async () => {
    const f = fixture(),
      request = await f.prepare()
    expect(
      await f.sync.apply(f.owner, { ...request, workspaceRoot: localPath('/other') }),
    ).toMatchObject({ ok: false, reason: 'invalid-request' })
    expect(f.cli.syncApproved).not.toHaveBeenCalled()
  })
  it('cancellation during status aborts, refuses late output, and never submits apply', async () => {
    const f = fixture()
    let finish!: (report: SkillagerSyncStatus) => void, signal!: AbortSignal
    f.cli.syncStatus.mockImplementationOnce((_selection, _root, received) => {
      signal = received
      return new Promise((resolve) => {
        finish = resolve
      })
    })
    const pending = f.observe(1)
    expect(signal.aborted).toBe(false)
    const stopping = f.sync.cancel(f.owner, 1)
    expect(signal.aborted).toBe(true)
    finish(syncStatus())
    await stopping
    expect(await pending).toMatchObject({ ok: false, reason: 'cancelled' })
    expect(f.cli.syncApproved).not.toHaveBeenCalled()
  })
  it('retains uncertainty across revocation and requires complete same-context observation plus a new gesture', async () => {
    const f = fixture(),
      request = await f.prepare()
    f.cli.syncApproved.mockImplementationOnce((_selection, _root, _signal, submitted) => {
      submitted()
      return Promise.reject(new Error('Lost output'))
    })
    expect(await f.sync.apply(f.owner, request)).toMatchObject({
      ok: false,
      reason: 'uncertain',
    })
    await f.sync.revoke(f.owner)
    f.cli.syncStatus.mockResolvedValueOnce({
      ...syncStatus(),
      coverage: { ...syncStatus().coverage, complete: false },
    })
    expect(await f.observe(1)).toMatchObject({
      ok: true,
      value: { observationId: undefined, requiresNewSync: true },
    })
    const checked = await f.prepare(2)
    expect(await f.sync.apply(f.owner, checked)).toMatchObject({
      ok: false,
      reason: 'invalid-request',
    })
    expect(f.cli.syncApproved).toHaveBeenCalledOnce()
    expect(await f.sync.apply(f.owner, await f.prepare(4))).toMatchObject({ ok: true })
  })
  it('another local context cannot reconcile a previous uncertain write', async () => {
    const f = fixture(),
      request = await f.prepare()
    f.cli.syncApproved.mockImplementationOnce((_selection, _root, _signal, submitted) => {
      submitted()
      return Promise.reject(new Error('Lost'))
    })
    await f.sync.apply(f.owner, request)
    f.cli.syncStatus.mockResolvedValueOnce({
      ...syncStatus(),
      context: localPath('/other'),
    })
    expect(
      await f.sync.observe(f.owner, {
        ...f.request,
        requestId: 3,
        workspaceRoot: localPath('/other'),
      }),
    ).toMatchObject({
      ok: true,
      value: { observationId: undefined, requiresNewSync: true },
    })
  })
  it('retained cleanup recovery remains uncertain even with an accepted outcome', async () => {
    const f = fixture(),
      request = await f.prepare(),
      result = syncCompletion()
    f.cli.syncApproved.mockImplementationOnce((_selection, _root, _signal, submitted) => {
      submitted()
      return Promise.resolve({
        ...result,
        items: result.items.map((item) => ({
          ...item,
          recoveryPath: localPath('/private/recovery'),
        })),
      })
    })
    expect(await f.sync.apply(f.owner, request)).toMatchObject({
      ok: true,
      value: { counts: { created: 1 } },
    })
    expect(await f.observe(3)).toMatchObject({
      ok: true,
      value: { requiresNewSync: true },
    })
  })
  it('releases a workspace lease on renderer destruction and refuses delayed completion', async () => {
    const f = fixture()
    let finish!: (report: SkillagerSyncStatus) => void
    f.cli.syncStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const pending = f.observe(1),
      destroyed = f.resources.destroyOwner(f.owner.id)
    finish(syncStatus())
    await destroyed
    expect(await pending).toMatchObject({ ok: false })
    expect(f.cli.syncApproved).not.toHaveBeenCalled()
  })
  it('gives each observation its own finite deadline and releases cooperative cancellation', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.cli.syncStatus.mockImplementationOnce(
      (_selection, _root, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('Aborted'))),
        ),
    )
    const pending = f.observe(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await pending).toMatchObject({ ok: false })
    expect(await f.observe(2)).toMatchObject({ ok: true })
  })
})
