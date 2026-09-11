import { expect, it, onTestFinished, vi } from 'vitest'
import { SkillagerReviewOwner } from '../src/main/skillager/skillager-review-owner'
import { SkillagerExposureOwner } from '../src/main/skillager/skillager-exposure-owner'
import type { SkillagerExposureCliPort } from '../src/main/skillager/skillager-exposure-port'
import type {
  SkillagerReviewCliPort,
  SkillagerReviewSnapshot,
} from '../src/main/skillager/skillager-review-port'
import type { SkillagerExposureRequest } from '../src/shared/skillager-exposure'
import { localPath } from '../src/shared/host-path'
import { createRendererResourceFixture } from './fixtures/renderer-resource-fixture'
import {
  request as base,
  selection,
  exposureResponse,
} from './fixtures/skillager-exposure-fixture'
import { parseExposurePreview } from '../src/main/skillager/skillager-exposure-contract'

const oldHash = 'c'.repeat(64)
function fixture(overrides: Partial<SkillagerReviewCliPort> = {}) {
  const resources = createRendererResourceFixture(),
    owner = resources.activateOwner()
  const request: SkillagerExposureRequest = {
    ...base,
    action: 'update',
    workspaceRoot: base.destination.root,
    exposure: {
      id: 'lib-demo',
      skillId: 'lib/demo',
      mode: 'native',
      status: 'source_update',
      target: localPath('/other/.agents/skills/lib-demo'),
    },
  }
  const response = exposureResponse({ ...request, action: 'change' })
  let preview = parseExposurePreview(response.value, selection, request)
  const snapshot = {
    detail: {
      skillId: request.skillId,
      root: localPath('/library/skills/demo'),
      hash: preview.detail.sourceHash!,
      files: [],
      canAccept: false,
      scanRisk: 'low',
      lintStatus: 'ok',
      findings: [],
      history: { available: true, versions: [] },
    },
    bytes: new Map(),
    dispose: vi.fn(() => Promise.resolve()),
  } satisfies SkillagerReviewSnapshot
  const cli: SkillagerReviewCliPort = {
    review: vi.fn(() => Promise.resolve(snapshot)),
    history: vi.fn(),
    accept: vi.fn(),
    diff: vi.fn(() =>
      Promise.resolve({
        fromHash: oldHash,
        toHash: snapshot.detail.hash,
        text: '+ reviewed',
      }),
    ),
    ...overrides,
  }
  const mutations = {
    previewExposure: vi.fn(() => Promise.resolve(preview)),
    updateSourceHash: vi.fn(() => Promise.resolve(oldHash)),
    applyExposure: vi.fn(() =>
      Promise.resolve({
        status: 'exposed' as const,
        target: preview.detail.target,
        skillId: request.skillId,
        mode: request.mode,
      }),
    ),
  } satisfies SkillagerExposureCliPort
  const reviews = new SkillagerReviewOwner(
    cli,
    resources.scopes,
    { create: vi.fn(), release: vi.fn() },
    mutations,
  )
  const exposures = new SkillagerExposureOwner(mutations, resources.scopes)
  const grant = { selection, assertCurrent: () => undefined }
  onTestFinished(async () => {
    await exposures.revoke()
    await reviews.revoke()
  })
  const review = () => reviews.review(owner, { ...request, update: request }, grant)
  return {
    owner,
    resources,
    request,
    grant,
    reviews,
    exposures,
    review,
    snapshot,
    mutations,
    change: (patch: Partial<typeof preview.detail>) => {
      preview = { ...preview, detail: { ...preview.detail, ...patch } }
    },
  }
}

it('requires a completed exact from/to diff and binds later preview to its reviewed source and original target', async () => {
  const f = fixture(),
    detail = await f.review()
  expect(detail.update?.diff.fromHash).toBe(oldHash)
  expect(JSON.stringify(detail)).not.toContain('confirmationToken')
  const request = { ...f.request, reviewId: detail.reviewId }
  const proof = f.reviews.updateGrant(f.owner, request)
  const preview = await f.exposures.preview(f.owner, request, { ...f.grant, ...proof })
  expect((await f.exposures.apply(f.owner, preview.previewId)).status).toBe('exposed')
  expect(f.mutations.applyExposure).toHaveBeenCalledTimes(1)
})

it.each(['sourceHash', 'targetHash', 'beforeMode', 'target'] as const)(
  'rejects a changed %s between review and preview',
  async (field) => {
    const f = fixture(),
      detail = await f.review(),
      request = { ...f.request, reviewId: detail.reviewId }
    const proof = f.reviews.updateGrant(f.owner, request)
    f.change({
      [field]:
        field === 'beforeMode'
          ? 0o700
          : field === 'target'
            ? localPath('/other/changed')
            : 'e'.repeat(64),
    })
    await expect(
      f.exposures.preview(f.owner, request, { ...f.grant, ...proof }),
    ).rejects.toMatchObject({ reason: 'stale-review' })
    expect(f.mutations.applyExposure).not.toHaveBeenCalled()
  },
)

it.each(['reviewId', 'skillId', 'mode', 'agent', 'destination', 'exposure'] as const)(
  'rejects substitution of %s into the review link',
  async (field) => {
    const f = fixture(),
      detail = await f.review()
    const request = {
      ...f.request,
      reviewId: detail.reviewId,
      [field]:
        field === 'destination'
          ? { ...f.request.destination, workspaceId: 'elsewhere' }
          : field === 'exposure'
            ? { ...f.request.exposure, id: 'other' }
            : 'substitution',
    }
    expect(() => f.reviews.updateGrant(f.owner, request)).toThrow()
  },
)

it('revoking review blocks an already prepared update before mutation', async () => {
  const f = fixture(),
    detail = await f.review(),
    request = { ...f.request, reviewId: detail.reviewId }
  const preview = await f.exposures.preview(f.owner, request, {
    ...f.grant,
    ...f.reviews.updateGrant(f.owner, request),
  })
  await f.reviews.release(f.owner, detail.reviewId)
  await expect(f.exposures.apply(f.owner, preview.previewId)).rejects.toThrow()
  expect(f.mutations.applyExposure).not.toHaveBeenCalled()
})

it.each(['from', 'to'])(
  'refuses a diff whose %s version differs and disposes the retained snapshot',
  async (side) => {
    const f = fixture({
      diff: () =>
        Promise.resolve({
          fromHash: side === 'from' ? 'f'.repeat(64) : oldHash,
          toHash: side === 'to' ? 'f'.repeat(64) : 'a'.repeat(64),
          text: 'wrong diff',
        }),
    })
    await expect(f.review()).rejects.toMatchObject({ reason: 'stale-review' })
    expect(f.snapshot.dispose).toHaveBeenCalledTimes(1)
  },
)

it('workspace revocation during a deferred diff cannot publish update proof', async () => {
  let finish!: () => void
  const f = fixture({
    diff: () =>
      new Promise((resolve) => {
        finish = () =>
          resolve({ fromHash: oldHash, toHash: 'a'.repeat(64), text: 'late' })
      }),
  })
  const pending = f.review(),
    rejected = expect(pending).rejects.toThrow()
  for (let n = 0; n < 8; n++) await Promise.resolve()
  const closing = f.reviews.cancel(f.owner, f.request.requestId)
  finish()
  await rejected
  await closing
  expect(f.snapshot.dispose).toHaveBeenCalled()
  expect(f.mutations.applyExposure).not.toHaveBeenCalled()
})
