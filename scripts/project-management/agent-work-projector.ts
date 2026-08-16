import {
  AGENT_WORK_PROJECT_FIELDS,
  AgentWorkProjectWriteError,
  type AgentWorkProjectFieldName,
  type AgentWorkProjectFieldType,
  type AgentWorkProjectValue,
  type AgentWorkProjectValues,
} from './agent-work-project-fields.ts'
import {
  normalizeAgentWorkComments,
  type AgentWorkLedgerDiagnostic,
  type AgentWorkPhase,
  type AgentWorkRecord,
  type NormalizedAgentWorkLedger,
} from './agent-work-ledger.ts'

const INITIAL_FORECAST_HEADING = '## Initial forecast'
const FORECAST_REVISION_HEADING = '## Pre-implementation forecast revision'
const MAX_MODEL_ROUTE_LENGTH = 1_024
const FORECAST_FIELDS: readonly AgentWorkProjectFieldName[] = [
  'Agent difficulty',
  'Risk',
  'Estimate confidence',
]
const LEDGER_FIELDS: readonly AgentWorkProjectFieldName[] = [
  'Initial model',
  'Reasoning effort',
  'Model route',
  'Planning tokens',
  'Implementation tokens',
  'Review tokens',
  'Own lifecycle tokens',
  'Time to first candidate (ms)',
  'First-pass outcome',
]

export type AgentWorkProjectionDiagnostic =
  | 'invalid-forecast'
  | 'model-route-too-large'
  | 'ledger-invalid-record'
  | 'ledger-duplicate-record'
  | 'ledger-idempotency-conflict'
  | 'ledger-invalid-supersession'
  | 'ledger-aggregate-overflow'
  | 'project-write-permission-denied'
  | 'project-write-schema-invalid'
  | 'project-write-transport-failed'
  | 'project-write-failed'

export interface AgentWorkProjectionSourcePort {
  readIssueBody(issueNumber: number): Promise<string>
  listCommentBodies(issueNumber: number): Promise<string[]>
}

export interface AgentWorkProjectPort {
  readAgentWorkProjection(issueNumber: number): Promise<AgentWorkProjectValues>
  setAgentWorkProjectionField(
    issueNumber: number,
    field: AgentWorkProjectFieldName,
    value: AgentWorkProjectValue | undefined,
  ): Promise<void>
}

export interface AgentWorkProjectionChange {
  field: AgentWorkProjectFieldName
  type: AgentWorkProjectFieldType
  operation: 'set' | 'clear'
  value?: AgentWorkProjectValue
  outcome: 'would-update' | 'updated' | 'failed' | 'not-attempted'
}

export interface AgentWorkProjectionReport {
  issueNumber: number
  apply: boolean
  source: {
    forecast: 'available' | 'unavailable' | 'invalid'
    activeRecords: number
  }
  projection: {
    outcome: 'unchanged' | 'would-update' | 'updated' | 'partial'
    changes: AgentWorkProjectionChange[]
    values: AgentWorkProjectValues
    preservedFields: AgentWorkProjectFieldName[]
  }
  diagnostics: AgentWorkProjectionDiagnostic[]
}

export async function reconcileAgentWorkProjection(
  source: AgentWorkProjectionSourcePort,
  project: AgentWorkProjectPort,
  input: { issueNumber: number; apply: boolean },
): Promise<AgentWorkProjectionReport> {
  const issueNumber = requirePositiveInteger(input.issueNumber)
  const [body, commentBodies, current] = await Promise.all([
    source.readIssueBody(issueNumber),
    source.listCommentBodies(issueNumber),
    project.readAgentWorkProjection(issueNumber),
  ])
  const ledger = normalizeAgentWorkComments(issueNumber, commentBodies)
  const derived = deriveAgentWorkProjection(body, ledger)
  const changes = projectionChanges(current, derived.values, derived.preservedFields)
  const report: AgentWorkProjectionReport = {
    issueNumber,
    apply: input.apply,
    source: {
      forecast: derived.forecast,
      activeRecords: ledger.records.filter((record) => record.activity === 'active')
        .length,
    },
    projection: {
      outcome: changes.length === 0 ? 'unchanged' : 'would-update',
      changes,
      values: derived.values,
      preservedFields: derived.preservedFields,
    },
    diagnostics: derived.diagnostics,
  }
  if (!input.apply || changes.length === 0) return report

  for (const [index, change] of changes.entries()) {
    try {
      await project.setAgentWorkProjectionField(issueNumber, change.field, change.value)
      change.outcome = 'updated'
    } catch (error) {
      change.outcome = 'failed'
      for (const remaining of changes.slice(index + 1)) {
        remaining.outcome = 'not-attempted'
      }
      report.projection.outcome = 'partial'
      report.diagnostics.push(projectWriteDiagnostic(error))
      return report
    }
  }
  report.projection.outcome = 'updated'
  return report
}

export function deriveAgentWorkProjection(
  issueBody: string,
  ledger: NormalizedAgentWorkLedger,
): {
  forecast: AgentWorkProjectionReport['source']['forecast']
  values: AgentWorkProjectValues
  diagnostics: AgentWorkProjectionReport['diagnostics']
  preservedFields: AgentWorkProjectFieldName[]
} {
  const forecast = parseInitialForecast(issueBody)
  const diagnostics: AgentWorkProjectionReport['diagnostics'] = []
  const preservedFields = new Set<AgentWorkProjectFieldName>()
  if (forecast.kind === 'invalid') {
    diagnostics.push('invalid-forecast')
    for (const field of FORECAST_FIELDS) preservedFields.add(field)
  }
  const values: AgentWorkProjectValues =
    forecast.kind === 'available'
      ? {
          'Agent difficulty': forecast.difficulty,
          Risk: forecast.risk,
          'Estimate confidence': forecast.confidence,
        }
      : {}
  const activeRecords = ledger.records.filter((record) => record.activity === 'active')
  const deliveryRouteRecords = activeRecords.filter(
    (record) => record.phase !== 'implementation-review',
  )
  const firstRoute = deliveryRouteRecords.find(
    (record) => record.route !== undefined,
  )?.route
  if (firstRoute?.initial.modelId !== undefined) {
    values['Initial model'] = firstRoute.initial.modelId
  }
  const effort =
    firstRoute?.initial.effectiveReasoningEffort ??
    firstRoute?.initial.requestedReasoningEffort
  if (effort !== undefined) values['Reasoning effort'] = effort
  const modelRoute = projectModelRoute(deliveryRouteRecords)
  if (modelRoute.length > MAX_MODEL_ROUTE_LENGTH) {
    diagnostics.push('model-route-too-large')
    preservedFields.add('Model route')
  } else if (modelRoute !== '') {
    values['Model route'] = modelRoute
  }

  setExactTotal(values, 'Planning tokens', ledger, 'issue-planning')
  setExactTotal(values, 'Implementation tokens', ledger, 'implementation')
  setExactTotal(values, 'Review tokens', ledger, 'implementation-review')
  if (
    ledger.ownTotal.activeRuns > 0 &&
    ledger.ownTotal.normalizedTokenTotal !== undefined
  ) {
    values['Own lifecycle tokens'] = ledger.ownTotal.normalizedTokenTotal
  }
  const firstCandidate = activeRecords.find(
    (record) =>
      record.phase === 'implementation' &&
      record.timing?.timeToFirstCandidateMilliseconds !== undefined,
  )
  if (firstCandidate?.timing?.timeToFirstCandidateMilliseconds !== undefined) {
    values['Time to first candidate (ms)'] =
      firstCandidate.timing.timeToFirstCandidateMilliseconds
  }
  const firstPass = projectFirstPass(activeRecords)
  if (firstPass !== undefined) values['First-pass outcome'] = firstPass

  diagnostics.push(...ledgerProjectionDiagnostics(ledger.diagnostics))
  if (ledgerHasUnsafeProjectionEvidence(ledger.diagnostics)) {
    for (const field of LEDGER_FIELDS) {
      delete values[field]
      preservedFields.add(field)
    }
  }

  return {
    forecast:
      forecast.kind === 'available'
        ? 'available'
        : forecast.kind === 'invalid'
          ? 'invalid'
          : 'unavailable',
    values,
    diagnostics,
    preservedFields: [...preservedFields],
  }
}

function parseInitialForecast(body: string):
  | { kind: 'unavailable' }
  | { kind: 'invalid' }
  | {
      kind: 'available'
      difficulty: number
      risk: 'Low' | 'Moderate' | 'High' | 'Critical'
      confidence: 'Low' | 'Medium' | 'High'
    } {
  const sections = body.split(/^## /m)
  const initial = sections.filter((section) =>
    section.startsWith(INITIAL_FORECAST_HEADING.slice(3)),
  )
  const revisions = sections.filter((section) =>
    section.startsWith(FORECAST_REVISION_HEADING.slice(3)),
  )
  if (initial.length === 0 && revisions.length === 0) return { kind: 'unavailable' }
  if (initial.length !== 1) return { kind: 'invalid' }
  let forecast: { difficulty: number; risk: string; confidence: string } | undefined
  for (const section of [...initial, ...revisions]) {
    forecast = parseForecastSection(section)
    if (forecast === undefined) return { kind: 'invalid' }
  }
  if (forecast === undefined) return { kind: 'invalid' }
  return {
    kind: 'available',
    difficulty: forecast.difficulty,
    risk: forecast.risk as 'Low' | 'Moderate' | 'High' | 'Critical',
    confidence: forecast.confidence as 'Low' | 'Medium' | 'High',
  }
}

function parseForecastSection(
  section: string,
): { difficulty: number; risk: string; confidence: string } | undefined {
  const difficulty = exactCapture(section, /^- Agent difficulty: ([1-5])\/5$/m)
  const novelty = exactCapture(section, /^- Reasoning novelty: ([0-2])\/2$/m)
  const breadth = exactCapture(section, /^- Ownership breadth: ([0-2])\/2$/m)
  const lifecycle = exactCapture(
    section,
    /^- Lifecycle\/integration burden: ([0-2])\/2$/m,
  )
  const validation = exactCapture(section, /^- Validation burden: ([0-2])\/2$/m)
  const risk = exactCapture(section, /^- Risk: (Low|Moderate|High|Critical)$/m)
  const confidence = exactCapture(section, /^- Estimate confidence: (Low|Medium|High)$/m)
  if (
    difficulty === undefined ||
    novelty === undefined ||
    breadth === undefined ||
    lifecycle === undefined ||
    validation === undefined ||
    risk === undefined ||
    confidence === undefined
  ) {
    return undefined
  }
  const factorSum =
    Number(novelty) + Number(breadth) + Number(lifecycle) + Number(validation)
  const expectedDifficulty =
    factorSum <= 1 ? 1 : factorSum <= 3 ? 2 : factorSum <= 5 ? 3 : factorSum <= 7 ? 4 : 5
  if (Number(difficulty) !== expectedDifficulty) return undefined
  return {
    difficulty: Number(difficulty),
    risk,
    confidence,
  }
}

function exactCapture(value: string, pattern: RegExp): string | undefined {
  const matches = [...value.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))]
  return matches.length === 1 ? matches[0]![1] : undefined
}

function projectModelRoute(records: readonly AgentWorkRecord[]): string {
  return records
    .flatMap((record) => {
      if (record.route === undefined) return []
      const initial = routeLabel(
        record.route.initial.harness,
        record.route.initial.modelId,
        record.route.initial.effectiveReasoningEffort ??
          record.route.initial.requestedReasoningEffort,
      )
      const steps = record.route.changes.map(
        (change) =>
          `${change.escalation ? 'escalated' : 'changed'}:${routeLabel(undefined, change.modelId, change.effectiveReasoningEffort ?? change.requestedReasoningEffort)}`,
      )
      return [[initial, ...steps].join(' -> ')]
    })
    .join(' | ')
}

function routeLabel(
  harness: string | undefined,
  model: string | undefined,
  effort: string | undefined,
): string {
  const identity = [harness, model].filter((value) => value !== undefined).join(':')
  return effort === undefined ? identity : `${identity}@${effort}`
}

function setExactTotal(
  values: AgentWorkProjectValues,
  field: AgentWorkProjectFieldName,
  ledger: NormalizedAgentWorkLedger,
  phase: AgentWorkPhase,
): void {
  const total = ledger.phaseTotals.find((candidate) => candidate.phase === phase)?.total
  if (
    total !== undefined &&
    total.activeRuns > 0 &&
    total.normalizedTokenTotal !== undefined
  ) {
    values[field] = total.normalizedTokenTotal
  }
}

function projectFirstPass(
  records: readonly AgentWorkRecord[],
): 'Pending' | 'Accepted' | 'Rework required' | 'No candidate' | undefined {
  const outcomes = records
    .filter((record) => record.phase === 'implementation')
    .flatMap((record) => (record.outcome === undefined ? [] : [record.outcome.firstPass]))
  if (outcomes.includes('rework-required')) return 'Rework required'
  if (outcomes.includes('accepted')) return 'Accepted'
  if (outcomes.includes('pending')) return 'Pending'
  if (outcomes.includes('no-candidate')) return 'No candidate'
  return undefined
}

function projectionChanges(
  current: AgentWorkProjectValues,
  desired: AgentWorkProjectValues,
  preservedFields: readonly AgentWorkProjectFieldName[],
): AgentWorkProjectionChange[] {
  const preserved = new Set(preservedFields)
  return AGENT_WORK_PROJECT_FIELDS.flatMap((field) => {
    if (field.name === 'Epic rollup tokens' || preserved.has(field.name)) return []
    const before = current[field.name]
    const after = desired[field.name]
    if (before === after) return []
    return [
      {
        field: field.name,
        type: field.type,
        operation: after === undefined ? ('clear' as const) : ('set' as const),
        ...(after === undefined ? {} : { value: after }),
        outcome: 'would-update' as const,
      },
    ]
  })
}

function ledgerProjectionDiagnostics(
  diagnostics: readonly AgentWorkLedgerDiagnostic[],
): AgentWorkProjectionDiagnostic[] {
  const projected = diagnostics.map((diagnostic): AgentWorkProjectionDiagnostic => {
    switch (diagnostic.code) {
      case 'invalid-record':
        return 'ledger-invalid-record'
      case 'duplicate-record':
        return 'ledger-duplicate-record'
      case 'idempotency-conflict':
        return 'ledger-idempotency-conflict'
      case 'invalid-supersession':
        return 'ledger-invalid-supersession'
      case 'aggregate-overflow':
        return 'ledger-aggregate-overflow'
    }
  })
  return [...new Set(projected)]
}

function ledgerHasUnsafeProjectionEvidence(
  diagnostics: readonly AgentWorkLedgerDiagnostic[],
): boolean {
  return diagnostics.some((diagnostic) => diagnostic.code !== 'duplicate-record')
}

function projectWriteDiagnostic(error: unknown): AgentWorkProjectionDiagnostic {
  if (!(error instanceof AgentWorkProjectWriteError)) return 'project-write-failed'
  switch (error.failure) {
    case 'permission':
      return 'project-write-permission-denied'
    case 'schema':
      return 'project-write-schema-invalid'
    case 'transport':
      return 'project-write-transport-failed'
    case 'generic':
      return 'project-write-failed'
  }
}

function requirePositiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Agent-work issue number must be a positive integer.')
  }
  return value
}
