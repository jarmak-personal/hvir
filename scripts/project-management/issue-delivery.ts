import type { PlanningRecordReport } from './planning-record.ts'

export interface IssueDeliveryPort {
  inspectIssue: (issueNumber: number) => Promise<PlanningRecordReport>
  listEpicBranches: (parentIssueNumber: number) => Promise<string[]>
}

export interface IssueDeliveryConflict {
  code:
    | 'cross-repository-parent'
    | 'parent-closed'
    | 'parent-not-epic'
    | 'nested-epic'
    | 'missing-epic-branch'
    | 'ambiguous-epic-branch'
  message: string
}

export interface IssueDeliveryResolution {
  issue: PlanningRecordReport['record']
  parent: PlanningRecordReport['record'] | null
  path: 'ordinary' | 'epic-child'
  base: string | null
  conflicts: IssueDeliveryConflict[]
}

export async function resolveIssueDelivery(
  port: IssueDeliveryPort,
  issueNumber: number,
): Promise<IssueDeliveryResolution> {
  const issue = (await port.inspectIssue(issueNumber)).record
  if (issue.issue.parent === null) {
    return { issue, parent: null, path: 'ordinary', base: 'main', conflicts: [] }
  }

  const conflicts: IssueDeliveryConflict[] = []
  const parentReference = issue.issue.parent
  if (parentReference.repository.toLowerCase() !== issue.repository.toLowerCase()) {
    conflicts.push({
      code: 'cross-repository-parent',
      message: `Issue #${issueNumber} has a parent outside ${issue.repository}.`,
    })
    return { issue, parent: null, path: 'epic-child', base: null, conflicts }
  }

  const parent = (await port.inspectIssue(parentReference.number)).record
  if (parent.issue.state !== 'OPEN') {
    conflicts.push({
      code: 'parent-closed',
      message: `Parent issue #${parent.issue.number} is closed.`,
    })
  }
  if (parent.issue.kind.state !== 'valid' || parent.issue.kind.label !== 'kind:epic') {
    conflicts.push({
      code: 'parent-not-epic',
      message: `Parent issue #${parent.issue.number} is not one valid kind:epic.`,
    })
  }
  if (parent.issue.parent !== null) {
    conflicts.push({
      code: 'nested-epic',
      message: `Parent epic #${parent.issue.number} is itself a sub-issue.`,
    })
  }

  let base: string | null = null
  const branches = await port.listEpicBranches(parent.issue.number)
  if (branches.length === 0) {
    conflicts.push({
      code: 'missing-epic-branch',
      message: `Parent epic #${parent.issue.number} has no matching epic/${parent.issue.number}-* branch.`,
    })
  } else if (branches.length > 1) {
    conflicts.push({
      code: 'ambiguous-epic-branch',
      message: `Parent epic #${parent.issue.number} has more than one matching epic branch.`,
    })
  } else {
    base = branches[0]!
  }

  return { issue, parent, path: 'epic-child', base, conflicts }
}
