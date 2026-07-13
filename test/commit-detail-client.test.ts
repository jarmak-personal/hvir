import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { localPath, type GitCommitDetail } from '../src/shared'

describe('commit detail client', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shares pending and resolved details between renderer surfaces', async () => {
    const detail = commitDetail('0123456')
    const invoke = vi.fn().mockResolvedValue(detail)
    vi.stubGlobal('window', { hvir: { invoke } })
    const { loadCommitDetail } =
      await import('../src/renderer/src/git/commit-detail-client')
    const root = localPath('/project')

    const first = loadCommitDetail(root, detail.hash)
    const second = loadCommitDetail(root, detail.hash)
    expect(second).toBe(first)
    await expect(first).resolves.toBe(detail)
    await expect(loadCommitDetail(root, detail.hash)).resolves.toBe(detail)
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('does not share a hash across project roots or retain failures', async () => {
    const detail = commitDetail('fedcba9')
    const invoke = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(detail)
    vi.stubGlobal('window', { hvir: { invoke } })
    const { loadCommitDetail } =
      await import('../src/renderer/src/git/commit-detail-client')

    await expect(loadCommitDetail(localPath('/one'), detail.hash)).rejects.toThrow(
      'offline',
    )
    await expect(loadCommitDetail(localPath('/one'), detail.hash)).resolves.toBe(detail)
    await expect(loadCommitDetail(localPath('/two'), detail.hash)).resolves.toBe(detail)
    expect(invoke).toHaveBeenCalledTimes(3)
  })
})

function commitDetail(shortHash: string): GitCommitDetail {
  return {
    hash: `${shortHash}000000000`,
    shortHash,
    parents: [],
    refs: [],
    author: 'hvir',
    authoredAt: '2026-07-13T00:00:00Z',
    subject: 'Cached detail',
    message: 'Cached detail',
    files: [],
  }
}
