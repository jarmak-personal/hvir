import type { PlanningIssueSnapshot } from './issue-planning.ts'
import { isKindLabel, planKindLabels, type KindOption } from './kind-policy.ts'
import type { ProjectStatus } from './planning-fields.ts'

export interface ProjectPlanningItem {
  id: string
  archived: boolean
  repository: string
  issueNumber: number
  kind: string | null
  status: string | null
}

export interface ProjectIssueIdentity {
  id: string
  number: number
  state: 'OPEN' | 'CLOSED'
}

export interface IssuePlanningPort {
  getPlanningIssue: (issueNumber: number) => Promise<PlanningIssueSnapshot>
}

export interface ProjectPlanningPort {
  validatePlanningSchema: () => Promise<void>
  getIssueItem: (issueNumber: number) => Promise<ProjectPlanningItem | undefined>
  refreshIssueItem: (issueNumber: number) => Promise<ProjectPlanningItem | undefined>
  addIssue: (issue: ProjectIssueIdentity) => Promise<ProjectPlanningItem>
  unarchiveIssue: (
    issue: ProjectIssueIdentity,
    item: ProjectPlanningItem,
  ) => Promise<ProjectPlanningItem>
  setKind: (item: ProjectPlanningItem, kind: KindOption) => Promise<boolean>
  setStatus: (item: ProjectPlanningItem, status: ProjectStatus) => Promise<void>
}

export interface PlanningRecordInput {
  issueNumber: number
  ensureProject: boolean
  derivedKind?: KindOption
  status?: ProjectStatus
  expectedStatus?: ProjectStatus
  openOnly?: boolean
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
  | {
      operation: 'set-kind'
      outcome: 'unchanged' | 'would-update' | 'updated'
      from: string | null
      to: KindOption
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
  if (input.expectedStatus !== undefined && input.status === undefined) {
    throw new Error('A conditional Status update requires a target Status.')
  }
  let issue = await issues.getPlanningIssue(input.issueNumber)
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

  if (input.derivedKind !== undefined) {
    if (item === undefined || item.archived) {
      if (!input.ensureProject) {
        throw new Error(
          `Issue #${issue.number} is ${item === undefined ? 'missing from' : 'archived in'} the canonical Project. Normal convergence requires an active Project item.`,
        )
      }
      operations.push({
        operation: 'set-kind',
        outcome: 'would-update',
        from: item?.kind ?? null,
        to: input.derivedKind,
      })
    } else if (item.kind === input.derivedKind) {
      operations.push({
        operation: 'set-kind',
        outcome: 'unchanged',
        from: item.kind,
        to: input.derivedKind,
      })
    } else if (input.apply) {
      const previous = item.kind
      await project.setKind(item, input.derivedKind)
      operations.push({
        operation: 'set-kind',
        outcome: 'updated',
        from: previous,
        to: input.derivedKind,
      })
      applied = true
    } else {
      operations.push({
        operation: 'set-kind',
        outcome: 'would-update',
        from: item.kind,
        to: input.derivedKind,
      })
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
    } else if (input.openOnly === true && issue.state !== 'OPEN') {
      operations.push({
        operation: 'set-status',
        outcome: 'unchanged',
        from: item.status,
        to: input.status,
      })
    } else if (item.status === input.status) {
      operations.push({
        operation: 'set-status',
        outcome: 'unchanged',
        from: item.status,
        to: input.status,
      })
    } else if (
      input.expectedStatus !== undefined &&
      item.status !== input.expectedStatus
    ) {
      operations.push({
        operation: 'set-status',
        outcome: 'unchanged',
        from: item.status,
        to: input.status,
      })
    } else if (input.apply) {
      if (input.openOnly === true) {
        issue = await issues.getPlanningIssue(input.issueNumber)
        if (issue.state !== 'OPEN') {
          operations.push({
            operation: 'set-status',
            outcome: 'unchanged',
            from: item.status,
            to: input.status,
          })
          return {
            apply: input.apply,
            applied,
            record: normalizePlanningRecord(issue, item),
            operations,
          }
        }
      }
      if (input.expectedStatus !== undefined) {
        item = await project.refreshIssueItem(issue.number)
        if (item === undefined || item.archived) {
          throw new Error(
            `Issue #${issue.number} became ${item === undefined ? 'missing from' : 'archived in'} the canonical Project before its conditional Status update.`,
          )
        }
        if (item.status !== input.expectedStatus) {
          operations.push({
            operation: 'set-status',
            outcome: 'unchanged',
            from: item.status,
            to: input.status,
          })
          return {
            apply: input.apply,
            applied,
            record: normalizePlanningRecord(issue, item),
            operations,
          }
        }
      }
      const previous = item.status
      await project.setStatus(item, input.status)
      operations.push({
        operation: 'set-status',
        outcome: 'updated',
        from: previous,
        to: input.status,
      })
      applied = true
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

export interface PlanningConvergenceInput {
  issueNumber: number
  active: boolean
  apply: boolean
  derivedKind?: KindOption
  skipKind?: boolean
}

export async function convergePlanningRecord(
  issues: IssuePlanningPort,
  project: ProjectPlanningPort,
  input: PlanningConvergenceInput,
): Promise<PlanningRecordReport> {
  const issue = await issues.getPlanningIssue(input.issueNumber)
  const kind =
    input.skipKind === true ? undefined : (input.derivedKind ?? requireIssueKind(issue))
  const converged = await convergeProjectPlanning(issue, project, {
    active: input.active,
    apply: input.apply,
    ...(kind === undefined ? {} : { derivedKind: kind }),
  })
  return {
    apply: input.apply,
    applied: converged.applied,
    record: normalizePlanningRecord(issue, converged.item),
    operations: converged.operations,
  }
}

export interface ProjectPlanningConvergenceInput {
  active: boolean
  apply: boolean
  derivedKind?: KindOption
}

export interface ProjectPlanningConvergenceReport {
  item?: ProjectPlanningItem
  operations: PlanningOperation[]
  applied: boolean
}

export async function convergeProjectPlanning(
  issue: ProjectIssueIdentity,
  project: ProjectPlanningPort,
  input: ProjectPlanningConvergenceInput,
): Promise<ProjectPlanningConvergenceReport> {
  await project.validatePlanningSchema()
  let item = await project.getIssueItem(issue.number)
  const operations: PlanningOperation[] = []
  let applied = false

  if (item === undefined || item.archived) {
    if (issue.state === 'CLOSED') {
      throw new Error(
        `Closed issue #${issue.number} has no active item in the canonical Project.`,
      )
    }
    if (input.apply) {
      if (item === undefined) {
        item = await project.addIssue(issue)
        operations.push({ operation: 'ensure-project', outcome: 'added' })
      } else {
        item = await project.unarchiveIssue(issue, item)
        operations.push({ operation: 'ensure-project', outcome: 'restored' })
      }
      applied = true
    } else {
      operations.push({
        operation: 'ensure-project',
        outcome: item === undefined ? 'would-add' : 'would-restore',
      })
    }
  } else {
    operations.push({ operation: 'ensure-project', outcome: 'unchanged' })
  }

  if (input.derivedKind !== undefined) {
    const previous = item?.kind ?? null
    if (previous === input.derivedKind) {
      operations.push({
        operation: 'set-kind',
        outcome: 'unchanged',
        from: previous,
        to: input.derivedKind,
      })
    } else if (input.apply && item !== undefined && !item.archived) {
      await project.setKind(item, input.derivedKind)
      operations.push({
        operation: 'set-kind',
        outcome: 'updated',
        from: previous,
        to: input.derivedKind,
      })
      applied = true
    } else {
      operations.push({
        operation: 'set-kind',
        outcome: 'would-update',
        from: previous,
        to: input.derivedKind,
      })
    }
  }

  const status = convergedProjectStatus(issue.state, item?.status ?? null, input.active)
  if (status !== undefined) {
    const previous = item?.status ?? null
    if (previous === status) {
      operations.push({
        operation: 'set-status',
        outcome: 'unchanged',
        from: previous,
        to: status,
      })
    } else if (input.apply && item !== undefined && !item.archived) {
      await project.setStatus(item, status)
      operations.push({
        operation: 'set-status',
        outcome: 'updated',
        from: previous,
        to: status,
      })
      applied = true
    } else {
      operations.push({
        operation: 'set-status',
        outcome: 'would-update',
        from: previous,
        to: status,
      })
    }
  }

  if (input.apply && applied) {
    item = await project.refreshIssueItem(issue.number)
    if (item === undefined) {
      throw new Error(
        `Issue #${issue.number} was missing from the canonical Project after convergence.`,
      )
    }
  }
  return { item, operations, applied }
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

function requireIssueKind(issue: PlanningIssueSnapshot): KindOption {
  const plan = planKindLabels(issue.labels, { action: 'reconcile' })
  if (plan.state !== 'valid' || plan.kind === undefined) {
    throw new Error(
      `Issue #${issue.number} does not have one valid recognized kind label.`,
    )
  }
  return plan.kind.option
}

function convergedProjectStatus(
  issueState: 'OPEN' | 'CLOSED',
  status: string | null,
  active: boolean,
): ProjectStatus | undefined {
  if (issueState === 'CLOSED') return 'Done'
  if (active) return 'In Progress'
  return status === null || status === 'Done' ? 'Todo' : undefined
}
