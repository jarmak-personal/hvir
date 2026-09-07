import type { PlanningIssueSnapshot } from './issue-planning.ts'
import type { NormalizedPlanningRecord } from './planning-record.ts'
import {
  parseCompletingChildTrailer,
  type PullRequestSnapshot,
} from './pull-request-relationships.ts'
import {
  TOKEN_SCOPE,
  totalTokenReceipts,
  type TokenReceiptPort,
} from './session-token-receipts.ts'

export interface PullRequestStatus {
  number: number
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  base: string
  head: string
  draft: boolean
  mergeRequest: boolean
  review: string
  mergeability: string
  checks: { name: string; bucket: 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel' }[]
  checksAvailable: boolean
  stale: boolean
}

export interface ContributorStatusPorts {
  issue: (number: number) => Promise<PlanningIssueSnapshot>
  project: (number: number) => Promise<NormalizedPlanningRecord['project']>
  pullRequest: (number: number) => Promise<PullRequestStatus>
  relatedPullRequest?: (issue: number, pr: number) => Promise<'final' | 'child' | null>
  tokens: TokenReceiptPort
}

export interface TokenSummary {
  tokens: number | null
  sessions: number
  participants: number[]
  legacy: boolean
  scope: string
  diagnostics: string[]
}

/** Exact native relationships and the owned child trailer, never prose/status inference. */
export function contributorPullRequestRelationship(
  issue: PlanningIssueSnapshot,
  pr: PullRequestSnapshot,
  parent?: PlanningIssueSnapshot,
  epicBranches: string[] = [],
): 'final' | 'child' | null {
  if (pr.repository !== issue.repository) return null
  if (pr.baseRefName === 'main')
    return pr.closingIssues.length === 1 &&
      pr.closingIssues[0]?.number === issue.number &&
      pr.closingIssues[0].repository === issue.repository
      ? 'final'
      : null
  if (!issue.parent || !parent) return null
  const completing = parseCompletingChildTrailer(pr.body, pr.number)
  return completing.issueNumber === issue.number &&
    parent.number === issue.parent.number &&
    parent.repository === issue.repository &&
    parent.labels.includes('kind:epic') &&
    parent.parent === null &&
    issue.parent.repository === issue.repository &&
    epicBranches.length === 1 &&
    epicBranches[0] === pr.baseRefName
    ? 'child'
    : null
}

export async function readIssueTokenSummary(
  ports: Pick<ContributorStatusPorts, 'issue' | 'tokens'>,
  number: number,
): Promise<TokenSummary> {
  const issue = await ports.issue(number)
  const participants = [issue]
  const coverage: string[] = []
  if (issue.labels.includes('kind:epic')) {
    if (issue.parent) throw new Error('Nested epic token aggregation is unsupported.')
    for (const child of issue.subIssues) {
      if (child.repository !== issue.repository)
        throw new Error('Cross-repository token relationship.')
      let detail: PlanningIssueSnapshot
      try {
        detail = await ports.issue(child.number)
      } catch {
        coverage.push(`child-evidence-unavailable:#${child.number}`)
        continue
      }
      if (
        detail.parent?.number !== issue.number ||
        detail.parent.repository !== issue.repository ||
        detail.subIssues.length ||
        detail.labels.includes('kind:epic')
      ) {
        coverage.push(`child-relationship-unproven:#${child.number}`)
        continue
      }
      participants.push(detail)
    }
  }
  const histories = await Promise.all(
    participants.map(async (row) => {
      try {
        return await ports.tokens.read(row.number)
      } catch {
        coverage.push(`token-history-unavailable:#${row.number}`)
        return { receipts: [], legacy: false, diagnostics: [] }
      }
    }),
  )
  const total = totalTokenReceipts(histories.flatMap((history) => history.receipts))
  const diagnostics = [
    ...new Set([
      ...total.diagnostics,
      ...coverage,
      ...histories.flatMap((history) => history.diagnostics),
    ]),
  ]
  return {
    ...total,
    tokens: total.tokens,
    participants: participants.map((row) => row.number),
    legacy: histories.some((history) => history.legacy),
    scope: TOKEN_SCOPE,
    diagnostics,
  }
}

export interface ContributorStatusReport {
  issue: number
  parent: number | null
  tokens: TokenSummary | null
  project: NormalizedPlanningRecord['project'] | null
  issueState: 'OPEN' | 'CLOSED' | null
  pullRequest: PullRequestStatus | null
  approval: 'unknown'
  acceptance:
    'pending' | 'merged-to-main' | 'integrated-child' | 'closed-unmerged' | 'unknown'
  diagnostics: string[]
  capture?: string
}

export async function readContributorStatus(
  ports: ContributorStatusPorts,
  number: number,
  selectedPr?: number,
): Promise<ContributorStatusReport> {
  const report: ContributorStatusReport = {
    issue: number,
    parent: null,
    tokens: null,
    project: null,
    issueState: null,
    pullRequest: null,
    approval: 'unknown',
    acceptance: 'unknown',
    diagnostics: [],
  }
  const [issue, project, tokens] = await Promise.allSettled([
    ports.issue(number),
    ports.project(number),
    readIssueTokenSummary(ports, number),
  ])
  if (project.status === 'fulfilled') report.project = project.value
  else report.diagnostics.push('project-unavailable')
  if (tokens.status === 'fulfilled') {
    report.tokens = tokens.value
    report.diagnostics.push(...tokens.value.diagnostics)
  } else report.diagnostics.push('tokens-unavailable')
  if (issue.status === 'rejected') {
    report.diagnostics.push('issue-unavailable')
    return report
  }
  report.parent = issue.value.parent?.number ?? null
  report.issueState = issue.value.state
  const links = issue.value.linkedPullRequests.filter(
    (pr) => pr.repository === issue.value.repository,
  )
  // An explicit selector is readable, but only a proven relationship supplies issue acceptance.
  const matches =
    selectedPr === undefined ? links : links.filter((pr) => pr.number === selectedPr)
  if (selectedPr !== undefined && matches.length === 0) {
    matches.push({
      number: selectedPr,
      repository: issue.value.repository,
      state: 'OPEN',
      mergedAt: null,
      relationship: 'linked',
    })
  }
  if (matches.length !== 1) {
    report.diagnostics.push(
      matches.length ? 'pull-request-ambiguous' : 'pull-request-unavailable',
    )
    return report
  }
  try {
    const pr = await ports.pullRequest(matches[0]!.number)
    report.pullRequest = pr
    const relation = ports.relatedPullRequest
      ? await ports.relatedPullRequest(number, pr.number)
      : matches[0]!.relationship === 'closing' && pr.base === 'main'
        ? 'final'
        : null
    if (!relation) report.diagnostics.push('pull-request-relationship-unproven')
    else
      report.acceptance =
        pr.state === 'MERGED'
          ? relation === 'final'
            ? 'merged-to-main'
            : 'integrated-child'
          : pr.state === 'CLOSED'
            ? 'closed-unmerged'
            : 'pending'
    if (pr.stale) report.diagnostics.push('pull-request-evidence-stale')
    if (!pr.checksAvailable) report.diagnostics.push('required-checks-unavailable')
  } catch {
    report.diagnostics.push('pull-request-unavailable')
  }
  return report
}

export function formatContributorStatus(report: ContributorStatusReport): string {
  const tokens = report.tokens
  const pr = report.pullRequest
  const tokenLine =
    tokens?.tokens === null || !tokens
      ? 'unavailable'
      : `${tokens.tokens.toLocaleString('en-US')} observed; ${tokens.sessions} session(s)`
  const project = report.project
  const checkSummary = !pr?.checksAvailable
    ? 'unavailable'
    : pr.stale
      ? 'stale'
      : ['pass', 'fail', 'pending', 'skipping', 'cancel']
          .map(
            (bucket) =>
              `${pr.checks.filter((check) => check.bucket === bucket).length} ${bucket}`,
          )
          .join(', ')
  const lines = [
    `Tokens: ${tokenLine}. ${TOKEN_SCOPE}.`,
    `Project: #${report.issue} ${report.issueState ?? 'unknown'}; ${project?.membership ?? 'unavailable'} / ${project?.status ?? 'unknown'}${report.parent ? `; parent #${report.parent}` : ''}${pr ? `; PR #${pr.number} ${pr.state}${pr.draft ? ' draft' : ''}` : ''}.`,
    `Acceptance: ${report.acceptance}; approval unknown; observed required checks ${checkSummary}${pr ? `; merge request ${pr.mergeRequest ? 'enabled' : 'not enabled'}; review ${pr.review}` : ''}.`,
  ]
  if (report.capture) lines.push(`Capture: ${report.capture}.`)
  if (report.diagnostics.length)
    lines.push(`Exceptions: ${[...new Set(report.diagnostics)].join(', ')}.`)
  return `${lines.join('\n')}\n`
}
