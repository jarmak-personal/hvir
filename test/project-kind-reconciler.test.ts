import { describe, expect, it, vi } from 'vitest'

import {
  reconcileKinds,
  type IssueSnapshot,
  type KindAutomationPort,
} from '../scripts/project-management/kind-reconciler.ts'

function issue(overrides: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    id: 'issue-id',
    number: 10,
    state: 'OPEN',
    updatedAt: '2026-07-20T10:00:00Z',
    labels: ['kind:feature'],
    ...overrides,
  }
}

function port(snapshot: IssueSnapshot): KindAutomationPort {
  return {
    getIssue: vi.fn().mockResolvedValue(snapshot),
    listOpenIssues: vi.fn().mockResolvedValue([snapshot]),
    addLabels: vi.fn().mockResolvedValue(undefined),
    removeLabel: vi.fn().mockResolvedValue(undefined),
    syncProjectKind: vi
      .fn()
      .mockResolvedValue({ action: 'unchanged', issueAdded: false }),
  }
}

describe('project kind reconciliation', () => {
  it('inspects a valid issue without mutating it', async () => {
    const adapter = port(issue())
    const report = await reconcileKinds(adapter, { issueNumber: 10, apply: false })

    expect(report.summary).toMatchObject({ total: 1, valid: 1, mutations: 0 })
    expect(adapter.addLabels).not.toHaveBeenCalled()
    expect(adapter.removeLabel).not.toHaveBeenCalled()
    expect(adapter.syncProjectKind).toHaveBeenCalledWith(
      expect.objectContaining({ number: 10 }),
      'Feature',
      false,
    )
  })

  it('applies a newly labeled kind before projecting it', async () => {
    const adapter = port(issue({ labels: ['kind:bug', 'kind:enhancement'] }))
    vi.mocked(adapter.syncProjectKind).mockResolvedValue({
      action: 'updated',
      issueAdded: false,
    })

    const report = await reconcileKinds(adapter, {
      issueNumber: 10,
      apply: true,
      event: { action: 'labeled', label: 'kind:enhancement' },
      eventUpdatedAt: '2026-07-20T10:00:00Z',
    })

    expect(adapter.removeLabel).toHaveBeenCalledWith(10, 'kind:bug')
    expect(adapter.syncProjectKind).toHaveBeenCalledWith(
      expect.objectContaining({ number: 10 }),
      'Enhancement',
      true,
    )
    expect(report.results[0]).toMatchObject({ state: 'valid', applied: true })
  })

  it('downgrades stale events to non-destructive current-state reconciliation', async () => {
    const adapter = port(issue({ labels: [], updatedAt: '2026-07-20T10:01:00Z' }))
    const report = await reconcileKinds(adapter, {
      issueNumber: 10,
      apply: true,
      event: { action: 'unlabeled', label: 'kind:bug' },
      eventUpdatedAt: '2026-07-20T10:00:00Z',
    })

    expect(report.results[0]).toMatchObject({ state: 'missing', eventWasStale: true })
    expect(adapter.addLabels).not.toHaveBeenCalled()
    expect(adapter.syncProjectKind).toHaveBeenCalledWith(
      expect.objectContaining({ number: 10 }),
      undefined,
      true,
    )
  })

  it('reports missing metadata while still converging lifecycle planning', async () => {
    const adapter = port(issue({ labels: ['area:terminal'] }))
    const report = await reconcileKinds(adapter, { issueNumber: 10, apply: true })

    expect(report.summary.missing).toBe(1)
    expect(adapter.syncProjectKind).toHaveBeenCalledWith(
      expect.objectContaining({ number: 10 }),
      undefined,
      true,
    )
  })

  it('restores a sole removed kind and reports the applied label mutation', async () => {
    const adapter = port(issue({ labels: [] }))
    const report = await reconcileKinds(adapter, {
      issueNumber: 10,
      apply: true,
      event: { action: 'unlabeled', label: 'kind:docs' },
      eventUpdatedAt: '2026-07-20T10:00:00Z',
    })

    expect(adapter.addLabels).toHaveBeenCalledWith(10, ['kind:docs'])
    expect(adapter.syncProjectKind).toHaveBeenCalledWith(
      expect.objectContaining({ number: 10 }),
      'Docs',
      true,
    )
    expect(report.results[0]).toMatchObject({ applied: true, labelsToAdd: ['kind:docs'] })
  })

  it('does not claim an apply-mode no-op performed a mutation', async () => {
    const adapter = port(issue())
    const report = await reconcileKinds(adapter, { issueNumber: 10, apply: true })

    expect(report.results[0]).toMatchObject({
      applied: false,
      projectAction: 'unchanged',
    })
  })

  it('sorts a full reconciliation and summarizes each invalid state', async () => {
    const adapter = port(issue())
    vi.mocked(adapter.listOpenIssues).mockResolvedValue([
      issue({ number: 12, labels: ['kind:feature', 'kind:bug'] }),
      issue({ number: 11, labels: [] }),
      issue({ number: 10 }),
    ])

    const report = await reconcileKinds(adapter, { apply: false })

    expect(report.results.map((result) => result.issueNumber)).toEqual([10, 11, 12])
    expect(report.summary).toMatchObject({ total: 3, valid: 1, missing: 1, ambiguous: 1 })
  })

  it('converges closed issue Project metadata to its lifecycle state', async () => {
    const adapter = port(issue({ state: 'CLOSED' }))
    const report = await reconcileKinds(adapter, { issueNumber: 10, apply: true })

    expect(report.summary.closed).toBe(1)
    expect(adapter.syncProjectKind).toHaveBeenCalledWith(
      expect.objectContaining({ number: 10, state: 'CLOSED' }),
      'Feature',
      true,
    )
  })
})
