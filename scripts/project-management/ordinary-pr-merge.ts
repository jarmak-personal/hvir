import {
  normalizeAgentWorkComments,
  reconcileAgentWorkLedger,
  type AgentWorkLedgerPort,
  type NormalizedAgentWorkLedger,
  type ReconcileAgentWorkLedgerReport,
} from './agent-work-ledger.ts'
import {
  reconcileAgentWorkProjection,
  type AgentWorkProjectPort,
  type AgentWorkProjectionIssue,
  type AgentWorkProjectionReport,
} from './agent-work-projector.ts'
import { planOrdinaryMergeAcceptanceCorrection } from './ordinary-pr-merge-measurement.ts'
import type {
  NormalizedPlanningRecord,
  PlanningConvergenceInput,
  PlanningRecordReport,
} from './planning-record.ts'

const FULL_SHA_PATTERN = /^[a-f0-9]{40}$/

export type OrdinaryMergePullRequestState = 'OPEN' | 'CLOSED' | 'MERGED'

export interface OrdinaryMergeRequiredCheck {
  name: string
  outcome: 'success' | 'pending' | 'failure'
}

export interface OrdinaryMergePullRequest {
  repository: string
  number: number
  state: OrdinaryMergePullRequestState
  isDraft: boolean
  baseRefName: string
  headRefName: string
  headRefOid: string
  headRepository: string | null
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  mergeStateStatus: string
  reviewDecision: string | null
  mergeCommitOid: string | null
  closingIssues: Array<{ repository: string; number: number }>
  relationshipsComplete: boolean
  requiredChecks: OrdinaryMergeRequiredCheck[]
  checksComplete: boolean
}

export interface OrdinaryMergeAttempt {
  outcome: 'merged' | 'rejected' | 'uncertain'
  mergeCommitOid?: string
}

export interface OrdinaryMergePullRequestPort {
  readPullRequest(pullRequestNumber: number): Promise<OrdinaryMergePullRequest>
  mergePullRequest(
    pullRequestNumber: number,
    expectedHeadOid: string,
  ): Promise<OrdinaryMergeAttempt>
}

export interface OrdinaryMergePlanningPort {
  inspect(issueNumber: number): Promise<PlanningRecordReport>
  converge(input: PlanningConvergenceInput): Promise<PlanningRecordReport>
}

export interface OrdinaryMergeProjectionSourcePort {
  readProjectionIssue(issueNumber: number): Promise<AgentWorkProjectionIssue>
}

export interface OrdinaryPullRequestMergePorts {
  pullRequests: OrdinaryMergePullRequestPort
  planning: OrdinaryMergePlanningPort
  ledger: AgentWorkLedgerPort
  projectionSource: OrdinaryMergeProjectionSourcePort
  project: AgentWorkProjectPort
  wait?: (milliseconds: number) => Promise<void>
}

export interface OrdinaryPullRequestMergeInput {
  pullRequestNumber: number
  apply: boolean
}

interface ResolvedOrdinaryPullRequestMergeInput extends OrdinaryPullRequestMergeInput {
  issueNumber: number
  candidateOid: string
}

export type OrdinaryPullRequestMergeDiagnostic =
  | 'issue-identity-mismatch'
  | 'pull-request-identity-mismatch'
  | 'issue-not-ordinary'
  | 'issue-kind-invalid'
  | 'issue-state-mismatch'
  | 'project-membership-invalid'
  | 'repository-mismatch'
  | 'pull-request-closed-unmerged'
  | 'pull-request-draft'
  | 'base-mismatch'
  | 'head-repository-mismatch'
  | 'head-mismatch'
  | 'relationship-ambiguous'
  | 'relationship-mismatch'
  | 'required-checks-ambiguous'
  | 'required-checks-missing'
  | 'required-check-pending'
  | 'required-check-failed'
  | 'merge-conflict'
  | 'mergeability-unknown'
  | 'merge-state-unresolved'
  | 'review-unresolved'
  | 'merge-rejected'
  | 'merge-outcome-uncertain'
  | 'merge-result-mismatch'
  | 'native-issue-closure-pending'
  | 'project-convergence-failed'
  | 'project-status-not-done'
  | 'measurement-ledger-invalid'
  | 'measurement-candidate-mismatch'
  | 'measurement-append-failed'
  | 'measurement-projection-failed'

export interface OrdinaryPullRequestMergeReport {
  issueNumber: number | null
  pullRequestNumber: number
  candidateOid: string | null
  apply: boolean
  outcome:
    'blocked' | 'would-merge' | 'would-reconcile' | 'merged' | 'recovered' | 'partial'
  pullRequest: {
    state: OrdinaryMergePullRequestState
    base: string
    headBranch: string
    headOid: string
    mergeCommitOid: string | null
    requiredChecks: OrdinaryMergeRequiredCheck[]
  }
  issue: {
    state: 'OPEN' | 'CLOSED' | null
    projectStatus: string | null
  }
  merge: {
    outcome:
      | 'not-attempted'
      | 'would-merge'
      | 'merged'
      | 'already-merged'
      | 'rejected'
      | 'uncertain'
  }
  project: {
    outcome: 'deferred' | 'would-converge' | 'converged' | 'failed'
  }
  measurement: {
    outcome:
      | 'deferred'
      | 'would-append'
      | 'appended'
      | 'duplicate'
      | 'already-reconciled'
      | 'sticky-rework'
      | 'unavailable'
      | 'candidate-mismatch'
      | 'failed'
    firstPass?: 'accepted' | 'rework-required'
    append?: ReconcileAgentWorkLedgerReport['append']['outcome']
  }
  projection: {
    outcome: 'deferred' | AgentWorkProjectionReport['projection']['outcome'] | 'failed'
  }
  diagnostics: OrdinaryPullRequestMergeDiagnostic[]
}

export async function reconcileOrdinaryPullRequestMerge(
  ports: OrdinaryPullRequestMergePorts,
  input: OrdinaryPullRequestMergeInput,
): Promise<OrdinaryPullRequestMergeReport> {
  requireInput(input)
  const initialPullRequest = await ports.pullRequests.readPullRequest(
    input.pullRequestNumber,
  )
  const resolved = resolveOrdinaryPullRequestMergeInput(input, initialPullRequest)
  if (resolved.input === undefined) {
    return unresolvedReport(input, initialPullRequest, resolved.diagnostics)
  }
  const [initialPlanning, initialHistory] = await Promise.all([
    ports.planning.inspect(resolved.input.issueNumber),
    ports.ledger.readCommentHistory(resolved.input.issueNumber),
  ])
  const initialLedger = normalizeAgentWorkComments(
    resolved.input.issueNumber,
    initialHistory,
  )
  const report = initialReport(resolved.input, initialPullRequest, initialPlanning.record)
  report.diagnostics.push(
    ...preMergeDiagnostics(resolved.input, initialPullRequest, initialPlanning.record),
  )
  if (
    initialLedger.diagnostics.length === 0 &&
    planOrdinaryMergeAcceptanceCorrection(initialLedger, resolved.input).candidateMismatch
  ) {
    report.diagnostics.push('measurement-candidate-mismatch')
  }
  if (report.diagnostics.length > 0) return report

  const startedMerged = initialPullRequest.state === 'MERGED'
  if (!startedMerged && !input.apply) {
    report.outcome = 'would-merge'
    report.merge.outcome = 'would-merge'
    return report
  }

  if (!startedMerged) {
    const attempt = await ports.pullRequests.mergePullRequest(
      input.pullRequestNumber,
      resolved.input.candidateOid,
    )
    report.merge.outcome = attempt.outcome
    if (attempt.outcome === 'rejected') report.diagnostics.push('merge-rejected')
    if (attempt.outcome === 'uncertain') {
      report.diagnostics.push('merge-outcome-uncertain')
    }
  } else {
    report.merge.outcome = 'already-merged'
  }

  const confirmed = await confirmMergedState(ports, resolved.input)
  updateObservedState(report, confirmed.pullRequest, confirmed.planning.record)
  if (!isExactMergedCandidate(confirmed.pullRequest, resolved.input)) {
    report.outcome = 'partial'
    report.diagnostics.push('merge-result-mismatch')
    return report
  }
  report.diagnostics = report.diagnostics.filter(
    (diagnostic) =>
      diagnostic !== 'merge-rejected' && diagnostic !== 'merge-outcome-uncertain',
  )
  report.merge.outcome = startedMerged ? 'already-merged' : 'merged'

  const postMergeDiagnostics = preMergeDiagnostics(
    resolved.input,
    confirmed.pullRequest,
    confirmed.planning.record,
  )
  if (postMergeDiagnostics.length > 0) {
    report.outcome = 'partial'
    report.diagnostics.push(...postMergeDiagnostics)
    return report
  }

  if (confirmed.planning.record.issue.state !== 'CLOSED') {
    report.outcome = 'partial'
    report.diagnostics.push('native-issue-closure-pending')
    return report
  }

  let planning: PlanningRecordReport
  try {
    planning = await ports.planning.converge({
      issueNumber: resolved.input.issueNumber,
      active: false,
      apply: input.apply,
    })
  } catch {
    report.outcome = 'partial'
    report.project.outcome = 'failed'
    report.diagnostics.push('project-convergence-failed')
    return report
  }
  updateObservedState(report, confirmed.pullRequest, planning.record)
  report.project.outcome = input.apply ? 'converged' : 'would-converge'
  const plansDone = planning.operations.some(
    (operation) =>
      operation.operation === 'set-status' &&
      operation.to === 'Done' &&
      operation.outcome === 'would-update',
  )
  if (planning.record.project.status !== 'Done' && !(plansDone && !input.apply)) {
    report.outcome = 'partial'
    report.diagnostics.push('project-status-not-done')
    return report
  }

  await reconcileAcceptanceMeasurement(
    ports,
    resolved.input,
    report,
    startedMerged ? initialLedger : undefined,
  )
  report.outcome =
    report.diagnostics.length === 0
      ? !input.apply
        ? 'would-reconcile'
        : startedMerged
          ? 'recovered'
          : 'merged'
      : 'partial'
  return report
}

function resolveOrdinaryPullRequestMergeInput(
  input: OrdinaryPullRequestMergeInput,
  pullRequest: OrdinaryMergePullRequest,
): {
  input?: ResolvedOrdinaryPullRequestMergeInput
  diagnostics: OrdinaryPullRequestMergeDiagnostic[]
} {
  const diagnostics: OrdinaryPullRequestMergeDiagnostic[] = []
  if (pullRequest.number !== input.pullRequestNumber) {
    diagnostics.push('pull-request-identity-mismatch')
  }
  const issueNumber = resolvedClosingIssueNumber(pullRequest)
  if (!pullRequest.relationshipsComplete || pullRequest.closingIssues.length > 1) {
    diagnostics.push('relationship-ambiguous')
  } else if (issueNumber === undefined) {
    diagnostics.push('relationship-mismatch')
  }
  if (!FULL_SHA_PATTERN.test(pullRequest.headRefOid)) {
    diagnostics.push('head-mismatch')
  }
  if (diagnostics.length > 0 || issueNumber === undefined) {
    return { diagnostics: dedupe(diagnostics) }
  }
  return {
    input: {
      ...input,
      issueNumber,
      candidateOid: pullRequest.headRefOid,
    },
    diagnostics: [],
  }
}

function resolvedClosingIssueNumber(
  pullRequest: OrdinaryMergePullRequest,
): number | undefined {
  if (!pullRequest.relationshipsComplete || pullRequest.closingIssues.length !== 1) {
    return undefined
  }
  const closing = pullRequest.closingIssues[0]!
  if (
    closing.repository.toLowerCase() !== pullRequest.repository.toLowerCase() ||
    !Number.isSafeInteger(closing.number) ||
    closing.number <= 0
  ) {
    return undefined
  }
  return closing.number
}

function unresolvedReport(
  input: OrdinaryPullRequestMergeInput,
  pullRequest: OrdinaryMergePullRequest,
  diagnostics: OrdinaryPullRequestMergeDiagnostic[],
): OrdinaryPullRequestMergeReport {
  return {
    issueNumber: resolvedClosingIssueNumber(pullRequest) ?? null,
    pullRequestNumber: input.pullRequestNumber,
    candidateOid: FULL_SHA_PATTERN.test(pullRequest.headRefOid)
      ? pullRequest.headRefOid
      : null,
    apply: input.apply,
    outcome: 'blocked',
    pullRequest: {
      state: pullRequest.state,
      base: pullRequest.baseRefName,
      headBranch: pullRequest.headRefName,
      headOid: pullRequest.headRefOid,
      mergeCommitOid: pullRequest.mergeCommitOid,
      requiredChecks: pullRequest.requiredChecks,
    },
    issue: { state: null, projectStatus: null },
    merge: { outcome: 'not-attempted' },
    project: { outcome: 'deferred' },
    measurement: { outcome: 'deferred' },
    projection: { outcome: 'deferred' },
    diagnostics,
  }
}

async function confirmMergedState(
  ports: OrdinaryPullRequestMergePorts,
  input: ResolvedOrdinaryPullRequestMergeInput,
): Promise<{ pullRequest: OrdinaryMergePullRequest; planning: PlanningRecordReport }> {
  const wait =
    ports.wait ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  let observed = await Promise.all([
    ports.pullRequests.readPullRequest(input.pullRequestNumber),
    ports.planning.inspect(input.issueNumber),
  ])
  for (let attempt = 1; attempt < 4; attempt += 1) {
    if (
      isExactMergedCandidate(observed[0], input) &&
      observed[1].record.issue.state === 'CLOSED'
    ) {
      break
    }
    await wait(250 * attempt)
    observed = await Promise.all([
      ports.pullRequests.readPullRequest(input.pullRequestNumber),
      ports.planning.inspect(input.issueNumber),
    ])
  }
  return { pullRequest: observed[0], planning: observed[1] }
}

async function reconcileAcceptanceMeasurement(
  ports: OrdinaryPullRequestMergePorts,
  input: ResolvedOrdinaryPullRequestMergeInput,
  report: OrdinaryPullRequestMergeReport,
  initialLedger?: NormalizedAgentWorkLedger,
): Promise<void> {
  let ledger: NormalizedAgentWorkLedger
  if (initialLedger === undefined) {
    const history = await ports.ledger.readCommentHistory(input.issueNumber)
    ledger = normalizeAgentWorkComments(input.issueNumber, history)
  } else {
    ledger = initialLedger
  }
  if (ledger.diagnostics.length > 0) {
    report.measurement.outcome = 'failed'
    report.diagnostics.push('measurement-ledger-invalid')
    return
  }

  const correction = planOrdinaryMergeAcceptanceCorrection(ledger, input)
  report.measurement = correction.measurement
  if (correction.candidateMismatch) {
    report.diagnostics.push('measurement-candidate-mismatch')
  }

  if (correction.record !== undefined) {
    let appended: ReconcileAgentWorkLedgerReport
    try {
      appended = await reconcileAgentWorkLedger(ports.ledger, {
        issueNumber: input.issueNumber,
        apply: input.apply,
        record: correction.record,
      })
    } catch {
      report.measurement.outcome = 'failed'
      report.diagnostics.push('measurement-append-failed')
      return
    }
    report.measurement.append = appended.append.outcome
    report.measurement.outcome =
      appended.append.outcome === 'would-append'
        ? 'would-append'
        : appended.append.outcome === 'appended'
          ? 'appended'
          : appended.append.outcome === 'duplicate'
            ? 'duplicate'
            : 'failed'
    if (appended.diagnostics.length > 0 || report.measurement.outcome === 'failed') {
      report.diagnostics.push('measurement-append-failed')
      return
    }
  }

  try {
    const projection = await reconcileAgentWorkProjection(
      {
        readProjectionIssue: (issueNumber) =>
          ports.projectionSource.readProjectionIssue(issueNumber),
        readCommentHistory: (issueNumber) => ports.ledger.readCommentHistory(issueNumber),
      },
      ports.project,
      { issueNumber: input.issueNumber, apply: input.apply },
    )
    report.projection.outcome = projection.projection.outcome
    if (projection.diagnostics.length > 0) {
      report.diagnostics.push('measurement-projection-failed')
    }
  } catch {
    report.projection.outcome = 'failed'
    report.diagnostics.push('measurement-projection-failed')
  }
}

function preMergeDiagnostics(
  input: ResolvedOrdinaryPullRequestMergeInput,
  pullRequest: OrdinaryMergePullRequest,
  planning: NormalizedPlanningRecord,
): OrdinaryPullRequestMergeDiagnostic[] {
  const diagnostics: OrdinaryPullRequestMergeDiagnostic[] = []
  const repository = planning.repository.toLowerCase()
  if (planning.issue.number !== input.issueNumber) {
    diagnostics.push('issue-identity-mismatch')
  }
  if (pullRequest.number !== input.pullRequestNumber) {
    diagnostics.push('pull-request-identity-mismatch')
  }
  if (pullRequest.repository.toLowerCase() !== repository) {
    diagnostics.push('repository-mismatch')
  }
  if (
    planning.issue.parent !== null ||
    planning.issue.kind.label === 'kind:epic' ||
    planning.issue.subIssues.length > 0
  ) {
    diagnostics.push('issue-not-ordinary')
  }
  if (planning.issue.kind.state !== 'valid') diagnostics.push('issue-kind-invalid')
  if (planning.project.membership !== 'present') {
    diagnostics.push('project-membership-invalid')
  }
  if (pullRequest.state === 'OPEN' && planning.issue.state !== 'OPEN') {
    diagnostics.push('issue-state-mismatch')
  }
  if (pullRequest.state === 'CLOSED') diagnostics.push('pull-request-closed-unmerged')
  if (pullRequest.baseRefName !== 'main') diagnostics.push('base-mismatch')
  if (pullRequest.headRepository?.toLowerCase() !== repository) {
    diagnostics.push('head-repository-mismatch')
  }
  if (pullRequest.headRefOid !== input.candidateOid) diagnostics.push('head-mismatch')
  if (!pullRequest.relationshipsComplete || pullRequest.closingIssues.length > 1) {
    diagnostics.push('relationship-ambiguous')
  } else if (pullRequest.closingIssues.length === 0) {
    diagnostics.push('relationship-mismatch')
  } else {
    const closing = pullRequest.closingIssues[0]!
    if (
      closing.repository.toLowerCase() !== repository ||
      closing.number !== input.issueNumber
    ) {
      diagnostics.push('relationship-mismatch')
    }
  }
  if (pullRequest.state !== 'OPEN') return dedupe(diagnostics)
  if (pullRequest.isDraft) diagnostics.push('pull-request-draft')
  if (!pullRequest.checksComplete) diagnostics.push('required-checks-ambiguous')
  if (pullRequest.requiredChecks.length === 0) diagnostics.push('required-checks-missing')
  if (pullRequest.requiredChecks.some((check) => check.outcome === 'pending')) {
    diagnostics.push('required-check-pending')
  }
  if (pullRequest.requiredChecks.some((check) => check.outcome === 'failure')) {
    diagnostics.push('required-check-failed')
  }
  if (pullRequest.mergeable === 'CONFLICTING') diagnostics.push('merge-conflict')
  if (pullRequest.mergeable === 'UNKNOWN') diagnostics.push('mergeability-unknown')
  if (pullRequest.mergeStateStatus !== 'CLEAN') {
    diagnostics.push('merge-state-unresolved')
  }
  if (
    pullRequest.reviewDecision !== null &&
    pullRequest.reviewDecision !== '' &&
    pullRequest.reviewDecision !== 'APPROVED'
  ) {
    diagnostics.push('review-unresolved')
  }
  return dedupe(diagnostics)
}

function initialReport(
  input: ResolvedOrdinaryPullRequestMergeInput,
  pullRequest: OrdinaryMergePullRequest,
  planning: NormalizedPlanningRecord,
): OrdinaryPullRequestMergeReport {
  return {
    issueNumber: input.issueNumber,
    pullRequestNumber: input.pullRequestNumber,
    candidateOid: input.candidateOid,
    apply: input.apply,
    outcome: 'blocked',
    pullRequest: {
      state: pullRequest.state,
      base: pullRequest.baseRefName,
      headBranch: pullRequest.headRefName,
      headOid: pullRequest.headRefOid,
      mergeCommitOid: pullRequest.mergeCommitOid,
      requiredChecks: pullRequest.requiredChecks,
    },
    issue: {
      state: planning.issue.state,
      projectStatus: planning.project.status,
    },
    merge: { outcome: 'not-attempted' },
    project: { outcome: 'deferred' },
    measurement: { outcome: 'deferred' },
    projection: { outcome: 'deferred' },
    diagnostics: [],
  }
}

function updateObservedState(
  report: OrdinaryPullRequestMergeReport,
  pullRequest: OrdinaryMergePullRequest,
  planning: NormalizedPlanningRecord,
): void {
  report.pullRequest.state = pullRequest.state
  report.pullRequest.base = pullRequest.baseRefName
  report.pullRequest.headBranch = pullRequest.headRefName
  report.pullRequest.headOid = pullRequest.headRefOid
  report.pullRequest.mergeCommitOid = pullRequest.mergeCommitOid
  report.pullRequest.requiredChecks = pullRequest.requiredChecks
  report.issue.state = planning.issue.state
  report.issue.projectStatus = planning.project.status
}

function isExactMergedCandidate(
  pullRequest: OrdinaryMergePullRequest,
  input: ResolvedOrdinaryPullRequestMergeInput,
): boolean {
  return (
    pullRequest.state === 'MERGED' &&
    pullRequest.headRefOid === input.candidateOid &&
    pullRequest.mergeCommitOid !== null &&
    FULL_SHA_PATTERN.test(pullRequest.mergeCommitOid)
  )
}

function requireInput(input: OrdinaryPullRequestMergeInput): void {
  if (!Number.isSafeInteger(input.pullRequestNumber) || input.pullRequestNumber <= 0) {
    throw new Error('Pull request number must be a positive integer.')
  }
}

function dedupe<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}
