import { afterEach, describe, expect, it, vi } from 'vitest'
import { SKILLAGER_REQUEST_DEADLINE_MS } from '../src/main/skillager/skillager-port'
import { localPath } from '../src/shared/host-path'
import { SkillagerReviewOwner } from '../src/main/skillager/skillager-review-owner'
import type {
  SkillagerReviewCliPort,
  SkillagerReviewSnapshot,
} from '../src/main/skillager/skillager-review-port'
import { createRendererResourceFixture } from './fixtures/renderer-resource-fixture'

const root = localPath('/workspace'),
  skillRoot = localPath('/library/skills/example'),
  hash = 'a'.repeat(64)
afterEach(() => vi.useRealTimers())
function fixture(overrides: Partial<SkillagerReviewCliPort> = {}) {
  const resources = createRendererResourceFixture(),
    owner = resources.activateOwner()
  const request = {
    connectionId: 'connection',
    requestId: 1,
    workspaceRoot: root,
    agent: 'codex' as const,
    skillId: 'lib/example',
  }
  const bytes = new Map([
    ['SKILL.md', new TextEncoder().encode('# Reviewed')],
    ['demo.html', new TextEncoder().encode('<h1>Retained HTML</h1>')],
    ['notes/guide.md', new TextEncoder().encode('# Guide')],
    ['image.png', new Uint8Array([1, 2])],
  ])
  const snapshot: SkillagerReviewSnapshot = {
    detail: {
      root: skillRoot,
      skillId: 'lib/example',
      hash,
      files: [...bytes].map(([entry, bytes]) => ({
        entry,
        size: bytes.length,
        executable: false,
      })),
      canAccept: true,
      scanRisk: 'low',
      lintStatus: 'ok',
      findings: [],
      history: { available: false, reason: 'no-git', versions: [] },
    },
    bytes,
    confirmationToken: 'private',
    dispose: vi.fn(() => {
      bytes.clear()
      return Promise.resolve()
    }),
  }
  const cli: SkillagerReviewCliPort = {
    review: vi.fn(() => Promise.resolve(snapshot)),
    history: vi.fn(() => Promise.resolve(snapshot.detail.history)),
    diff: vi.fn(() => Promise.resolve({ toHash: hash, text: '+ content' })),
    accept: vi.fn(() => Promise.resolve({ status: 'accepted' as const, hash })),
    ...overrides,
  }
  const previews = {
    create: vi.fn(() => ({ id: 'html', url: 'hvir-preview://document/html/index.html' })),
    release: vi.fn(),
  }
  const reviews = new SkillagerReviewOwner(cli, resources.scopes, previews, {
    previewExposure: vi.fn(),
    updateSourceHash: vi.fn(),
  })
  const selection = {
    executable: localPath('/skillager'),
    catalog: localPath('/catalog'),
    version: 'skillager 0.9.0',
    environment: {},
    library: {
      id: 'library',
      root: localPath('/library'),
      skillsRoot: localPath('/library/skills'),
    },
  }
  let live = true
  const grant = {
    selection,
    assertCurrent: () => {
      if (!live) throw new Error('revoked')
    },
  }
  return {
    resources,
    owner,
    request,
    snapshot,
    cli,
    previews,
    reviews,
    grant,
    revoke: () => {
      live = false
    },
  }
}

describe('retained Skillager review authority', () => {
  it('serves only verified entries for the originating owner and confines automatic images', async () => {
    const f = fixture(),
      detail = await f.reviews.review(f.owner, f.request, f.grant)
    const request = { ...f.request, reviewId: detail.reviewId }
    expect(JSON.stringify(detail)).not.toContain('private')
    expect(f.reviews.content(f.owner, { ...request, entry: 'SKILL.md' }).text).toBe(
      '# Reviewed',
    )
    expect(() => f.reviews.content(f.owner, { ...request, entry: '../secret' })).toThrow()
    expect(() =>
      f.reviews.content(
        { ...f.owner, generation: 999 },
        { ...request, entry: 'SKILL.md' },
      ),
    ).toThrow()
    expect(() =>
      f.reviews.content(f.owner, {
        ...request,
        entry: 'image.png',
        documentEntry: 'notes/guide.md',
      }),
    ).toThrow('escapes')
    expect(
      f.reviews.content(f.owner, {
        ...request,
        entry: 'image.png',
        documentEntry: 'SKILL.md',
      }).image,
    ).toBeDefined()
    await f.reviews.revoke()
  })
  it('owns HTML resources until exact review release and rejects late access', async () => {
    const f = fixture(),
      detail = await f.reviews.review(f.owner, f.request, f.grant)
    const request = { ...f.request, reviewId: detail.reviewId, entry: 'demo.html' }
    expect(f.reviews.content(f.owner, request).htmlUrl).toContain('hvir-preview:')
    f.reviews.content(f.owner, request)
    expect(f.previews.create).toHaveBeenCalledTimes(1)
    await f.reviews.release(f.owner, detail.reviewId)
    expect(f.previews.release).toHaveBeenCalledWith('html')
    expect(f.snapshot.bytes.size).toBe(0)
    expect(() => f.reviews.content(f.owner, request)).toThrow('expired')
    await f.reviews.release(f.owner, detail.reviewId)
    expect(f.snapshot.bytes.size).toBe(0)
  })
  it('cancels preparation and disposes a late returned snapshot', async () => {
    let finish!: (value: SkillagerReviewSnapshot) => void
    let signal: AbortSignal | undefined
    const f = fixture({
      review: (_selection, _skill, at) => {
        signal = at
        return new Promise((resolve) => {
          finish = resolve
        })
      },
    })
    const pending = f.reviews.review(f.owner, f.request, f.grant)
    const rejected = expect(pending).rejects.toThrow()
    const cleanup = f.reviews.cancel(f.owner, f.request.requestId)
    expect(signal?.aborted).toBe(true)
    finish(f.snapshot)
    await rejected
    await cleanup
    expect(f.snapshot.bytes.size).toBe(0)
  })
  it('uses each confirmation once and preserves an observed completed result after revocation', async () => {
    let finish!: () => void
    const f = fixture({
      accept: () =>
        new Promise((resolve) => {
          finish = () => resolve({ status: 'accepted', hash })
        }),
    })
    const detail = await f.reviews.review(f.owner, f.request, f.grant),
      request = { ...f.request, reviewId: detail.reviewId }
    const pending = f.reviews.accept(f.owner, request)
    await expect(f.reviews.accept(f.owner, request)).rejects.toThrow('already used')
    const cleanup = f.reviews.release(f.owner, detail.reviewId)
    finish()
    expect(await pending).toEqual({ status: 'accepted', hash })
    await cleanup
  })
  it('revokes retained content immediately while a cancelled history process closes', async () => {
    let finish!: () => void
    let signal: AbortSignal | undefined
    const f = fixture({
      history: (_selection, _skill, at) => {
        signal = at
        return new Promise((resolve) => {
          finish = () => resolve({ available: false, versions: [] })
        })
      },
    })
    const detail = await f.reviews.review(f.owner, f.request, f.grant)
    const request = { ...f.request, reviewId: detail.reviewId, entry: 'demo.html' }
    f.reviews.content(f.owner, request)
    const history = f.reviews.history(f.owner, f.request, f.grant)
    const rejected = expect(history).rejects.toThrow()
    const cleanup = f.reviews.revoke(f.owner)
    expect(signal?.aborted).toBe(true)
    expect(() => f.reviews.content(f.owner, request)).toThrow('expired')
    expect(f.previews.release).toHaveBeenCalledWith('html')
    finish()
    await rejected
    await cleanup
  })
  it('bounds the complete capture and discards its late snapshot after the deadline', async () => {
    vi.useFakeTimers()
    let finish!: (snapshot: SkillagerReviewSnapshot) => void
    let signal: AbortSignal | undefined
    const f = fixture({
      review: (_selection, _skill, at) => {
        signal = at
        return new Promise((resolve) => {
          finish = resolve
        })
      },
    })
    const review = f.reviews.review(f.owner, f.request, f.grant)
    const rejected = expect(review).rejects.toMatchObject({ reason: 'timeout' })
    await vi.advanceTimersByTimeAsync(SKILLAGER_REQUEST_DEADLINE_MS)
    expect(signal?.aborted).toBe(true)
    finish(f.snapshot)
    await rejected
    expect(f.snapshot.bytes.size).toBe(0)
  })
})
