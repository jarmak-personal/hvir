import {
  agentWorkLedgerProjectionDiagnostic,
  normalizeAgentWorkComments,
  requireAgentWorkIssueNumber,
  sumAgentWorkSafeIntegers,
  type AgentWorkLedgerProjectionDiagnostic,
  type NormalizedAgentWorkLedger,
} from './agent-work-ledger.ts'
import {
  agentWorkProjectWriteDiagnostic,
  type AgentWorkProjectValues,
  type AgentWorkProjectWriteDiagnostic,
} from './agent-work-project-fields.ts'

export interface AgentWorkRollupIssueReference {
  number: number
  repository: string
}

export interface AgentWorkRollupIssue extends AgentWorkRollupIssueReference {
  state: 'OPEN' | 'CLOSED'
  kind: 'epic' | 'other' | 'invalid'
  parent: AgentWorkRollupIssueReference | null
  directChildren: AgentWorkRollupIssueReference[]
}

export interface AgentWorkRollupSourcePort {
  readRollupIssue(issueNumber: number): Promise<AgentWorkRollupIssue>
  listCommentBodies(issueNumber: number): Promise<string[]>
}

export interface AgentWorkRollupProjectPort {
  readAgentWorkProjection(issueNumber: number): Promise<AgentWorkProjectValues>
  setAgentWorkProjectionField(
    issueNumber: number,
    field: 'Epic rollup tokens',
    value: number | undefined,
  ): Promise<void>
}

export type AgentWorkRollupDiagnostic =
  | 'target-kind-invalid'
  | 'child-kind-invalid'
  | 'nested-epic'
  | 'cross-repository-child'
  | 'child-relationship-invalid'
  | 'nested-descendants'
  | 'child-coordination-record'
  | AgentWorkLedgerProjectionDiagnostic
  | 'rollup-aggregate-overflow'
  | AgentWorkProjectWriteDiagnostic

export interface AgentWorkRollupParticipant {
  issueNumber: number
  role: 'epic' | 'direct-child'
  state: 'OPEN' | 'CLOSED'
  availability: 'complete' | 'partial' | 'unavailable'
  activeRuns: number
  knownTokenSubtotal?: number
  normalizedTokenTotal?: number
}

export interface AgentWorkRollupReport {
  issueNumber: number
  apply: boolean
  source: {
    eligibility: 'epic' | 'ordinary' | 'epic-child' | 'nested-epic' | 'invalid'
    directChildren: number[]
    participants: AgentWorkRollupParticipant[]
  }
  rollup: {
    availability: 'complete' | 'partial' | 'unavailable'
    contributingIssues: number
    knownTokenSubtotal?: number
    normalizedTokenTotal?: number
  }
  projection: {
    outcome: 'unchanged' | 'would-update' | 'updated' | 'failed'
    operation: 'none' | 'set' | 'clear' | 'preserve'
    value?: number
  }
  diagnostics: AgentWorkRollupDiagnostic[]
}

interface LoadedParticipant {
  issue: AgentWorkRollupIssue
  ledger: NormalizedAgentWorkLedger
}

export async function reconcileAgentWorkRollup(
  source: AgentWorkRollupSourcePort,
  project: AgentWorkRollupProjectPort,
  input: { issueNumber: number; apply: boolean },
): Promise<AgentWorkRollupReport> {
  const issueNumber = requireAgentWorkIssueNumber(input.issueNumber)
  const target = await source.readRollupIssue(issueNumber)
  const current = await project.readAgentWorkProjection(issueNumber)
  const currentValue = current['Epic rollup tokens']
  const eligibility = rollupEligibility(target)

  if (eligibility !== 'epic') {
    const diagnostics: AgentWorkRollupDiagnostic[] = []
    if (eligibility === 'invalid') diagnostics.push('target-kind-invalid')
    if (eligibility === 'nested-epic') diagnostics.push('nested-epic')
    return applyRollupProjection(
      project,
      {
        issueNumber,
        apply: input.apply,
        source: { eligibility, directChildren: [], participants: [] },
        rollup: { availability: 'unavailable', contributingIssues: 0 },
        projection: projectionPlan(
          currentValue,
          undefined,
          eligibility === 'invalid' || eligibility === 'nested-epic',
        ),
        diagnostics,
      },
      undefined,
    )
  }

  if (target.directChildren.some((child) => child.repository !== target.repository)) {
    return {
      issueNumber,
      apply: input.apply,
      source: {
        eligibility,
        directChildren: uniqueChildren(target.directChildren).map(
          (child) => child.number,
        ),
        participants: [],
      },
      rollup: { availability: 'unavailable', contributingIssues: 0 },
      projection: projectionPlan(currentValue, undefined, true),
      diagnostics: ['cross-repository-child'],
    }
  }

  const childReferences = uniqueChildren(target.directChildren)
  const children = await Promise.all(
    childReferences.map((child) => source.readRollupIssue(child.number)),
  )
  const relationshipDiagnostics = validateDirectChildren(
    target,
    childReferences,
    children,
  )
  if (relationshipDiagnostics.length > 0) {
    return {
      issueNumber,
      apply: input.apply,
      source: {
        eligibility,
        directChildren: childReferences.map((child) => child.number),
        participants: [],
      },
      rollup: { availability: 'unavailable', contributingIssues: 0 },
      projection: projectionPlan(currentValue, undefined, true),
      diagnostics: relationshipDiagnostics,
    }
  }

  const issues = [target, ...children]
  const ledgers = await Promise.all(
    issues.map(async (issue) =>
      normalizeAgentWorkComments(
        issue.number,
        await source.listCommentBodies(issue.number),
      ),
    ),
  )
  const loaded = issues.map((issue, index): LoadedParticipant => ({
    issue,
    ledger: ledgers[index]!,
  }))
  const derived = deriveAgentWorkRollup(loaded)
  const preserve = derived.diagnostics.some(isUnsafeDiagnostic)
  const desired = derived.rollup.normalizedTokenTotal
  const report: AgentWorkRollupReport = {
    issueNumber,
    apply: input.apply,
    source: {
      eligibility,
      directChildren: childReferences.map((child) => child.number),
      participants: derived.participants,
    },
    rollup: derived.rollup,
    projection: projectionPlan(currentValue, desired, preserve),
    diagnostics: derived.diagnostics,
  }
  return applyRollupProjection(project, report, desired)
}

function deriveAgentWorkRollup(participants: readonly LoadedParticipant[]): {
  participants: AgentWorkRollupParticipant[]
  rollup: AgentWorkRollupReport['rollup']
  diagnostics: AgentWorkRollupDiagnostic[]
} {
  if (participants.length === 0) {
    return {
      participants: [],
      rollup: { availability: 'unavailable', contributingIssues: 0 },
      diagnostics: [],
    }
  }
  const diagnostics: AgentWorkRollupDiagnostic[] = participants.flatMap(({ ledger }) =>
    ledger.diagnostics.map(agentWorkLedgerProjectionDiagnostic),
  )
  if (
    participants
      .slice(1)
      .some(({ ledger }) =>
        ledger.records.some(
          (record) =>
            record.activity === 'active' && record.phase === 'epic-coordination',
        ),
      )
  ) {
    diagnostics.push('child-coordination-record')
  }
  const normalized = participants.flatMap(({ ledger }) => {
    const value = ledger.ownTotal.normalizedTokenTotal
    return value === undefined ? [] : [value]
  })
  const known = participants.flatMap(({ ledger }) => {
    const value = ledger.ownTotal.knownTokenSubtotal
    return value === undefined ? [] : [value]
  })
  const normalizedTokenTotal = sumAgentWorkSafeIntegers(normalized)
  const knownTokenSubtotal = sumAgentWorkSafeIntegers(known)
  if (normalizedTokenTotal === undefined && normalized.length > 0) {
    diagnostics.push('rollup-aggregate-overflow')
  }
  if (knownTokenSubtotal === undefined && known.length > 0) {
    diagnostics.push('rollup-aggregate-overflow')
  }
  const everyComplete = participants.every(
    ({ ledger }) =>
      ledger.ownTotal.activeRuns > 0 &&
      ledger.ownTotal.availability === 'complete' &&
      ledger.ownTotal.normalizedTokenTotal !== undefined,
  )
  const availability =
    everyComplete && normalizedTokenTotal !== undefined
      ? ('complete' as const)
      : known.length === 0
        ? ('unavailable' as const)
        : ('partial' as const)

  return {
    participants: participants.map(({ issue, ledger }, index) => ({
      issueNumber: issue.number,
      role: index === 0 ? ('epic' as const) : ('direct-child' as const),
      state: issue.state,
      availability: ledger.ownTotal.availability,
      activeRuns: ledger.ownTotal.activeRuns,
      ...(ledger.ownTotal.knownTokenSubtotal === undefined
        ? {}
        : { knownTokenSubtotal: ledger.ownTotal.knownTokenSubtotal }),
      ...(ledger.ownTotal.normalizedTokenTotal === undefined
        ? {}
        : { normalizedTokenTotal: ledger.ownTotal.normalizedTokenTotal }),
    })),
    rollup: {
      availability,
      contributingIssues: participants.length,
      ...(knownTokenSubtotal === undefined || known.length === 0
        ? {}
        : { knownTokenSubtotal }),
      ...(availability !== 'complete' || normalizedTokenTotal === undefined
        ? {}
        : { normalizedTokenTotal }),
    },
    diagnostics: [...new Set(diagnostics)],
  }
}

function rollupEligibility(
  issue: AgentWorkRollupIssue,
): AgentWorkRollupReport['source']['eligibility'] {
  if (issue.kind === 'invalid') return 'invalid'
  if (issue.parent !== null) return issue.kind === 'epic' ? 'nested-epic' : 'epic-child'
  return issue.kind === 'epic' ? 'epic' : 'ordinary'
}

function uniqueChildren(
  children: readonly AgentWorkRollupIssueReference[],
): AgentWorkRollupIssueReference[] {
  return [...new Map(children.map((child) => [child.number, child])).values()].sort(
    (left, right) => left.number - right.number,
  )
}

function validateDirectChildren(
  target: AgentWorkRollupIssue,
  references: readonly AgentWorkRollupIssueReference[],
  children: readonly AgentWorkRollupIssue[],
): AgentWorkRollupDiagnostic[] {
  const diagnostics: AgentWorkRollupDiagnostic[] = []
  for (const [index, child] of children.entries()) {
    const reference = references[index]!
    if (
      child.number !== reference.number ||
      child.parent?.number !== target.number ||
      child.parent.repository !== target.repository
    ) {
      diagnostics.push('child-relationship-invalid')
    }
    if (child.kind === 'epic') diagnostics.push('nested-epic')
    if (child.kind === 'invalid') diagnostics.push('child-kind-invalid')
    if (child.directChildren.length > 0) diagnostics.push('nested-descendants')
  }
  return [...new Set(diagnostics)]
}

function projectionPlan(
  current: string | number | undefined,
  desired: number | undefined,
  preserve: boolean,
): AgentWorkRollupReport['projection'] {
  if (preserve) return { outcome: 'unchanged', operation: 'preserve' }
  if (current === desired) return { outcome: 'unchanged', operation: 'none' }
  return desired === undefined
    ? { outcome: 'would-update', operation: 'clear' }
    : { outcome: 'would-update', operation: 'set', value: desired }
}

async function applyRollupProjection(
  project: AgentWorkRollupProjectPort,
  report: AgentWorkRollupReport,
  desired: number | undefined,
): Promise<AgentWorkRollupReport> {
  if (
    !report.apply ||
    report.projection.outcome !== 'would-update' ||
    report.projection.operation === 'preserve'
  ) {
    return report
  }
  try {
    await project.setAgentWorkProjectionField(
      report.issueNumber,
      'Epic rollup tokens',
      desired,
    )
    report.projection.outcome = 'updated'
  } catch (error) {
    report.projection.outcome = 'failed'
    report.diagnostics.push(agentWorkProjectWriteDiagnostic(error))
  }
  return report
}

function isUnsafeDiagnostic(diagnostic: AgentWorkRollupDiagnostic): boolean {
  return diagnostic !== 'ledger-duplicate-record'
}
