import type { PlanningRecordInput, PlanningRecordReport } from './planning-record.ts'
import {
  parseContributionTrailers,
  type PullRequestBodySnapshot,
  type PullRequestSnapshot,
} from './pull-request-relationships.ts'

export interface PullRequestPlanningPort {
  getPullRequest: (pullRequestNumber: number) => Promise<PullRequestSnapshot>
  listOpenPullRequestBodies: () => Promise<PullRequestBodySnapshot[]>
}

export interface PlanningRecordReconcilerPort {
  reconcile: (input: PlanningRecordInput) => Promise<PlanningRecordReport>
}

export interface PullRequestPlanningInput {
  pullRequestNumber: number
  previousBody?: string
  apply: boolean
}

export interface ReopenedIssuePlanningInput {
  repository: string
  issueNumber: number
  apply: boolean
}

export type PullRequestPlanningDiagnostic = {
  severity: 'warning' | 'error'
  code:
    | 'duplicate-trailer'
    | 'malformed-trailer'
    | 'self-reference'
    | 'cross-repository-completion'
    | 'redundant-relationship'
    | 'planning-record-failure'
  message: string
  line?: number
  issueNumber?: number
  repository?: string
}

type CandidateRelationship = 'closing' | 'contribution' | 'removed-contribution'

export interface PullRequestPlanningTarget {
  issueNumber: number
  relationships: CandidateRelationship[]
  outcome: 'would-advance' | 'advanced' | 'unchanged' | 'failed'
  reason:
    | 'active-relationship'
    | 'completion-merge-deferred'
    | 'no-active-relationship'
    | 'issue-closed'
    | 'status-not-todo'
    | 'missing-project-item'
    | 'archived-project-item'
    | 'concurrent-state-change'
    | 'planning-record-failure'
  statusBefore?: string | null
  statusAfter?: string | null
}

export interface PullRequestPlanningReport {
  apply: boolean
  applied: boolean
  pullRequest: {
    repository: string
    number: number
    state: PullRequestSnapshot['state']
    draft: boolean
  }
  relationships: {
    closing: number[]
    contribution: number[]
    removedContribution: number[]
  }
  targets: PullRequestPlanningTarget[]
  diagnostics: PullRequestPlanningDiagnostic[]
  summary: PlanningSummary
}

export interface ReopenedIssuePlanningReport {
  apply: boolean
  applied: boolean
  issue: {
    repository: string
    number: number
  }
  target: PullRequestPlanningTarget
  diagnostics: PullRequestPlanningDiagnostic[]
  summary: PlanningSummary
}

interface PlanningSummary {
  wouldAdvance: number
  advanced: number
  unchanged: number
  failed: number
  warnings: number
  errors: number
}

export async function reconcilePullRequestPlanning(
  pullRequests: PullRequestPlanningPort,
  planningRecords: PlanningRecordReconcilerPort,
  input: PullRequestPlanningInput,
): Promise<PullRequestPlanningReport> {
  const pullRequest = await pullRequests.getPullRequest(input.pullRequestNumber)
  const repository = pullRequest.repository.toLowerCase()
  const currentContributions = parseContributionTrailers(
    pullRequest.body,
    pullRequest.number,
  )
  const previousContributions = parseContributionTrailers(
    input.previousBody ?? '',
    pullRequest.number,
  )
  const diagnostics = contributionDiagnostics(currentContributions)
  const candidates = new Map<number, Set<CandidateRelationship>>()
  const closing = new Set<number>()

  for (const issue of pullRequest.closingIssues) {
    if (issue.repository.toLowerCase() !== repository) {
      diagnostics.push({
        severity: 'error',
        code: 'cross-repository-completion',
        message: `Completion relationship ${issue.repository}#${issue.number} is outside the configured repository.`,
        repository: issue.repository,
        issueNumber: issue.number,
      })
      continue
    }
    closing.add(issue.number)
    addCandidate(candidates, issue.number, 'closing')
  }

  const contribution = new Set(currentContributions.issueNumbers)
  for (const issueNumber of contribution) {
    addCandidate(candidates, issueNumber, 'contribution')
    if (closing.has(issueNumber)) {
      diagnostics.push({
        severity: 'warning',
        code: 'redundant-relationship',
        message: `Issue #${issueNumber} is both a completion and contribution relationship; completion semantics take precedence.`,
        issueNumber,
      })
    }
  }

  const removedContribution = previousContributions.issueNumbers.filter(
    (issueNumber) => !contribution.has(issueNumber),
  )
  for (const issueNumber of removedContribution) {
    addCandidate(candidates, issueNumber, 'removed-contribution')
  }

  const openContributions =
    candidates.size === 0
      ? new Map<number, Set<number>>()
      : indexOpenContributions(
          await pullRequests.listOpenPullRequestBodies(),
          pullRequest.repository,
        )
  if (pullRequest.state === 'OPEN') {
    for (const issueNumber of contribution) {
      addOpenContribution(openContributions, issueNumber, pullRequest.number)
    }
  }

  const targets: PullRequestPlanningTarget[] = []
  for (const [issueNumber, relationships] of [...candidates].sort(
    ([first], [second]) => first - second,
  )) {
    const reconciled = await reconcileTarget(planningRecords, {
      issueNumber,
      relationships,
      repository,
      apply: input.apply,
      completionMergeDeferred:
        pullRequest.state === 'MERGED' && relationships.has('closing'),
      directlyActive:
        (pullRequest.state === 'OPEN' && relationships.has('closing')) ||
        (pullRequest.state === 'MERGED' && relationships.has('contribution')),
      activeContribution: (openContributions.get(issueNumber)?.size ?? 0) > 0,
    })
    targets.push(reconciled.target)
    if (reconciled.diagnostic !== undefined) {
      diagnostics.push(reconciled.diagnostic)
    }
  }

  const summary = summarize(targets, diagnostics)
  return {
    apply: input.apply,
    applied: summary.advanced > 0,
    pullRequest: {
      repository: pullRequest.repository,
      number: pullRequest.number,
      state: pullRequest.state,
      draft: pullRequest.isDraft,
    },
    relationships: {
      closing: [...closing].sort((first, second) => first - second),
      contribution: [...contribution].sort((first, second) => first - second),
      removedContribution,
    },
    targets,
    diagnostics,
    summary,
  }
}

export async function reconcileReopenedIssuePlanning(
  pullRequests: Pick<PullRequestPlanningPort, 'listOpenPullRequestBodies'>,
  planningRecords: PlanningRecordReconcilerPort,
  input: ReopenedIssuePlanningInput,
): Promise<ReopenedIssuePlanningReport> {
  const openContributions = indexOpenContributions(
    await pullRequests.listOpenPullRequestBodies(),
    input.repository,
  )
  const reconciled = await reconcileTarget(planningRecords, {
    issueNumber: input.issueNumber,
    relationships: new Set<CandidateRelationship>(),
    repository: input.repository.toLowerCase(),
    apply: input.apply,
    completionMergeDeferred: false,
    directlyActive: false,
    activeContribution: (openContributions.get(input.issueNumber)?.size ?? 0) > 0,
  })
  const diagnostics = reconciled.diagnostic === undefined ? [] : [reconciled.diagnostic]
  const summary = summarize([reconciled.target], diagnostics)
  return {
    apply: input.apply,
    applied: summary.advanced > 0,
    issue: { repository: input.repository, number: input.issueNumber },
    target: reconciled.target,
    diagnostics,
    summary,
  }
}

interface ReconcileTargetInput {
  issueNumber: number
  relationships: Set<CandidateRelationship>
  repository: string
  apply: boolean
  completionMergeDeferred: boolean
  directlyActive: boolean
  activeContribution: boolean
}

async function reconcileTarget(
  planningRecords: PlanningRecordReconcilerPort,
  input: ReconcileTargetInput,
): Promise<{
  target: PullRequestPlanningTarget
  diagnostic?: PullRequestPlanningDiagnostic
}> {
  if (input.completionMergeDeferred) {
    return {
      target: {
        issueNumber: input.issueNumber,
        relationships: sortedRelationships(input.relationships),
        outcome: 'unchanged',
        reason: 'completion-merge-deferred',
      },
    }
  }

  try {
    const inspected = await planningRecords.reconcile({
      issueNumber: input.issueNumber,
      ensureProject: false,
      apply: false,
    })
    const record = inspected.record
    const targetBase = {
      issueNumber: input.issueNumber,
      relationships: sortedRelationships(input.relationships),
      statusBefore: record.project.status,
    }

    if (record.issue.state !== 'OPEN') {
      return {
        target: {
          ...targetBase,
          outcome: 'unchanged',
          reason: 'issue-closed',
          statusAfter: record.project.status,
        },
      }
    }
    if (record.project.membership !== 'present') {
      const archived = record.project.membership === 'archived'
      return {
        target: {
          ...targetBase,
          outcome: 'failed',
          reason: archived ? 'archived-project-item' : 'missing-project-item',
          statusAfter: record.project.status,
        },
        diagnostic: {
          severity: 'error',
          code: 'planning-record-failure',
          message: `Issue #${input.issueNumber} is ${archived ? 'archived in' : 'missing from'} the canonical Project.`,
          issueNumber: input.issueNumber,
        },
      }
    }

    const activeClosing = record.issue.linkedPullRequests.some(
      (related) =>
        related.repository.toLowerCase() === input.repository &&
        related.relationship === 'closing' &&
        related.state === 'OPEN',
    )
    if (!input.directlyActive && !input.activeContribution && !activeClosing) {
      return {
        target: {
          ...targetBase,
          outcome: 'unchanged',
          reason: 'no-active-relationship',
          statusAfter: record.project.status,
        },
      }
    }
    if (record.project.status !== 'Todo') {
      return {
        target: {
          ...targetBase,
          outcome: 'unchanged',
          reason: 'status-not-todo',
          statusAfter: record.project.status,
        },
      }
    }

    const advanced = await planningRecords.reconcile({
      issueNumber: input.issueNumber,
      ensureProject: false,
      status: 'In Progress',
      expectedStatus: 'Todo',
      openOnly: true,
      apply: input.apply,
    })
    const operation = advanced.operations.find(
      (candidate) => candidate.operation === 'set-status',
    )
    if (operation?.outcome === 'updated') {
      return {
        target: {
          ...targetBase,
          outcome: 'advanced',
          reason: 'active-relationship',
          statusAfter: advanced.record.project.status,
        },
      }
    }
    if (operation?.outcome === 'would-update') {
      return {
        target: {
          ...targetBase,
          outcome: 'would-advance',
          reason: 'active-relationship',
          statusAfter: advanced.record.project.status,
        },
      }
    }
    return {
      target: {
        ...targetBase,
        outcome: 'unchanged',
        reason:
          advanced.record.issue.state === 'CLOSED'
            ? 'issue-closed'
            : 'concurrent-state-change',
        statusAfter: advanced.record.project.status,
      },
    }
  } catch (error) {
    return {
      target: {
        issueNumber: input.issueNumber,
        relationships: sortedRelationships(input.relationships),
        outcome: 'failed',
        reason: 'planning-record-failure',
      },
      diagnostic: {
        severity: 'error',
        code: 'planning-record-failure',
        message: planningFailureMessage(input.issueNumber, error),
        issueNumber: input.issueNumber,
      },
    }
  }
}

function indexOpenContributions(
  pullRequests: PullRequestBodySnapshot[],
  repository: string,
): Map<number, Set<number>> {
  const contributions = new Map<number, Set<number>>()
  for (const pullRequest of pullRequests) {
    if (pullRequest.repository.toLowerCase() !== repository.toLowerCase()) continue
    const parsed = parseContributionTrailers(pullRequest.body, pullRequest.number)
    for (const issueNumber of parsed.issueNumbers) {
      addOpenContribution(contributions, issueNumber, pullRequest.number)
    }
  }
  return contributions
}

function addOpenContribution(
  contributions: Map<number, Set<number>>,
  issueNumber: number,
  pullRequestNumber: number,
): void {
  const pullRequests = contributions.get(issueNumber) ?? new Set<number>()
  pullRequests.add(pullRequestNumber)
  contributions.set(issueNumber, pullRequests)
}

function contributionDiagnostics(
  parsed: ReturnType<typeof parseContributionTrailers>,
): PullRequestPlanningDiagnostic[] {
  return [
    ...parsed.errors.map((error): PullRequestPlanningDiagnostic => ({
      severity: 'error',
      code: error.code,
      message:
        error.code === 'self-reference'
          ? `A pull request cannot contribute to its own number #${error.issueNumber}.`
          : 'Contributes-to trailers must use exactly: Contributes-to: #N',
      line: error.line,
      ...(error.issueNumber === undefined ? {} : { issueNumber: error.issueNumber }),
    })),
    ...parsed.warnings.map((warning): PullRequestPlanningDiagnostic => ({
      severity: 'warning',
      code: warning.code,
      message: `Duplicate contribution trailer for issue #${warning.issueNumber} was ignored.`,
      line: warning.line,
      issueNumber: warning.issueNumber,
    })),
  ]
}

function addCandidate(
  candidates: Map<number, Set<CandidateRelationship>>,
  issueNumber: number,
  relationship: CandidateRelationship,
): void {
  const relationships = candidates.get(issueNumber) ?? new Set<CandidateRelationship>()
  relationships.add(relationship)
  candidates.set(issueNumber, relationships)
}

const RELATIONSHIP_ORDER: CandidateRelationship[] = [
  'closing',
  'contribution',
  'removed-contribution',
]

function sortedRelationships(
  relationships: Set<CandidateRelationship>,
): CandidateRelationship[] {
  return RELATIONSHIP_ORDER.filter((relationship) => relationships.has(relationship))
}

function planningFailureMessage(issueNumber: number, error: unknown): string {
  const detail = error instanceof Error ? error.message : 'unknown planning failure'
  return `Issue #${issueNumber} could not be reconciled: ${detail}`
}

function summarize(
  targets: PullRequestPlanningTarget[],
  diagnostics: PullRequestPlanningDiagnostic[],
): PlanningSummary {
  return {
    wouldAdvance: targets.filter((target) => target.outcome === 'would-advance').length,
    advanced: targets.filter((target) => target.outcome === 'advanced').length,
    unchanged: targets.filter((target) => target.outcome === 'unchanged').length,
    failed: targets.filter((target) => target.outcome === 'failed').length,
    warnings: diagnostics.filter((diagnostic) => diagnostic.severity === 'warning')
      .length,
    errors: diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length,
  }
}
