import { planKindLabels, type KindEvent, type KindPlan } from './kind-policy.ts'

export interface IssueSnapshot {
  id: string
  number: number
  state: 'OPEN' | 'CLOSED'
  updatedAt: string
  labels: string[]
}

export interface ProjectKindSyncResult {
  action:
    'unchanged' | 'would-add-item' | 'would-update' | 'added-and-updated' | 'updated'
  issueAdded: boolean
}

export interface KindAutomationPort {
  getIssue: (issueNumber: number) => Promise<IssueSnapshot>
  listOpenIssues: () => Promise<IssueSnapshot[]>
  addLabels: (issueNumber: number, labels: string[]) => Promise<void>
  removeLabel: (issueNumber: number, label: string) => Promise<void>
  syncProjectKind: (
    issue: IssueSnapshot,
    option: string,
    apply: boolean,
  ) => Promise<ProjectKindSyncResult>
}

export interface ReconcileKindInput {
  issueNumber?: number
  event?: KindEvent
  eventUpdatedAt?: string
  apply: boolean
}

export interface KindReconciliation {
  issueNumber: number
  state: KindPlan['state'] | 'closed'
  kind?: string
  labelsToAdd: string[]
  labelsToRemove: string[]
  eventWasStale: boolean
  ignoredEvent: boolean
  projectAction?: ProjectKindSyncResult['action']
  detail: string
  applied: boolean
}

export interface ReconciliationReport {
  apply: boolean
  results: KindReconciliation[]
  summary: {
    total: number
    valid: number
    missing: number
    ambiguous: number
    closed: number
    mutations: number
  }
}

export async function reconcileKinds(
  port: KindAutomationPort,
  input: ReconcileKindInput,
): Promise<ReconciliationReport> {
  const issues =
    input.issueNumber === undefined
      ? await port.listOpenIssues()
      : [await port.getIssue(input.issueNumber)]
  const results: KindReconciliation[] = []

  for (const issue of issues.sort((first, second) => first.number - second.number)) {
    results.push(await reconcileIssue(port, issue, input))
  }

  return {
    apply: input.apply,
    results,
    summary: {
      total: results.length,
      valid: results.filter((result) => result.state === 'valid').length,
      missing: results.filter((result) => result.state === 'missing').length,
      ambiguous: results.filter((result) => result.state === 'ambiguous').length,
      closed: results.filter((result) => result.state === 'closed').length,
      mutations: results.filter(
        (result) =>
          result.labelsToAdd.length > 0 ||
          result.labelsToRemove.length > 0 ||
          (result.projectAction !== undefined && result.projectAction !== 'unchanged'),
      ).length,
    },
  }
}

async function reconcileIssue(
  port: KindAutomationPort,
  issue: IssueSnapshot,
  input: ReconcileKindInput,
): Promise<KindReconciliation> {
  if (issue.state === 'CLOSED') {
    return {
      issueNumber: issue.number,
      state: 'closed',
      labelsToAdd: [],
      labelsToRemove: [],
      eventWasStale: false,
      ignoredEvent: false,
      detail: 'Closed issues retain their existing Project Kind value.',
      applied: false,
    }
  }

  const eventWasStale =
    input.event !== undefined &&
    input.eventUpdatedAt !== undefined &&
    Date.parse(issue.updatedAt) > Date.parse(input.eventUpdatedAt)
  const event = eventWasStale ? ({ action: 'reconcile' } as const) : input.event
  const plan = planKindLabels(issue.labels, event ?? { action: 'reconcile' })

  if (plan.state !== 'valid' || plan.kind === undefined) {
    return {
      issueNumber: issue.number,
      state: plan.state,
      labelsToAdd: [],
      labelsToRemove: [],
      eventWasStale,
      ignoredEvent: plan.ignoredEvent,
      detail: plan.detail,
      applied: false,
    }
  }

  if (input.apply) {
    for (const label of plan.labelsToRemove) {
      await port.removeLabel(issue.number, label)
    }
    if (plan.labelsToAdd.length > 0) {
      await port.addLabels(issue.number, plan.labelsToAdd)
    }
  }

  const project = await port.syncProjectKind(issue, plan.kind.option, input.apply)
  const applied =
    input.apply &&
    (plan.labelsToAdd.length > 0 ||
      plan.labelsToRemove.length > 0 ||
      project.action === 'added-and-updated' ||
      project.action === 'updated')
  return {
    issueNumber: issue.number,
    state: 'valid',
    kind: plan.kind.label,
    labelsToAdd: plan.labelsToAdd,
    labelsToRemove: plan.labelsToRemove,
    eventWasStale,
    ignoredEvent: plan.ignoredEvent,
    projectAction: project.action,
    detail: plan.detail,
    applied,
  }
}
