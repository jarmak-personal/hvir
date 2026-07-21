import type { PlanningIssueSnapshot } from './issue-planning.ts'
import { isKindLabel, planKindLabels } from './kind-policy.ts'
import type { ProjectStatus } from './planning-fields.ts'

export interface ProjectPlanningItem {
  id: string
  archived: boolean
  repository: string
  issueNumber: number
  kind: string | null
  status: string | null
}

export interface IssuePlanningPort {
  getPlanningIssue: (issueNumber: number) => Promise<PlanningIssueSnapshot>
}

export interface ProjectPlanningPort {
  validatePlanningSchema: () => Promise<void>
  getIssueItem: (issueNumber: number) => Promise<ProjectPlanningItem | undefined>
  refreshIssueItem: (issueNumber: number) => Promise<ProjectPlanningItem | undefined>
  addIssue: (issue: PlanningIssueSnapshot) => Promise<ProjectPlanningItem>
  unarchiveIssue: (
    issue: PlanningIssueSnapshot,
    item: ProjectPlanningItem,
  ) => Promise<ProjectPlanningItem>
  setStatus: (item: ProjectPlanningItem, status: ProjectStatus) => Promise<boolean>
}

export interface PlanningRecordInput {
  issueNumber: number
  ensureProject: boolean
  status?: ProjectStatus
  apply: boolean
}

export interface NormalizedIssueKind {
  state: 'valid' | 'missing' | 'ambiguous'
  label: string | null
  option: string | null
  recognizedLabels: string[]
}

export interface NormalizedPlanningRecord {
  repository: string
  issue: {
    number: number
    state: 'OPEN' | 'CLOSED'
    kind: NormalizedIssueKind
    areas: string[]
    parent: PlanningIssueSnapshot['parent']
    subIssues: PlanningIssueSnapshot['subIssues']
    linkedPullRequests: PlanningIssueSnapshot['linkedPullRequests']
  }
  project: {
    membership: 'missing' | 'present' | 'archived'
    kind: string | null
    status: string | null
  }
}

export type PlanningOperation =
  | {
      operation: 'ensure-project'
      outcome: 'unchanged' | 'would-add' | 'added' | 'would-restore' | 'restored'
    }
  | {
      operation: 'set-status'
      outcome: 'unchanged' | 'would-update' | 'updated'
      from: string | null
      to: ProjectStatus
    }

export interface PlanningRecordReport {
  apply: boolean
  applied: boolean
  record: NormalizedPlanningRecord
  operations: PlanningOperation[]
}

export async function reconcilePlanningRecord(
  issues: IssuePlanningPort,
  project: ProjectPlanningPort,
  input: PlanningRecordInput,
): Promise<PlanningRecordReport> {
  const issue = await issues.getPlanningIssue(input.issueNumber)
  await project.validatePlanningSchema()
  let item = await project.getIssueItem(input.issueNumber)
  const operations: PlanningOperation[] = []
  let applied = false

  if (input.ensureProject) {
    if (item === undefined) {
      requireOpenForEnsure(issue)
      if (input.apply) {
        item = await project.addIssue(issue)
        operations.push({ operation: 'ensure-project', outcome: 'added' })
        applied = true
      } else {
        operations.push({ operation: 'ensure-project', outcome: 'would-add' })
      }
    } else if (item.archived) {
      requireOpenForEnsure(issue)
      if (input.apply) {
        item = await project.unarchiveIssue(issue, item)
        operations.push({ operation: 'ensure-project', outcome: 'restored' })
        applied = true
      } else {
        operations.push({ operation: 'ensure-project', outcome: 'would-restore' })
      }
    } else {
      operations.push({ operation: 'ensure-project', outcome: 'unchanged' })
    }
  }

  if (input.status !== undefined) {
    if (item === undefined || item.archived) {
      if (!input.ensureProject) {
        throw new Error(
          `Issue #${issue.number} is ${item === undefined ? 'missing from' : 'archived in'} the canonical Project. Retry with --ensure-project to make membership explicit.`,
        )
      }
      operations.push({
        operation: 'set-status',
        outcome: 'would-update',
        from: item?.status ?? null,
        to: input.status,
      })
    } else if (item.status === input.status) {
      operations.push({
        operation: 'set-status',
        outcome: 'unchanged',
        from: item.status,
        to: input.status,
      })
    } else if (input.apply) {
      const previous = item.status
      const updated = await project.setStatus(item, input.status)
      operations.push({
        operation: 'set-status',
        outcome: updated ? 'updated' : 'unchanged',
        from: previous,
        to: input.status,
      })
      applied ||= updated
    } else {
      operations.push({
        operation: 'set-status',
        outcome: 'would-update',
        from: item.status,
        to: input.status,
      })
    }
  }

  if (input.apply && applied) {
    item = await project.refreshIssueItem(issue.number)
    if (item === undefined) {
      throw new Error(
        `Issue #${issue.number} was missing from the canonical Project after its requested mutations completed.`,
      )
    }
  }

  return {
    apply: input.apply,
    applied,
    record: normalizePlanningRecord(issue, item),
    operations,
  }
}

export function normalizePlanningRecord(
  issue: PlanningIssueSnapshot,
  projectItem: ProjectPlanningItem | undefined,
): NormalizedPlanningRecord {
  const kindPlan = planKindLabels(issue.labels, { action: 'reconcile' })
  const recognizedLabels = issue.labels.filter(isKindLabel).sort()
  const areas = [
    ...new Set(issue.labels.filter((label) => label.startsWith('area:'))),
  ].sort()
  return {
    repository: issue.repository,
    issue: {
      number: issue.number,
      state: issue.state,
      kind: {
        state: kindPlan.state,
        label: kindPlan.state === 'valid' ? (kindPlan.kind?.label ?? null) : null,
        option: kindPlan.state === 'valid' ? (kindPlan.kind?.option ?? null) : null,
        recognizedLabels,
      },
      areas,
      parent: issue.parent,
      subIssues: issue.subIssues,
      linkedPullRequests: issue.linkedPullRequests,
    },
    project: {
      membership:
        projectItem === undefined
          ? 'missing'
          : projectItem.archived
            ? 'archived'
            : 'present',
      kind: projectItem?.kind ?? null,
      status: projectItem?.status ?? null,
    },
  }
}

function requireOpenForEnsure(issue: PlanningIssueSnapshot): void {
  if (issue.state !== 'OPEN') {
    throw new Error(
      `Closed issue #${issue.number} is not eligible to be added or restored in the canonical Project.`,
    )
  }
}
