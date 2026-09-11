import { afterEach, describe, expect, it, vi } from 'vitest'
import { SkillagerExposureOwner } from '../src/main/skillager/skillager-exposure-owner'
import { SkillagerError } from '../src/main/skillager/skillager-port'
import { parseExposurePreview } from '../src/main/skillager/skillager-exposure-contract'
import type {
  SkillagerExposureCliPort,
  SkillagerExposureSnapshot,
} from '../src/main/skillager/skillager-exposure-port'
import { createRendererResourceFixture } from './fixtures/renderer-resource-fixture'
import {
  exposureResponse,
  request,
  selection,
  token,
} from './fixtures/skillager-exposure-fixture'

afterEach(() => vi.useRealTimers())
function fixture(overrides: Partial<SkillagerExposureCliPort> = {}) {
  const resources = createRendererResourceFixture(),
    owner = resources.activateOwner()
  const snapshot = parseExposurePreview(exposureResponse().value, selection, request)
  const result = {
    status: 'exposed' as const,
    target: snapshot.detail.target,
    skillId: request.skillId,
    mode: request.mode,
  }
  const cli = {
    previewExposure: vi.fn(() => Promise.resolve(snapshot)),
    applyExposure: vi.fn(() => Promise.resolve(result)),
    ...overrides,
  } satisfies Pick<SkillagerExposureCliPort, 'previewExposure' | 'applyExposure'>
  const exposures = new SkillagerExposureOwner(cli, resources.scopes)
  const grant = { selection, assertCurrent: vi.fn() }
  return { resources, owner, snapshot, result, cli, exposures, grant }
}
describe('one-use workspace skill confirmation ownership', () => {
  it('keeps the selected nonactive destination and secret token in main, applies exactly once', async () => {
    const f = fixture(),
      preview = await f.exposures.preview(f.owner, request, f.grant)
    expect(preview.request.destination).toEqual(request.destination)
    expect(JSON.stringify(preview)).not.toContain(token)
    expect(await f.exposures.apply(f.owner, preview.previewId)).toEqual(f.result)
    await expect(f.exposures.apply(f.owner, preview.previewId)).rejects.toMatchObject({
      reason: 'review-expired',
    })
    expect(vi.mocked(f.cli.applyExposure)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(f.cli.applyExposure)).toHaveBeenCalledWith(
      selection,
      f.snapshot,
      expect.any(AbortSignal),
    )
  })
  it('rejects a malformed selected identity before admitting a preview to its CLI port', async () => {
    const f = fixture()
    await expect(
      f.exposures.preview(
        f.owner,
        {
          ...request,
          action: 'remove',
          exposure: {
            id: '--yes',
            skillId: request.skillId,
            target: f.snapshot.detail.target,
            mode: 'native',
            status: 'current',
          },
        },
        f.grant,
      ),
    ).rejects.toMatchObject({ reason: 'invalid-request' })
    expect(vi.mocked(f.cli.previewExposure)).not.toHaveBeenCalled()
  })
  it.each(['origin', 'destination', 'renderer', 'connection'] as const)(
    'revokes a preview when its %s authority departs',
    async (kind) => {
      const f = fixture(),
        preview = await f.exposures.preview(f.owner, request, f.grant)
      if (kind === 'origin')
        await f.resources.scopes.revokeWorkspace(request.workspaceRoot)
      if (kind === 'destination')
        await f.resources.scopes.revokeWorkspace(request.destination.root)
      if (kind === 'renderer') await f.resources.destroyOwner(f.owner.id)
      if (kind === 'connection') await f.exposures.revoke(f.owner)
      await expect(f.exposures.apply(f.owner, preview.previewId)).rejects.toThrow()
      expect(vi.mocked(f.cli.applyExposure)).not.toHaveBeenCalled()
    },
  )
  it('revalidates registration immediately before apply and does not dispatch after refusal', async () => {
    const f = fixture(),
      preview = await f.exposures.preview(f.owner, request, f.grant)
    f.grant.assertCurrent.mockImplementation(() => {
      throw new Error('destination removed')
    })
    await expect(f.exposures.apply(f.owner, preview.previewId)).rejects.toThrow('removed')
    expect(vi.mocked(f.cli.applyExposure)).not.toHaveBeenCalled()
  })
  it('drops a late preparation after cancellation and permits a fresh explicit action', async () => {
    let finish!: (value: SkillagerExposureSnapshot) => void,
      signal: AbortSignal | undefined
    const f = fixture({
      previewExposure: (_selection, _request, at) => {
        signal = at
        return new Promise((resolve) => {
          finish = resolve
        })
      },
    })
    const pending = f.exposures.preview(f.owner, request, f.grant),
      rejected = expect(pending).rejects.toThrow()
    const cleanup = f.exposures.cancel(f.owner, request.requestId)
    expect(signal?.aborted).toBe(true)
    finish(f.snapshot)
    await rejected
    await cleanup
    expect(vi.mocked(f.cli.applyExposure)).not.toHaveBeenCalled()
  })
  it('never retries an uncertain write, while shared-admission busy leaves an explicit confirmation usable', async () => {
    const apply = vi
      .fn()
      .mockRejectedValueOnce(new SkillagerError('busy', 'busy'))
      .mockRejectedValue(new SkillagerError('uncertain', 'uncertain'))
    const f = fixture({ applyExposure: apply }),
      preview = await f.exposures.preview(f.owner, request, f.grant)
    await expect(f.exposures.apply(f.owner, preview.previewId)).rejects.toMatchObject({
      reason: 'busy',
    })
    expect(apply).toHaveBeenCalledTimes(1)
    await expect(f.exposures.apply(f.owner, preview.previewId)).rejects.toMatchObject({
      reason: 'uncertain',
    })
    await expect(f.exposures.apply(f.owner, preview.previewId)).rejects.toMatchObject({
      reason: 'review-expired',
    })
    expect(apply).toHaveBeenCalledTimes(2)
  })
  it('preserves observed completion while destination closure cancels an in-flight write', async () => {
    let finish!: () => void, signal: AbortSignal | undefined
    const f = fixture({
      applyExposure: (_selection, _snapshot, at) => {
        signal = at
        return new Promise((resolve) => {
          finish = () => resolve(f.result)
        })
      },
    })
    const preview = await f.exposures.preview(f.owner, request, f.grant)
    const apply = f.exposures.apply(f.owner, preview.previewId),
      close = f.resources.scopes.revokeWorkspace(request.destination.root)
    expect(signal?.aborted).toBe(true)
    finish()
    expect(await apply).toEqual(f.result)
    await close
  })
})
