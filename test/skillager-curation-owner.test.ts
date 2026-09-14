import { afterEach, expect, it, vi } from 'vitest'
import { SkillagerExposureOwner } from '../src/main/skillager/skillager-exposure-owner'
import { SkillagerLibrarySyncOwner } from '../src/main/skillager/skillager-library-sync-owner'
import {
  SkillagerError,
  SKILLAGER_REQUEST_DEADLINE_MS,
} from '../src/main/skillager/skillager-port'
import type { SkillagerLocalActionPort } from '../src/main/skillager/skillager-exposure-plan-commands'
import type { SkillagerLibrarySyncCliPort } from '../src/main/skillager/skillager-library-sync-port'
import type {
  SkillagerLifecycleRequest,
  SkillagerPlanCompletion,
} from '../src/shared/skillager-exposure-plan'
import { localPath } from '../src/shared/host-path'
import { createRendererResourceFixture } from './fixtures/renderer-resource-fixture'
import {
  syncContext,
  syncLibrary,
  syncSelection,
  syncStatus,
  syncCompletion,
  syncHash,
} from './fixtures/skillager-sync-fixture'

afterEach(() => vi.useRealTimers())
const request: SkillagerLifecycleRequest = {
  connectionId: 'connection',
  requestId: 1,
  workspaceRoot: syncContext,
  agent: 'codex',
  destination: { projectId: 'project', workspaceId: 'workspace', root: syncContext },
  action: 'plan',
  plan: {
    schema: 'skillager.exposure-request.v1',
    action: 'group',
    name: 'guidance',
    library_id: syncLibrary.id,
    members: ['lib/example'],
    replace: [],
  },
  origins: [],
  exposures: [],
}
const completion: SkillagerPlanCompletion = {
  kind: 'plan',
  status: 'applied',
  targets: [
    {
      id: syncHash,
      path: localPath('/workspace/.skillager/tags.json'),
      status: 'applied',
      observedHash: syncHash,
    },
  ],
}
function fixture(
  overrides: Partial<SkillagerLocalActionPort & SkillagerLibrarySyncCliPort> = {},
) {
  const resources = createRendererResourceFixture(),
    owner = resources.activateOwner()
  const direct = { previewExposure: vi.fn(), applyExposure: vi.fn() }
  const applyLocalAction = vi.fn<SkillagerLocalActionPort['applyLocalAction']>(
    (_selection, _snapshot, _signal, submitted) => {
      submitted()
      return Promise.resolve(completion)
    },
  )
  const observe = vi.fn<SkillagerLibrarySyncCliPort['syncStatus']>(() =>
    Promise.resolve(syncStatus()),
  )
  const syncApproved = vi.fn(() => Promise.resolve(syncCompletion()))
  const local: SkillagerLocalActionPort & SkillagerLibrarySyncCliPort = {
    previewLocalAction: vi.fn<SkillagerLocalActionPort['previewLocalAction']>(
      async (_selection, request) => {
        if (request.action !== 'plan') throw new Error('Expected plan')
        return Promise.resolve({
          detail: {
            kind: 'plan',
            request,
            sources: [],
            targets: [],
            group: null,
            staging: '{}',
          },
          confirmationToken: syncHash,
          payload: {},
        })
      },
    ),
    applyLocalAction,
    syncStatus: observe,
    syncApproved,
    ...overrides,
  }
  const exposures = new SkillagerExposureOwner(direct, resources.scopes, local)
  const grant = { selection: syncSelection, assertCurrent: vi.fn() }
  return {
    resources,
    owner,
    direct,
    local,
    exposures,
    grant,
    applyLocalAction,
    observe,
    syncApproved,
  }
}

it('holds destination admission while a cancelled submitted action drains, then retains uncertainty across library reconnect and renderer rollover', async () => {
  let reject!: (error: unknown) => void
  const f = fixture({
    applyLocalAction: (_selection, _snapshot, _signal, submitted) => {
      submitted()
      return new Promise((_resolve, no) => {
        reject = no
      })
    },
  })
  const preview = await f.exposures.preview(f.owner, request, f.grant)
  const applying = f.exposures.apply(f.owner, preview.previewId)
  const failure = expect(applying).rejects.toMatchObject({ reason: 'uncertain' })
  const release = f.exposures.release(f.owner, preview.previewId)
  const other = f.resources.activateOwner(20),
    changed = {
      ...request,
      connectionId: 'new-library',
      plan: {
        ...request.plan,
        action: 'group' as const,
        library_id: 'different',
        name: 'guidance',
        members: ['lib/example'],
        replace: [],
      },
    }
  const changedGrant = {
    ...f.grant,
    selection: { ...syncSelection, library: { ...syncLibrary, id: 'different' } },
  }
  await expect(f.exposures.preview(other, changed, changedGrant)).rejects.toMatchObject({
    reason: 'busy',
  })
  reject(new SkillagerError('uncertain', 'Lost output'))
  await failure
  await release
  await f.exposures.revoke()
  const rolled = f.resources.rolloverOwner(other.id)
  await rolled.cleanup
  await expect(
    f.exposures.preview(rolled.owner, changed, changedGrant),
  ).rejects.toMatchObject({ reason: 'uncertain' })
  const elsewhere = localPath('/another-project')
  await expect(
    f.exposures.preview(
      rolled.owner,
      {
        ...changed,
        workspaceRoot: elsewhere,
        destination: { ...changed.destination, root: elsewhere },
      },
      changedGrant,
    ),
  ).resolves.toHaveProperty('kind', 'plan')
})
it.each(['rolled_back', 'recovery_required'] as const)(
  'preserves complete %s results and blocks only unresolved project authority',
  async (status) => {
    const outcome: SkillagerPlanCompletion = {
      ...completion,
      status: 'partial',
      targets: [
        {
          ...completion.targets[0]!,
          status,
          observedHash: null,
          ...(status === 'recovery_required'
            ? { recoveryPath: localPath('/workspace/.stage/previous') }
            : {}),
        },
      ],
    }
    const f = fixture({
      applyLocalAction: async (_selection, _snapshot, _signal, submitted) => {
        submitted()
        return Promise.resolve(outcome)
      },
    })
    const preview = await f.exposures.preview(f.owner, request, f.grant)
    expect(await f.exposures.apply(f.owner, preview.previewId)).toEqual(outcome)
    await f.exposures.release(f.owner, preview.previewId)
    const next = f.exposures.preview(f.owner, { ...request, requestId: 2 }, f.grant)
    if (status === 'recovery_required')
      await expect(next).rejects.toMatchObject({ reason: 'uncertain' })
    else await expect(next).resolves.toHaveProperty('kind', 'plan')
  },
)
it('retains a factual completed action after its originating surface releases it', async () => {
  let finish!: (value: SkillagerPlanCompletion) => void
  const f = fixture({
    applyLocalAction: (_selection, _snapshot, _signal, submitted) => {
      submitted()
      return new Promise((resolve) => {
        finish = resolve
      })
    },
  })
  const preview = await f.exposures.preview(f.owner, request, f.grant),
    applying = f.exposures.apply(f.owner, preview.previewId)
  const released = f.exposures.release(f.owner, preview.previewId)
  finish(completion)
  expect(await applying).toEqual(completion)
  await released
  await expect(
    f.exposures.preview(f.owner, { ...request, requestId: 2 }, f.grant),
  ).resolves.toHaveProperty('kind', 'plan')
})
it.each(['stale-review', 'review-refused', 'uncertain'] as const)(
  'retains destination uncertainty only for an unproven %s completion from the action adapter',
  async (reason) => {
    const f = fixture({
      applyLocalAction: async (_selection, _snapshot, _signal, submitted) => {
        submitted()
        return Promise.reject(new SkillagerError(reason, 'Adapter disposition'))
      },
    })
    const preview = await f.exposures.preview(f.owner, request, f.grant)
    await expect(f.exposures.apply(f.owner, preview.previewId)).rejects.toMatchObject({
      reason,
    })
    await f.exposures.release(f.owner, preview.previewId)
    const next = f.exposures.preview(f.owner, { ...request, requestId: 2 }, f.grant)
    if (reason === 'uncertain') await expect(next).rejects.toMatchObject({ reason })
    else await expect(next).resolves.toHaveProperty('kind', 'plan')
  },
)
it.each(['cancel', 'disable', 'workspace', 'reconnect'] as const)(
  'drops late native preparation after %s and drains its own request',
  async (reason) => {
    let finish!: ReturnType<typeof syncStatus> extends infer T
      ? (value: T) => void
      : never
    let signal!: AbortSignal
    const f = fixture({
      syncStatus: (_selection, _workspace, at) => {
        signal = at
        return new Promise((resolve) => {
          finish = resolve
        })
      },
    })
    const preparing = f.exposures.inspectLineage(f.owner, request, f.grant)
    const failed = expect(preparing).rejects.toThrow()
    const released =
      reason === 'workspace'
        ? f.resources.scopes.revokeWorkspace(syncContext)
        : reason === 'cancel'
          ? f.exposures.cancel(f.owner, request.requestId)
          : f.exposures.revoke(f.owner)
    expect(signal.aborted).toBe(true)
    finish(syncStatus())
    await failed
    await released
    expect(f.applyLocalAction).not.toHaveBeenCalled()
  },
)
it('bounds its own native observation deadline without taking over an independent library sync continuation', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const sync = new SkillagerLibrarySyncOwner(f.local, f.resources.scopes, () => f.grant)
  const observed = await sync.observe(f.owner, request)
  if (!observed.ok || !observed.value.observationId)
    throw new Error('Expected library continuation')
  f.observe.mockImplementationOnce(
    (_selection, _root, signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener(
          'abort',
          () => reject(new SkillagerError('cancelled', 'Deadline')),
          { once: true },
        ),
      ),
  )
  const preparing = f.exposures.inspectLineage(
    f.owner,
    { ...request, requestId: 2 },
    f.grant,
  )
  const rejected = expect(preparing).rejects.toMatchObject({ reason: 'cancelled' })
  await vi.advanceTimersByTimeAsync(SKILLAGER_REQUEST_DEADLINE_MS)
  await rejected
  expect(
    await sync.apply(f.owner, {
      ...request,
      requestId: 3,
      observationId: observed.value.observationId,
    }),
  ).toEqual({ ok: true, value: syncCompletion() })
  expect(f.syncApproved).toHaveBeenCalledTimes(1)
})
