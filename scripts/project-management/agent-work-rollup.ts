import {
  AGENT_WORK_PHASES,
  agentWorkLedgerProjectionDiagnostic,
  normalizeAgentWorkComments,
  requireAgentWorkIssueNumber,
  sumAgentWorkSafeIntegers,
  type AgentWorkAvailability,
  type AgentWorkCommentHistory,
  type AgentWorkLedgerProjectionDiagnostic,
  type AgentWorkPhase,
  type NormalizedAgentWorkLedger,
} from './agent-work-ledger.ts'
import {
  AGENT_WORK_ROLLUP_PROJECT_FIELDS,
  agentWorkMeasurementCoverageValue,
  agentWorkProjectField,
  agentWorkProjectWriteDiagnostic,
  type AgentWorkProjectFieldType,
  type AgentWorkProjectValue,
  type AgentWorkProjectValues,
  type AgentWorkProjectWriteDiagnostic,
  type AgentWorkRollupProjectFieldName,
} from './agent-work-project-fields.ts'

export interface AgentWorkRollupIssueReference {
  number: number
  repository: string
}

export interface AgentWorkRollupIssue extends AgentWorkRollupIssueReference {
  state: 'OPEN' | 'CLOSED'
  kind: 'epic' | 'other' | 'invalid'
  parent: AgentWorkRollupIssueReference | null
  hasDirectChildren: boolean
}

export interface AgentWorkRollupTargetIssue extends AgentWorkRollupIssue {
  directChildren: AgentWorkRollupIssueReference[]
}

export interface AgentWorkRollupSourcePort {
  readRollupTarget(issueNumber: number): Promise<AgentWorkRollupTargetIssue>
  readRollupParticipant(issueNumber: number): Promise<AgentWorkRollupIssue>
  readCommentHistory(issueNumber: number): Promise<AgentWorkCommentHistory>
}

export interface AgentWorkRollupProjectPort {
  readAgentWorkProjection(issueNumber: number): Promise<AgentWorkProjectValues>
  setAgentWorkProjectionField(
    issueNumber: number,
    field: AgentWorkRollupProjectFieldName,
    value: AgentWorkProjectValue | undefined,
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
  availability: AgentWorkAvailability
  activeRuns: number
  knownTokenSubtotal?: number
  normalizedTokenTotal?: number
}

export interface AgentWorkRollupTotal {
  availability: AgentWorkAvailability
  activeRuns: number
  knownTokenSubtotal?: number
  normalizedTokenTotal?: number
}

export interface AgentWorkRollupChange {
  field: AgentWorkRollupProjectFieldName
  type: AgentWorkProjectFieldType
  operation: 'set' | 'clear'
  value?: AgentWorkProjectValue
  outcome: 'would-update' | 'updated' | 'failed' | 'not-attempted'
}

export interface AgentWorkRollupReport {
  issueNumber: number
  apply: boolean
  source: {
    eligibility: 'epic' | 'ordinary' | 'epic-child' | 'nested-epic' | 'invalid'
    directChildren: number[]
    participants: AgentWorkRollupParticipant[]
  }
  rollup: AgentWorkRollupTotal & {
    contributingIssues: number
    phaseTotals: Array<{ phase: AgentWorkPhase; total: AgentWorkRollupTotal }>
  }
  projection: {
    outcome: 'unchanged' | 'would-update' | 'updated' | 'partial'
    changes: AgentWorkRollupChange[]
    values: AgentWorkProjectValues
    preservedFields: AgentWorkRollupProjectFieldName[]
  }
  diagnostics: AgentWorkRollupDiagnostic[]
}

interface LoadedParticipant {
  issue: AgentWorkRollupIssue
  ledger: NormalizedAgentWorkLedger
}

interface DerivedAgentWorkRollup {
  participants: AgentWorkRollupParticipant[]
  rollup: AgentWorkRollupReport['rollup']
  values: AgentWorkProjectValues
  diagnostics: AgentWorkRollupDiagnostic[]
}

export async function reconcileAgentWorkRollup(
  source: AgentWorkRollupSourcePort,
  project: AgentWorkRollupProjectPort,
  input: { issueNumber: number; apply: boolean },
): Promise<AgentWorkRollupReport> {
  const issueNumber = requireAgentWorkIssueNumber(input.issueNumber)
  const target = await source.readRollupTarget(issueNumber)
  const current = await project.readAgentWorkProjection(issueNumber)
  const eligibility = rollupEligibility(target)

  if (eligibility !== 'epic') {
    const diagnostics: AgentWorkRollupDiagnostic[] = []
    if (eligibility === 'invalid') diagnostics.push('target-kind-invalid')
    if (eligibility === 'nested-epic') diagnostics.push('nested-epic')
    return preservedReport(
      issueNumber,
      input.apply,
      eligibility,
      [],
      current,
      diagnostics,
    )
  }

  const childReferences = uniqueChildren(target.directChildren)
  if (target.directChildren.some((child) => child.repository !== target.repository)) {
    return preservedReport(
      issueNumber,
      input.apply,
      eligibility,
      childReferences.map((child) => child.number),
      current,
      ['cross-repository-child'],
    )
  }

  const children = await Promise.all(
    childReferences.map((child) => source.readRollupParticipant(child.number)),
  )
  const relationshipDiagnostics = validateDirectChildren(
    target,
    childReferences,
    children,
  )
  if (relationshipDiagnostics.length > 0) {
    return preservedReport(
      issueNumber,
      input.apply,
      eligibility,
      childReferences.map((child) => child.number),
      current,
      relationshipDiagnostics,
    )
  }

  const issues = [target, ...children]
  const ledgers = await Promise.all(
    issues.map(async (issue) =>
      normalizeAgentWorkComments(
        issue.number,
        await source.readCommentHistory(issue.number),
      ),
    ),
  )
  const loaded = issues.map((issue, index): LoadedParticipant => ({
    issue,
    ledger: ledgers[index]!,
  }))
  const derived = deriveAgentWorkRollup(loaded)
  const preserve = derived.diagnostics.some(isUnsafeDiagnostic)
  const preservedFields = preserve ? [...AGENT_WORK_ROLLUP_PROJECT_FIELDS] : []
  const changes = projectionChanges(current, derived.values, preservedFields)
  const report: AgentWorkRollupReport = {
    issueNumber,
    apply: input.apply,
    source: {
      eligibility,
      directChildren: childReferences.map((child) => child.number),
      participants: derived.participants,
    },
    rollup: derived.rollup,
    projection: {
      outcome: changes.length === 0 ? 'unchanged' : 'would-update',
      changes,
      values: preserve ? rollupProjectValues(current) : derived.values,
      preservedFields,
    },
    diagnostics: derived.diagnostics,
  }
  return applyRollupProjection(project, report)
}

function deriveAgentWorkRollup(
  participants: readonly LoadedParticipant[],
): DerivedAgentWorkRollup {
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

  const phaseTotals = AGENT_WORK_PHASES.map((phase) => ({
    phase,
    total: aggregatePhase(participants, phase, diagnostics),
  }))
  const normalized = participants.flatMap(({ ledger }) => {
    const value = ledger.ownTotal.normalizedTokenTotal
    return value === undefined ? [] : [value]
  })
  const known = participants.flatMap(({ ledger }) => {
    const value = ledger.ownTotal.knownTokenSubtotal
    return value === undefined ? [] : [value]
  })
  const normalizedTokenTotal = sumRollupValues(normalized, diagnostics)
  const knownTokenSubtotal = sumRollupValues(known, diagnostics)
  const activeRuns = sumParticipantRuns(participants, diagnostics)
  const everyComplete = participants.every(
    ({ ledger }) =>
      ledger.ownTotal.activeRuns > 0 &&
      ledger.ownTotal.availability === 'complete' &&
      ledger.ownTotal.normalizedTokenTotal !== undefined,
  )
  const availability = rollupAvailability(
    everyComplete && normalizedTokenTotal !== undefined,
    knownTokenSubtotal,
  )
  const rollup: AgentWorkRollupReport['rollup'] = {
    availability,
    activeRuns,
    contributingIssues: participants.length,
    phaseTotals,
    ...(knownTokenSubtotal === undefined ? {} : { knownTokenSubtotal }),
    ...(availability === 'complete' && normalizedTokenTotal !== undefined
      ? { normalizedTokenTotal }
      : {}),
  }
  const values: AgentWorkProjectValues = {
    'Measurement coverage': agentWorkMeasurementCoverageValue(availability),
  }
  setPhaseValue(values, 'Planning tokens', phaseTotals, 'issue-planning')
  setPhaseValue(values, 'Implementation tokens', phaseTotals, 'implementation')
  setPhaseValue(values, 'Review tokens', phaseTotals, 'implementation-review')
  if (knownTokenSubtotal !== undefined) values['Lifecycle tokens'] = knownTokenSubtotal

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
    rollup,
    values,
    diagnostics: [...new Set(diagnostics)],
  }
}

function aggregatePhase(
  participants: readonly LoadedParticipant[],
  phase: AgentWorkPhase,
  diagnostics: AgentWorkRollupDiagnostic[],
): AgentWorkRollupTotal {
  const totals = participants.map(({ ledger }) =>
    ledger.phaseTotals.find((candidate) => candidate.phase === phase)!,
  )
  const activeRuns = sumRollupValues(
    totals.map(({ total }) => total.activeRuns),
    diagnostics,
  )
  const completeRuns = sumRollupValues(
    totals.map(({ total }) => total.completeRuns),
    diagnostics,
  )
  const knownTokenSubtotal = sumRollupValues(
    totals.flatMap(({ total }) =>
      total.knownTokenSubtotal === undefined ? [] : [total.knownTokenSubtotal],
    ),
    diagnostics,
  )
  const normalizedTokenTotal = sumRollupValues(
    totals.flatMap(({ total }) =>
      total.normalizedTokenTotal === undefined ? [] : [total.normalizedTokenTotal],
    ),
    diagnostics,
  )
  const complete =
    activeRuns !== undefined &&
    activeRuns > 0 &&
    completeRuns === activeRuns &&
    normalizedTokenTotal !== undefined
  const availability = rollupAvailability(complete, knownTokenSubtotal)
  return {
    availability,
    activeRuns: activeRuns ?? 0,
    ...(knownTokenSubtotal === undefined ? {} : { knownTokenSubtotal }),
    ...(availability === 'complete' && normalizedTokenTotal !== undefined
      ? { normalizedTokenTotal }
      : {}),
  }
}

function sumParticipantRuns(
  participants: readonly LoadedParticipant[],
  diagnostics: AgentWorkRollupDiagnostic[],
): number {
  return (
    sumRollupValues(
      participants.map(({ ledger }) => ledger.ownTotal.activeRuns),
      diagnostics,
    ) ?? 0
  )
}

function sumRollupValues(
  values: readonly number[],
  diagnostics: AgentWorkRollupDiagnostic[],
): number | undefined {
  if (values.length === 0) return undefined
  const total = sumAgentWorkSafeIntegers(values)
  if (total === undefined) diagnostics.push('rollup-aggregate-overflow')
  return total
}

function rollupAvailability(
  complete: boolean,
  knownTokenSubtotal: number | undefined,
): AgentWorkAvailability {
  if (complete) return 'complete'
  return knownTokenSubtotal === undefined ? 'unavailable' : 'partial'
}

function setPhaseValue(
  values: AgentWorkProjectValues,
  field: AgentWorkRollupProjectFieldName,
  phaseTotals: AgentWorkRollupReport['rollup']['phaseTotals'],
  phase: AgentWorkPhase,
): void {
  const subtotal = phaseTotals.find((candidate) => candidate.phase === phase)?.total
    .knownTokenSubtotal
  if (subtotal !== undefined) values[field] = subtotal
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
    if (child.hasDirectChildren) diagnostics.push('nested-descendants')
  }
  return [...new Set(diagnostics)]
}

function preservedReport(
  issueNumber: number,
  apply: boolean,
  eligibility: AgentWorkRollupReport['source']['eligibility'],
  directChildren: number[],
  current: AgentWorkProjectValues,
  diagnostics: AgentWorkRollupDiagnostic[],
): AgentWorkRollupReport {
  const values = rollupProjectValues(current)
  return {
    issueNumber,
    apply,
    source: { eligibility, directChildren, participants: [] },
    rollup: {
      availability: 'unavailable',
      activeRuns: 0,
      contributingIssues: 0,
      phaseTotals: emptyPhaseTotals(),
    },
    projection: {
      outcome: 'unchanged',
      changes: [],
      values,
      preservedFields: [...AGENT_WORK_ROLLUP_PROJECT_FIELDS],
    },
    diagnostics,
  }
}

function emptyPhaseTotals(): AgentWorkRollupReport['rollup']['phaseTotals'] {
  return AGENT_WORK_PHASES.map((phase) => ({
    phase,
    total: { availability: 'unavailable', activeRuns: 0 },
  }))
}

function rollupProjectValues(current: AgentWorkProjectValues): AgentWorkProjectValues {
  return Object.fromEntries(
    AGENT_WORK_ROLLUP_PROJECT_FIELDS.flatMap((field) =>
      current[field] === undefined ? [] : [[field, current[field]]],
    ),
  )
}

function projectionChanges(
  current: AgentWorkProjectValues,
  desired: AgentWorkProjectValues,
  preservedFields: readonly AgentWorkRollupProjectFieldName[],
): AgentWorkRollupChange[] {
  const preserved = new Set(preservedFields)
  return AGENT_WORK_ROLLUP_PROJECT_FIELDS.flatMap((field) => {
    if (preserved.has(field)) return []
    const before = current[field]
    const after = desired[field]
    if (before === after) return []
    return [
      {
        field,
        type: agentWorkProjectField(field).type,
        operation: after === undefined ? ('clear' as const) : ('set' as const),
        ...(after === undefined ? {} : { value: after }),
        outcome: 'would-update' as const,
      },
    ]
  })
}

async function applyRollupProjection(
  project: AgentWorkRollupProjectPort,
  report: AgentWorkRollupReport,
): Promise<AgentWorkRollupReport> {
  if (!report.apply || report.projection.changes.length === 0) return report
  for (const [index, change] of report.projection.changes.entries()) {
    try {
      await project.setAgentWorkProjectionField(
        report.issueNumber,
        change.field,
        change.value,
      )
      change.outcome = 'updated'
    } catch (error) {
      change.outcome = 'failed'
      for (const remaining of report.projection.changes.slice(index + 1)) {
        remaining.outcome = 'not-attempted'
      }
      report.projection.outcome = 'partial'
      report.diagnostics.push(agentWorkProjectWriteDiagnostic(error))
      return report
    }
  }
  report.projection.outcome = 'updated'
  return report
}

function isUnsafeDiagnostic(diagnostic: AgentWorkRollupDiagnostic): boolean {
  return diagnostic !== 'ledger-duplicate-record'
}
