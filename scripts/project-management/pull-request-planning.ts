import type {
  PlanningConvergenceInput,
  PlanningRecordInput,
  PlanningRecordReport,
} from './planning-record.ts'
import { resolveIssueDelivery } from './issue-delivery.ts'
import {
  parseCompletingChildTrailer,
  parseContributionTrailers,
  type PullRequestBodySnapshot,
  type PullRequestSnapshot,
} from './pull-request-relationships.ts'

export interface PullRequestPlanningPort {
  getPullRequest: (pullRequestNumber: number) => Promise<PullRequestSnapshot>
  listOpenPullRequestBodies: () => Promise<PullRequestBodySnapshot[]>
  listEpicBranches: (parentIssueNumber: number) => Promise<string[]>
}

export interface PlanningRecordReconcilerPort {
  reconcile: (input: PlanningRecordInput) => Promise<PlanningRecordReport>
  converge: (input: PlanningConvergenceInput) => Promise<PlanningRecordReport>
}

export interface IssueCompletionPort {
  closeIssue: (issueNumber: number) => Promise<void>
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
    | 'malformed-completing-child'
    | 'multiple-completing-children'
    | 'self-reference'
    | 'cross-repository-completion'
    | 'redundant-relationship'
    | 'child-not-open'
    | 'missing-parent'
    | 'cross-repository-parent'
    | 'parent-not-open'
    | 'parent-not-epic'
    | 'nested-epic'
    | 'missing-epic-branch'
    | 'ambiguous-epic-branch'
    | 'base-mismatch'
    | 'planning-record-failure'
    | 'child-close-failure'
  message: string
  line?: number
  issueNumber?: number
  repository?: string
}

type CandidateRelationship =
  'closing' | 'child-completion' | 'parent-epic' | 'contribution' | 'removed-contribution'

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
    | 'planning-record-failure'
  statusBefore?: string | null
  statusAfter?: string | null
}

export interface CompletingChildResult {
  issueNumber?: number
  parentIssueNumber?: number
  expectedBase?: string
  validation: 'valid' | 'failed'
  closure: 'not-applicable' | 'would-close' | 'closed' | 'unchanged' | 'failed'
}

export interface PullRequestPlanningReport {
  apply: boolean
  applied: boolean
  pullRequest: {
    repository: string
    number: number
    state: PullRequestSnapshot['state']
    draft: boolean
    base: string
    head: string
  }
  relationships: {
    closing: number[]
    completingChild: number[]
    contribution: number[]
    removedContribution: number[]
  }
  completingChild: CompletingChildResult | null
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

interface ValidCompletingChild {
  issueNumber: number
  parentIssueNumber: number
  expectedBase: string
  childWasClosed: boolean
}

export async function reconcilePullRequestPlanning(
  pullRequests: PullRequestPlanningPort,
  planningRecords: PlanningRecordReconcilerPort,
  issues: IssueCompletionPort,
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
  const completingChild = parseCompletingChildTrailer(
    pullRequest.body,
    pullRequest.number,
  )
  const diagnostics = [
    ...contributionDiagnostics(currentContributions),
    ...completingChildDiagnostics(completingChild),
  ]
  const candidates = new Map<number, Set<CandidateRelationship>>()
  const directActivity = new Set<number>()
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
    if (pullRequest.state === 'OPEN') directActivity.add(issue.number)
  }

  const contribution = new Set(currentContributions.issueNumbers)
  for (const issueNumber of contribution) {
    addCandidate(candidates, issueNumber, 'contribution')
    if (pullRequest.state === 'OPEN' || pullRequest.state === 'MERGED') {
      directActivity.add(issueNumber)
    }
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

  let validCompletingChild: ValidCompletingChild | undefined
  let completingChildResult: CompletingChildResult | null =
    completingChild.issueNumber === undefined && completingChild.errors.length === 0
      ? null
      : { validation: 'failed', closure: 'not-applicable' }
  if (completingChild.issueNumber !== undefined) {
    const validated = await validateCompletingChild(
      pullRequests,
      planningRecords,
      pullRequest,
      completingChild.issueNumber,
    )
    diagnostics.push(...validated.diagnostics)
    validCompletingChild = validated.result
    completingChildResult =
      validated.result === undefined
        ? {
            issueNumber: completingChild.issueNumber,
            validation: 'failed',
            closure: 'not-applicable',
          }
        : {
            issueNumber: validated.result.issueNumber,
            parentIssueNumber: validated.result.parentIssueNumber,
            expectedBase: validated.result.expectedBase,
            validation: 'valid',
            closure: 'not-applicable',
          }
  }

  if (validCompletingChild !== undefined) {
    addCandidate(candidates, validCompletingChild.issueNumber, 'child-completion')
    addCandidate(candidates, validCompletingChild.parentIssueNumber, 'parent-epic')
    if (pullRequest.state !== 'CLOSED') {
      directActivity.add(validCompletingChild.issueNumber)
      directActivity.add(validCompletingChild.parentIssueNumber)
    }
    if (contribution.has(validCompletingChild.issueNumber)) {
      diagnostics.push({
        severity: 'warning',
        code: 'redundant-relationship',
        message: `Issue #${validCompletingChild.issueNumber} is both a completing-child and contribution relationship; completing-child semantics take precedence.`,
        issueNumber: validCompletingChild.issueNumber,
      })
    }
  }

  const openRelationships =
    candidates.size === 0
      ? new Map<number, Set<number>>()
      : indexOpenRelationships(
          await pullRequests.listOpenPullRequestBodies(),
          pullRequest.repository,
        )
  if (pullRequest.state === 'OPEN') {
    for (const issueNumber of contribution) {
      addOpenRelationship(openRelationships, issueNumber, pullRequest.number)
    }
    if (validCompletingChild !== undefined) {
      addOpenRelationship(
        openRelationships,
        validCompletingChild.issueNumber,
        pullRequest.number,
      )
    }
  }

  const targets: PullRequestPlanningTarget[] = []
  let planningApplied = false
  for (const [issueNumber, relationships] of [...candidates].sort(
    ([first], [second]) => first - second,
  )) {
    if (pullRequest.state === 'MERGED' && relationships.has('closing')) {
      targets.push({
        issueNumber,
        relationships: sortedRelationships(relationships),
        outcome: 'unchanged',
        reason: 'completion-merge-deferred',
      })
      continue
    }
    const reconciled = await reconcileTarget(planningRecords, {
      issueNumber,
      relationships,
      apply: input.apply,
      directlyActive: directActivity.has(issueNumber),
      activeBodyRelationship: (openRelationships.get(issueNumber)?.size ?? 0) > 0,
      repository,
    })
    targets.push(reconciled.target)
    planningApplied ||= reconciled.applied
    if (reconciled.diagnostic !== undefined) diagnostics.push(reconciled.diagnostic)
  }

  if (
    validCompletingChild !== undefined &&
    completingChildResult !== null &&
    pullRequest.state === 'MERGED'
  ) {
    const lateValidation = await validateCompletingChild(
      pullRequests,
      planningRecords,
      pullRequest,
      validCompletingChild.issueNumber,
    )
    if (lateValidation.result === undefined) {
      diagnostics.push(...lateValidation.diagnostics)
      completingChildResult.validation = 'failed'
      completingChildResult.closure = 'not-applicable'
      validCompletingChild = undefined
    } else {
      validCompletingChild = lateValidation.result
    }
  }

  if (
    validCompletingChild !== undefined &&
    completingChildResult !== null &&
    pullRequest.state === 'MERGED'
  ) {
    if (validCompletingChild.childWasClosed) {
      completingChildResult.closure = 'unchanged'
    } else if (!input.apply) {
      completingChildResult.closure = 'would-close'
    } else {
      try {
        await issues.closeIssue(validCompletingChild.issueNumber)
        completingChildResult.closure = 'closed'
      } catch (error) {
        completingChildResult.closure = 'failed'
        diagnostics.push({
          severity: 'error',
          code: 'child-close-failure',
          message: `Issue #${validCompletingChild.issueNumber} could not be closed after completing PR #${pullRequest.number}: ${errorMessage(error)}`,
          issueNumber: validCompletingChild.issueNumber,
        })
      }
      if (completingChildResult.closure === 'closed') {
        try {
          await planningRecords.converge({
            issueNumber: validCompletingChild.issueNumber,
            active: false,
            apply: true,
          })
        } catch (error) {
          diagnostics.push({
            severity: 'error',
            code: 'planning-record-failure',
            message: `Issue #${validCompletingChild.issueNumber} closed, but its Project record did not converge: ${errorMessage(error)}`,
            issueNumber: validCompletingChild.issueNumber,
          })
        }
      }
    }
  }

  const summary = summarize(targets, diagnostics)
  return {
    apply: input.apply,
    applied: planningApplied || completingChildResult?.closure === 'closed',
    pullRequest: {
      repository: pullRequest.repository,
      number: pullRequest.number,
      state: pullRequest.state,
      draft: pullRequest.isDraft,
      base: pullRequest.baseRefName,
      head: pullRequest.headRefName,
    },
    relationships: {
      closing: [...closing].sort((first, second) => first - second),
      completingChild:
        completingChild.issueNumber === undefined ? [] : [completingChild.issueNumber],
      contribution: [...contribution].sort((first, second) => first - second),
      removedContribution,
    },
    completingChild: completingChildResult,
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
  const openRelationships = indexOpenRelationships(
    await pullRequests.listOpenPullRequestBodies(),
    input.repository,
  )
  const inspected = await planningRecords.reconcile({
    issueNumber: input.issueNumber,
    ensureProject: false,
    apply: false,
  })
  const activeClosing = inspected.record.issue.linkedPullRequests.some(
    (related) =>
      related.repository.toLowerCase() === input.repository.toLowerCase() &&
      related.relationship === 'closing' &&
      related.state === 'OPEN',
  )
  const reconciled = await reconcileTarget(planningRecords, {
    issueNumber: input.issueNumber,
    relationships: new Set<CandidateRelationship>(),
    repository: input.repository.toLowerCase(),
    apply: input.apply,
    directlyActive: activeClosing,
    activeBodyRelationship: (openRelationships.get(input.issueNumber)?.size ?? 0) > 0,
  })
  const diagnostics = reconciled.diagnostic === undefined ? [] : [reconciled.diagnostic]
  const summary = summarize([reconciled.target], diagnostics)
  return {
    apply: input.apply,
    applied: reconciled.applied,
    issue: { repository: input.repository, number: input.issueNumber },
    target: reconciled.target,
    diagnostics,
    summary,
  }
}

async function validateCompletingChild(
  pullRequests: Pick<PullRequestPlanningPort, 'listEpicBranches'>,
  planningRecords: PlanningRecordReconcilerPort,
  pullRequest: PullRequestSnapshot,
  issueNumber: number,
): Promise<{
  result?: ValidCompletingChild
  diagnostics: PullRequestPlanningDiagnostic[]
}> {
  try {
    const resolution = await resolveIssueDelivery(
      {
        inspectIssue: (number) =>
          planningRecords.reconcile({
            issueNumber: number,
            ensureProject: false,
            apply: false,
          }),
        listEpicBranches: (number) => pullRequests.listEpicBranches(number),
      },
      issueNumber,
    )
    if (resolution.issue.issue.state === 'CLOSED' && pullRequest.state !== 'MERGED') {
      return validationFailure(
        'child-not-open',
        `Completing child #${issueNumber} is closed; reopen it before opening a correction PR.`,
        issueNumber,
      )
    }
    if (resolution.conflicts.length > 0) {
      return {
        diagnostics: resolution.conflicts.map((conflict) => ({
          severity: 'error' as const,
          code:
            conflict.code === 'parent-closed'
              ? ('parent-not-open' as const)
              : conflict.code,
          message: conflict.message,
          issueNumber: resolution.parent?.issue.number ?? issueNumber,
        })),
      }
    }
    if (resolution.path !== 'epic-child' || resolution.parent === null) {
      return validationFailure(
        'missing-parent',
        `Completing child #${issueNumber} has no native parent issue.`,
        issueNumber,
      )
    }
    const expectedBase = resolution.base
    if (expectedBase === null) {
      throw new Error('Epic-child delivery resolved without an exact base.')
    }
    if (pullRequest.baseRefName !== expectedBase) {
      return validationFailure(
        'base-mismatch',
        `Completing PR #${pullRequest.number} targets ${pullRequest.baseRefName}; expected ${expectedBase}.`,
        issueNumber,
      )
    }

    return {
      result: {
        issueNumber,
        parentIssueNumber: resolution.parent.issue.number,
        expectedBase,
        childWasClosed: resolution.issue.issue.state === 'CLOSED',
      },
      diagnostics: [],
    }
  } catch (error) {
    return validationFailure(
      'planning-record-failure',
      `Completing child #${issueNumber} could not be validated: ${errorMessage(error)}`,
      issueNumber,
    )
  }
}

function validationFailure(
  code: PullRequestPlanningDiagnostic['code'],
  message: string,
  issueNumber: number,
): { diagnostics: PullRequestPlanningDiagnostic[] } {
  return {
    diagnostics: [{ severity: 'error', code, message, issueNumber }],
  }
}

interface ReconcileTargetInput {
  issueNumber: number
  relationships: Set<CandidateRelationship>
  repository: string
  apply: boolean
  directlyActive: boolean
  activeBodyRelationship: boolean
}

async function reconcileTarget(
  planningRecords: PlanningRecordReconcilerPort,
  input: ReconcileTargetInput,
): Promise<{
  target: PullRequestPlanningTarget
  applied: boolean
  diagnostic?: PullRequestPlanningDiagnostic
}> {
  try {
    const inspected = await planningRecords.reconcile({
      issueNumber: input.issueNumber,
      ensureProject: false,
      apply: false,
    })
    const record = inspected.record
    const activeClosing = record.issue.linkedPullRequests.some(
      (related) =>
        related.repository.toLowerCase() === input.repository &&
        related.relationship === 'closing' &&
        related.state === 'OPEN',
    )
    const active = input.directlyActive || input.activeBodyRelationship || activeClosing
    const converged = await planningRecords.converge({
      issueNumber: input.issueNumber,
      active,
      apply: input.apply,
    })
    const operation = converged.operations.find(
      (candidate) => candidate.operation === 'set-status',
    )
    const targetBase = {
      issueNumber: input.issueNumber,
      relationships: sortedRelationships(input.relationships),
      statusBefore: record.project.status,
      statusAfter: converged.record.project.status,
    }

    if (record.issue.state === 'CLOSED') {
      return {
        target: { ...targetBase, outcome: 'unchanged', reason: 'issue-closed' },
        applied: converged.applied,
      }
    }
    if (!active) {
      return {
        target: {
          ...targetBase,
          outcome: 'unchanged',
          reason: 'no-active-relationship',
        },
        applied: converged.applied,
      }
    }
    if (operation?.outcome === 'updated') {
      return {
        target: { ...targetBase, outcome: 'advanced', reason: 'active-relationship' },
        applied: converged.applied,
      }
    }
    if (operation?.outcome === 'would-update') {
      return {
        target: {
          ...targetBase,
          outcome: 'would-advance',
          reason: 'active-relationship',
        },
        applied: converged.applied,
      }
    }
    return {
      target: { ...targetBase, outcome: 'unchanged', reason: 'status-not-todo' },
      applied: converged.applied,
    }
  } catch (error) {
    return {
      target: {
        issueNumber: input.issueNumber,
        relationships: sortedRelationships(input.relationships),
        outcome: 'failed',
        reason: 'planning-record-failure',
      },
      applied: false,
      diagnostic: {
        severity: 'error',
        code: 'planning-record-failure',
        message: `Issue #${input.issueNumber} could not be reconciled: ${errorMessage(error)}`,
        issueNumber: input.issueNumber,
      },
    }
  }
}

function indexOpenRelationships(
  pullRequests: PullRequestBodySnapshot[],
  repository: string,
): Map<number, Set<number>> {
  const relationships = new Map<number, Set<number>>()
  for (const pullRequest of pullRequests) {
    if (pullRequest.repository.toLowerCase() !== repository.toLowerCase()) continue
    const contributions = parseContributionTrailers(pullRequest.body, pullRequest.number)
    for (const issueNumber of contributions.issueNumbers) {
      addOpenRelationship(relationships, issueNumber, pullRequest.number)
    }
    const completingChild = parseCompletingChildTrailer(
      pullRequest.body,
      pullRequest.number,
    )
    if (completingChild.issueNumber !== undefined) {
      addOpenRelationship(relationships, completingChild.issueNumber, pullRequest.number)
    }
  }
  return relationships
}

function addOpenRelationship(
  relationships: Map<number, Set<number>>,
  issueNumber: number,
  pullRequestNumber: number,
): void {
  const pullRequests = relationships.get(issueNumber) ?? new Set<number>()
  pullRequests.add(pullRequestNumber)
  relationships.set(issueNumber, pullRequests)
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

function completingChildDiagnostics(
  parsed: ReturnType<typeof parseCompletingChildTrailer>,
): PullRequestPlanningDiagnostic[] {
  return parsed.errors.map((error) => ({
    severity: 'error',
    code: error.code,
    message:
      error.code === 'self-reference'
        ? `A pull request cannot complete its own number #${error.issueNumber}.`
        : error.code === 'multiple-completing-children'
          ? 'An epic-child PR must name exactly one direct child once.'
          : 'Completes-child trailers must use exactly: Completes-child: #N',
    line: error.line,
    ...(error.issueNumber === undefined ? {} : { issueNumber: error.issueNumber }),
  }))
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
  'child-completion',
  'parent-epic',
  'contribution',
  'removed-contribution',
]

function sortedRelationships(
  relationships: Set<CandidateRelationship>,
): CandidateRelationship[] {
  return RELATIONSHIP_ORDER.filter((relationship) => relationships.has(relationship))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown planning failure'
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
