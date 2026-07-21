import { describe, expect, it, vi } from 'vitest'

import type { CanonicalProjectItem } from '../scripts/project-management/canonical-project.ts'
import type { PlanningIssueSnapshot } from '../scripts/project-management/issue-planning.ts'
import type { ProjectStatus } from '../scripts/project-management/planning-fields.ts'
import {
  normalizePlanningRecord,
  reconcilePlanningRecord,
  type IssuePlanningPort,
  type ProjectPlanningPort,
} from '../scripts/project-management/planning-record.ts'

function issue(overrides: Partial<PlanningIssueSnapshot> = {}): PlanningIssueSnapshot {
  return {
    id: 'issue-id',
    repository: 'jarmak-personal/hvir',
    number: 85,
    state: 'OPEN',
    updatedAt: '2026-07-20T22:13:01Z',
    labels: ['kind:feature', 'area:infrastructure', 'area:docs'],
    parent: {
      repository: 'jarmak-personal/hvir',
      number: 50,
      state: 'OPEN',
    },
    subIssues: [],
    linkedPullRequests: [],
    ...overrides,
  }
}

function projectItem(
  overrides: Partial<CanonicalProjectItem> = {},
): CanonicalProjectItem {
  return {
    id: 'project-item-id',
    archived: false,
    repository: 'jarmak-personal/hvir',
    issueNumber: 85,
    kind: 'Feature',
    status: 'Todo',
    ...overrides,
  }
}

function ports(
  options: {
    issue?: PlanningIssueSnapshot
    item?: CanonicalProjectItem
  } = {},
): { issues: IssuePlanningPort; project: ProjectPlanningPort } {
  const snapshot = options.issue ?? issue()
  let item = options.item
  return {
    issues: {
      getPlanningIssue: vi.fn().mockResolvedValue(snapshot),
    },
    project: {
      validatePlanningSchema: vi.fn().mockResolvedValue(undefined),
      getIssueItem: vi.fn().mockImplementation(() => Promise.resolve(item)),
      refreshIssueItem: vi.fn().mockImplementation(() => Promise.resolve(item)),
      addIssue: vi.fn().mockImplementation(() => {
        item = projectItem()
        return Promise.resolve(item)
      }),
      unarchiveIssue: vi
        .fn()
        .mockImplementation((_issue, archived: CanonicalProjectItem) => {
          archived.archived = false
          return Promise.resolve(archived)
        }),
      setStatus: vi
        .fn()
        .mockImplementation((target: CanonicalProjectItem, status: ProjectStatus) => {
          target.status = status
          return Promise.resolve()
        }),
    },
  }
}

describe('normalized issue planning records', () => {
  it('normalizes recognized labels and relationships without exposing node IDs', () => {
    const record = normalizePlanningRecord(
      issue({
        labels: ['area:terminal', 'kind:feature', 'area:docs', 'area:terminal'],
        subIssues: [
          {
            repository: 'jarmak-personal/hvir',
            number: 86,
            state: 'OPEN',
          },
        ],
        linkedPullRequests: [
          {
            repository: 'jarmak-personal/hvir',
            number: 84,
            state: 'MERGED',
            mergedAt: '2026-07-20T22:06:43Z',
            relationship: 'closing',
          },
        ],
      }),
      projectItem(),
    )

    expect(record).toMatchObject({
      repository: 'jarmak-personal/hvir',
      issue: {
        number: 85,
        kind: {
          state: 'valid',
          label: 'kind:feature',
          option: 'Feature',
          recognizedLabels: ['kind:feature'],
        },
        areas: ['area:docs', 'area:terminal'],
        parent: { number: 50 },
        subIssues: [{ number: 86 }],
        linkedPullRequests: [{ number: 84, relationship: 'closing' }],
      },
      project: { membership: 'present', kind: 'Feature', status: 'Todo' },
    })
    expect(JSON.stringify(record)).not.toContain('issue-id')
    expect(JSON.stringify(record)).not.toContain('project-item-id')
  })

  it('reports ambiguous kind metadata using only recognized kind labels', () => {
    const record = normalizePlanningRecord(
      issue({ labels: ['kind:feature', 'kind:bug', 'kind:unsupported'] }),
      undefined,
    )

    expect(record.issue.kind).toEqual({
      state: 'ambiguous',
      label: null,
      option: null,
      recognizedLabels: ['kind:bug', 'kind:feature'],
    })
    expect(record.project).toEqual({
      membership: 'missing',
      kind: null,
      status: null,
    })
  })
})

describe('planning record operations', () => {
  it('reads a missing Project record without silently adding it', async () => {
    const { issues, project } = ports()
    const report = await reconcilePlanningRecord(issues, project, {
      issueNumber: 85,
      ensureProject: false,
      apply: false,
    })

    expect(report).toMatchObject({
      apply: false,
      applied: false,
      record: { project: { membership: 'missing' } },
      operations: [],
    })
    expect(project.addIssue).not.toHaveBeenCalled()
    expect(project.unarchiveIssue).not.toHaveBeenCalled()
    expect(project.setStatus).not.toHaveBeenCalled()
  })

  it('plans a Status update in dry-run mode', async () => {
    const { issues, project } = ports({ item: projectItem() })
    const report = await reconcilePlanningRecord(issues, project, {
      issueNumber: 85,
      ensureProject: false,
      status: 'In Progress',
      apply: false,
    })

    expect(report.operations).toEqual([
      {
        operation: 'set-status',
        outcome: 'would-update',
        from: 'Todo',
        to: 'In Progress',
      },
    ])
    expect(report.record.project.status).toBe('Todo')
    expect(project.setStatus).not.toHaveBeenCalled()
  })

  it('applies a Status update and returns the final named value', async () => {
    const { issues, project } = ports({ item: projectItem() })
    const report = await reconcilePlanningRecord(issues, project, {
      issueNumber: 85,
      ensureProject: false,
      status: 'In Progress',
      apply: true,
    })

    expect(project.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ issueNumber: 85 }),
      'In Progress',
    )
    expect(report).toMatchObject({
      applied: true,
      record: { project: { status: 'In Progress' } },
      operations: [{ operation: 'set-status', outcome: 'updated' }],
    })
    expect(project.refreshIssueItem).toHaveBeenCalledWith(85)
  })

  it('fails when an applied mutation cannot be confirmed by a fresh Project read', async () => {
    const { issues, project } = ports({ item: projectItem() })
    vi.mocked(project.refreshIssueItem).mockResolvedValue(undefined)

    await expect(
      reconcilePlanningRecord(issues, project, {
        issueNumber: 85,
        ensureProject: false,
        status: 'In Progress',
        apply: true,
      }),
    ).rejects.toThrow('was missing from the canonical Project after')
  })

  it('leaves an explicit membership mutation applied when a later Status write fails', async () => {
    const { issues, project } = ports()
    vi.mocked(project.setStatus).mockRejectedValue(new Error('Status mutation failed.'))

    await expect(
      reconcilePlanningRecord(issues, project, {
        issueNumber: 85,
        ensureProject: true,
        status: 'In Progress',
        apply: true,
      }),
    ).rejects.toThrow('Status mutation failed.')
    expect(project.addIssue).toHaveBeenCalledOnce()
    expect(project.refreshIssueItem).not.toHaveBeenCalled()
  })

  it('reports a Status no-op without calling the mutation port', async () => {
    const { issues, project } = ports({
      item: projectItem({ status: 'In Progress' }),
    })
    const report = await reconcilePlanningRecord(issues, project, {
      issueNumber: 85,
      ensureProject: false,
      status: 'In Progress',
      apply: true,
    })

    expect(report.applied).toBe(false)
    expect(report.operations[0]).toMatchObject({ outcome: 'unchanged' })
    expect(project.setStatus).not.toHaveBeenCalled()
  })

  it('requires explicit membership intent before setting a missing item Status', async () => {
    const { issues, project } = ports()
    await expect(
      reconcilePlanningRecord(issues, project, {
        issueNumber: 85,
        ensureProject: false,
        status: 'In Progress',
        apply: false,
      }),
    ).rejects.toThrow('Retry with --ensure-project')
    expect(project.addIssue).not.toHaveBeenCalled()
  })

  it('plans a missing-item add and subsequent Status update without mutating', async () => {
    const { issues, project } = ports()
    const report = await reconcilePlanningRecord(issues, project, {
      issueNumber: 85,
      ensureProject: true,
      status: 'In Progress',
      apply: false,
    })

    expect(report.operations).toEqual([
      { operation: 'ensure-project', outcome: 'would-add' },
      {
        operation: 'set-status',
        outcome: 'would-update',
        from: null,
        to: 'In Progress',
      },
    ])
    expect(project.addIssue).not.toHaveBeenCalled()
    expect(project.setStatus).not.toHaveBeenCalled()
  })

  it('adds a missing item before applying its Status', async () => {
    const { issues, project } = ports()
    const report = await reconcilePlanningRecord(issues, project, {
      issueNumber: 85,
      ensureProject: true,
      status: 'In Progress',
      apply: true,
    })

    expect(project.addIssue).toHaveBeenCalledOnce()
    expect(project.setStatus).toHaveBeenCalledOnce()
    expect(report).toMatchObject({
      applied: true,
      record: { project: { membership: 'present', status: 'In Progress' } },
      operations: [
        { operation: 'ensure-project', outcome: 'added' },
        { operation: 'set-status', outcome: 'updated' },
      ],
    })
  })

  it('restores an archived item only when explicitly requested', async () => {
    const archived = projectItem({ archived: true })
    const { issues, project } = ports({ item: archived })

    const inspected = await reconcilePlanningRecord(issues, project, {
      issueNumber: 85,
      ensureProject: false,
      apply: false,
    })
    expect(inspected.record.project.membership).toBe('archived')
    expect(project.unarchiveIssue).not.toHaveBeenCalled()

    const planned = await reconcilePlanningRecord(issues, project, {
      issueNumber: 85,
      ensureProject: true,
      apply: false,
    })
    expect(planned.operations).toEqual([
      { operation: 'ensure-project', outcome: 'would-restore' },
    ])
    expect(project.unarchiveIssue).not.toHaveBeenCalled()

    const restored = await reconcilePlanningRecord(issues, project, {
      issueNumber: 85,
      ensureProject: true,
      apply: true,
    })
    expect(restored.operations).toEqual([
      { operation: 'ensure-project', outcome: 'restored' },
    ])
    expect(restored.record.project.membership).toBe('present')
  })

  it('requires explicit membership intent before setting an archived item Status', async () => {
    const { issues, project } = ports({ item: projectItem({ archived: true }) })
    await expect(
      reconcilePlanningRecord(issues, project, {
        issueNumber: 85,
        ensureProject: false,
        status: 'Done',
        apply: true,
      }),
    ).rejects.toThrow('archived in the canonical Project')
    expect(project.unarchiveIssue).not.toHaveBeenCalled()
    expect(project.setStatus).not.toHaveBeenCalled()
  })

  it('rejects adding or restoring a closed issue', async () => {
    const { issues, project } = ports({ issue: issue({ state: 'CLOSED' }) })
    await expect(
      reconcilePlanningRecord(issues, project, {
        issueNumber: 85,
        ensureProject: true,
        apply: true,
      }),
    ).rejects.toThrow('Closed issue #85 is not eligible')
    expect(project.addIssue).not.toHaveBeenCalled()
  })
})
