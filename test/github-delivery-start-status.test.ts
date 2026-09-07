import { describe, expect, it, vi } from 'vitest'
import { markIssueInProgress } from '../scripts/project-management/github-delivery-adapters.ts'
import type {
  IssuePlanningPort,
  ProjectPlanningPort,
} from '../scripts/project-management/planning-record.ts'
import type { PlanningIssueSnapshot } from '../scripts/project-management/issue-planning.ts'

function fixture() {
  const issue: PlanningIssueSnapshot = {
    id: 'issue',
    number: 757,
    repository: 'owner/repo',
    state: 'OPEN',
    updatedAt: 'now',
    labels: ['kind:refactor'],
    parent: null,
    subIssues: [],
    linkedPullRequests: [],
  }
  const item = {
    id: 'item',
    archived: false,
    repository: 'owner/repo',
    issueNumber: 757,
    kind: 'Refactor',
    status: 'Todo',
  }
  const issues: IssuePlanningPort = {
    getPlanningIssue: vi.fn(() => Promise.resolve(issue)),
  }
  const project: ProjectPlanningPort = {
    validatePlanningSchema: vi.fn().mockResolvedValue(undefined),
    getIssueItem: vi.fn(() => Promise.resolve(item)),
    refreshIssueItem: vi.fn(() => Promise.resolve(item)),
    addIssue: vi.fn(),
    unarchiveIssue: vi.fn(),
    setKind: vi.fn(),
    setStatus: vi.fn<ProjectPlanningPort['setStatus']>((_item, status) => {
      item.status = status
      return Promise.resolve()
    }),
  }
  return { issue, item, issues, project }
}

describe('startup Status adapter at the real planning owner', () => {
  it('reports actual update and idempotent OPEN / In Progress without redundant writes', async () => {
    const { issues, project } = fixture()
    expect(await markIssueInProgress(issues, project, 757)).toBe('updated')
    expect(await markIssueInProgress(issues, project, 757)).toBe('unchanged')
    expect(project.setStatus).toHaveBeenCalledTimes(1)
  })
  it('rejects a concurrent close before mutation even when openOnly safely skips it', async () => {
    const { issue, issues, project } = fixture()
    issues.getPlanningIssue = vi
      .fn<IssuePlanningPort['getPlanningIssue']>()
      .mockResolvedValueOnce(issue)
      .mockResolvedValue({ ...issue, state: 'CLOSED' })
    await expect(markIssueInProgress(issues, project, 757)).rejects.toThrow(
      'did not converge',
    )
    expect(project.setStatus).not.toHaveBeenCalled()
  })
  it('rejects a closed issue already In Progress and an unconverged write', async () => {
    const { issue, item, issues, project } = fixture()
    issue.state = 'CLOSED'
    item.status = 'In Progress'
    await expect(markIssueInProgress(issues, project, 757)).rejects.toThrow(
      'did not converge',
    )
    issue.state = 'OPEN'
    item.status = 'Todo'
    project.setStatus = vi.fn().mockResolvedValue(undefined)
    await expect(markIssueInProgress(issues, project, 757)).rejects.toThrow(
      'did not converge',
    )
  })
})
