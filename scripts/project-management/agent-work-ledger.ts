import {
  AGENT_WORK_ADDITIVE_TOKEN_COUNTER_NAMES,
  AGENT_WORK_TOKEN_COUNTER_NAMES,
  AGENT_WORK_UNAVAILABLE_REASONS,
  type AgentWorkTokenCounterName,
  type AgentWorkUnavailableReason,
} from '../../src/shared/agent-work-measurement.ts'

export const AGENT_WORK_COMMENT_MARKER = '<!-- hvir-agent-work-measurement:v1 -->'
export const AGENT_WORK_SCHEMA = 1

const MAX_COMMENT_BYTES = 32 * 1024
const MAX_ROUTE_CHANGES = 32
const KEY_PATTERN = /^[a-f0-9]{64}$/
const ROUTE_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/
const EFFORT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const CANDIDATE_PATTERN = /^[a-f0-9]{7,64}$/

export const AGENT_WORK_PHASES = [
  'issue-planning',
  'implementation',
  'implementation-review',
  'epic-coordination',
] as const
export type AgentWorkPhase = (typeof AGENT_WORK_PHASES)[number]

export const AGENT_WORK_AVAILABILITY = ['complete', 'partial', 'unavailable'] as const
export type AgentWorkAvailability = (typeof AGENT_WORK_AVAILABILITY)[number]

const HARNESSES = ['claude-code', 'codex'] as const
export type AgentWorkHarness = (typeof HARNESSES)[number]

export const AGENT_WORK_COUNTERS = AGENT_WORK_TOKEN_COUNTER_NAMES
export type AgentWorkCounter = AgentWorkTokenCounterName

export const AGENT_WORK_MISSING_FACTS = [
  'start-snapshot',
  'end-snapshot',
  'fresh-input-tokens',
  'cache-read-input-tokens',
  'cache-write-input-tokens',
  'output-tokens',
  'reasoning-tokens',
  'active-wall-time',
  'model-or-api-time',
  'model',
  'reasoning-effort',
] as const
export type AgentWorkMissingFact = (typeof AGENT_WORK_MISSING_FACTS)[number]

export { AGENT_WORK_UNAVAILABLE_REASONS }
export type { AgentWorkUnavailableReason }

export const FIRST_PASS_OUTCOMES = [
  'pending',
  'accepted',
  'rework-required',
  'no-candidate',
] as const
export type FirstPassOutcome = (typeof FIRST_PASS_OUTCOMES)[number]

export interface AgentWorkRouteStep {
  modelId?: string
  requestedReasoningEffort?: string
  effectiveReasoningEffort?: string
}

export interface AgentWorkRoute {
  initial: AgentWorkRouteStep & { harness: AgentWorkHarness }
  changes: Array<AgentWorkRouteStep & { sequence: number; escalation: boolean }>
}

export interface AgentWorkUsage {
  freshInputTokens?: number
  cacheReadInputTokens?: number
  cacheWriteInputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  normalizedTokenTotal?: number
}

export interface AgentWorkTiming {
  activeWallMilliseconds?: number
  modelOrApiMilliseconds?: number
  timeToFirstCandidateMilliseconds?: number
}

export interface AgentWorkOutcome {
  firstPass: FirstPassOutcome
  candidateRef?: string
}

export interface AgentWorkRecord {
  schema: 1
  issueNumber: number
  phase: AgentWorkPhase
  runKey: string
  idempotencyKey: string
  availability: AgentWorkAvailability
  route?: AgentWorkRoute
  usage?: AgentWorkUsage
  timing?: AgentWorkTiming
  missingFacts?: AgentWorkMissingFact[]
  unavailableReason?: AgentWorkUnavailableReason
  outcome?: AgentWorkOutcome
  supersedes?: string
}

export type AgentWorkLedgerDiagnostic =
  | {
      code:
        | 'invalid-record'
        | 'duplicate-record'
        | 'idempotency-conflict'
        | 'invalid-supersession'
      commentOrdinal: number
    }
  | { code: 'aggregate-overflow'; field: AgentWorkAggregateField }

export type AgentWorkAggregateField =
  | AgentWorkCounter
  | 'knownTokenSubtotal'
  | 'normalizedTokenTotal'
  | 'activeWallMilliseconds'
  | 'modelOrApiMilliseconds'

export interface NormalizedAgentWorkRecord extends AgentWorkRecord {
  commentOrdinal: number
  activity: 'active' | 'superseded'
  supersededBy?: string
}

interface AggregateValue {
  value: number
  observedRuns: number
}

export interface AgentWorkAggregate {
  availability: AgentWorkAvailability
  activeRuns: number
  completeRuns: number
  partialRuns: number
  unavailableRuns: number
  counters: Partial<Record<AgentWorkCounter, AggregateValue>>
  knownTokenSubtotal?: number
  normalizedTokenTotal?: number
  timing: {
    activeWallMilliseconds?: AggregateValue
    modelOrApiMilliseconds?: AggregateValue
  }
}

export interface NormalizedAgentWorkLedger {
  issueNumber: number
  records: NormalizedAgentWorkRecord[]
  phaseTotals: Array<{ phase: AgentWorkPhase; total: AgentWorkAggregate }>
  ownTotal: AgentWorkAggregate
  diagnostics: AgentWorkLedgerDiagnostic[]
  unrelatedComments: number
}

export interface AgentWorkLedgerPort {
  listCommentBodies(issueNumber: number): Promise<string[]>
  appendComment(issueNumber: number, body: string): Promise<void>
}

export interface ReconcileAgentWorkLedgerInput {
  issueNumber: number
  apply: boolean
  record?: AgentWorkRecord
}

export interface ReconcileAgentWorkLedgerReport {
  issueNumber: number
  apply: boolean
  append: {
    outcome: 'none' | 'would-append' | 'appended' | 'duplicate' | 'rejected' | 'uncertain'
    appended: boolean | null
    idempotencyKey?: string
  }
  ledger: NormalizedAgentWorkLedger
  plannedLedger?: NormalizedAgentWorkLedger
  diagnostics: Array<
    | 'append-rejected'
    | 'append-outcome-uncertain'
    | 'append-readback-failed'
    | 'append-confirmed-not-observed'
  >
}

export class AgentWorkAppendRejectedError extends Error {
  constructor() {
    super('GitHub rejected the agent-work comment append.')
    this.name = 'AgentWorkAppendRejectedError'
  }
}

export class AgentWorkAppendUncertainError extends Error {
  constructor() {
    super('GitHub did not return a conclusive agent-work comment append result.')
    this.name = 'AgentWorkAppendUncertainError'
  }
}

export function parseAgentWorkRecord(value: unknown): AgentWorkRecord {
  const record = requireObject(value, 'measurement record')
  requireExactKeys(
    record,
    ['schema', 'issueNumber', 'phase', 'runKey', 'idempotencyKey', 'availability'],
    [
      'route',
      'usage',
      'timing',
      'missingFacts',
      'unavailableReason',
      'outcome',
      'supersedes',
    ],
    'measurement record',
  )
  if (record.schema !== AGENT_WORK_SCHEMA) {
    throw new Error(`Agent-work schema must be ${AGENT_WORK_SCHEMA}.`)
  }
  const issueNumber = requirePositiveInteger(record.issueNumber, 'issueNumber')
  const phase = requireEnum(record.phase, AGENT_WORK_PHASES, 'phase')
  const runKey = requireKey(record.runKey, 'runKey')
  const idempotencyKey = requireKey(record.idempotencyKey, 'idempotencyKey')
  const availability = requireEnum(
    record.availability,
    AGENT_WORK_AVAILABILITY,
    'availability',
  )
  const route = record.route === undefined ? undefined : parseRoute(record.route)
  const usage = record.usage === undefined ? undefined : parseUsage(record.usage)
  const timing = record.timing === undefined ? undefined : parseTiming(record.timing)
  const missingFacts =
    record.missingFacts === undefined
      ? undefined
      : requireUniqueEnumArray(
          record.missingFacts,
          AGENT_WORK_MISSING_FACTS,
          'missingFacts',
        )
  const unavailableReason =
    record.unavailableReason === undefined
      ? undefined
      : requireEnum(
          record.unavailableReason,
          AGENT_WORK_UNAVAILABLE_REASONS,
          'unavailableReason',
        )
  const outcome =
    record.outcome === undefined ? undefined : parseOutcome(record.outcome, phase)
  const supersedes =
    record.supersedes === undefined
      ? undefined
      : requireKey(record.supersedes, 'supersedes')

  validateAvailability({
    availability,
    route,
    usage,
    timing,
    missingFacts,
    unavailableReason,
  })
  if (
    timing?.timeToFirstCandidateMilliseconds !== undefined &&
    phase !== 'implementation'
  ) {
    throw new Error('Only implementation records may contain time to first candidate.')
  }
  if (supersedes === idempotencyKey) {
    throw new Error('A measurement record cannot supersede itself.')
  }

  return {
    schema: AGENT_WORK_SCHEMA,
    issueNumber,
    phase,
    runKey,
    idempotencyKey,
    availability,
    ...(route === undefined ? {} : { route }),
    ...(usage === undefined ? {} : { usage }),
    ...(timing === undefined ? {} : { timing }),
    ...(missingFacts === undefined ? {} : { missingFacts }),
    ...(unavailableReason === undefined ? {} : { unavailableReason }),
    ...(outcome === undefined ? {} : { outcome }),
    ...(supersedes === undefined ? {} : { supersedes }),
  }
}

export function serializeAgentWorkComment(record: AgentWorkRecord): string {
  const normalized = parseAgentWorkRecord(record)
  const body = `${AGENT_WORK_COMMENT_MARKER}\n\n\`\`\`json\n${JSON.stringify(normalized, null, 2)}\n\`\`\``
  if (byteLength(body) > MAX_COMMENT_BYTES) {
    throw new Error('The canonical measurement comment exceeds its byte limit.')
  }
  return body
}

export function parseAgentWorkComment(
  body: string,
):
  | { kind: 'unrelated' }
  | { kind: 'invalid' }
  | { kind: 'record'; record: AgentWorkRecord } {
  const prefix = `${AGENT_WORK_COMMENT_MARKER}\n\n\`\`\`json\n`
  const suffix = '\n```'
  if (!body.startsWith(AGENT_WORK_COMMENT_MARKER)) return { kind: 'unrelated' }
  if (
    byteLength(body) > MAX_COMMENT_BYTES ||
    !body.startsWith(prefix) ||
    !body.endsWith(suffix)
  ) {
    return { kind: 'invalid' }
  }
  const json = body.slice(prefix.length, -suffix.length)
  try {
    const record = parseAgentWorkRecord(JSON.parse(json))
    return serializeAgentWorkComment(record) === body
      ? { kind: 'record', record }
      : { kind: 'invalid' }
  } catch {
    return { kind: 'invalid' }
  }
}

export function normalizeAgentWorkComments(
  issueNumber: number,
  bodies: readonly string[],
): NormalizedAgentWorkLedger {
  requirePositiveInteger(issueNumber, 'issueNumber')
  const diagnostics: AgentWorkLedgerDiagnostic[] = []
  const records: Array<AgentWorkRecord & { commentOrdinal: number }> = []
  const recordsByKey = new Map<string, AgentWorkRecord & { commentOrdinal: number }>()
  const activeKeyByRun = new Map<string, string>()
  let unrelatedComments = 0

  for (const [index, body] of bodies.entries()) {
    const commentOrdinal = index + 1
    const parsed = parseAgentWorkComment(body)
    if (parsed.kind === 'unrelated') {
      unrelatedComments += 1
      continue
    }
    if (parsed.kind === 'invalid' || parsed.record.issueNumber !== issueNumber) {
      diagnostics.push({ code: 'invalid-record', commentOrdinal })
      continue
    }
    const existing = recordsByKey.get(parsed.record.idempotencyKey)
    if (existing !== undefined) {
      diagnostics.push({
        code:
          canonicalRecord(existing) === canonicalRecord(parsed.record)
            ? 'duplicate-record'
            : 'idempotency-conflict',
        commentOrdinal,
      })
      continue
    }
    const runIdentity = `${parsed.record.phase}:${parsed.record.runKey}`
    const activeKey = activeKeyByRun.get(runIdentity)
    if (parsed.record.supersedes !== undefined) {
      const target = recordsByKey.get(parsed.record.supersedes)
      if (
        target === undefined ||
        target.issueNumber !== parsed.record.issueNumber ||
        target.phase !== parsed.record.phase ||
        target.runKey !== parsed.record.runKey ||
        activeKey !== target.idempotencyKey
      ) {
        diagnostics.push({ code: 'invalid-supersession', commentOrdinal })
        continue
      }
    } else if (activeKey !== undefined) {
      diagnostics.push({ code: 'invalid-supersession', commentOrdinal })
      continue
    }
    const admitted = { ...parsed.record, commentOrdinal }
    records.push(admitted)
    recordsByKey.set(admitted.idempotencyKey, admitted)
    activeKeyByRun.set(runIdentity, admitted.idempotencyKey)
  }

  const supersededBy = new Map<string, string>()
  for (const record of records) {
    if (record.supersedes !== undefined) {
      supersededBy.set(record.supersedes, record.idempotencyKey)
    }
  }
  const normalizedRecords: NormalizedAgentWorkRecord[] = records.map((record) => {
    const successor = supersededBy.get(record.idempotencyKey)
    return {
      ...record,
      activity: successor === undefined ? 'active' : 'superseded',
      ...(successor === undefined ? {} : { supersededBy: successor }),
    }
  })
  const active = normalizedRecords.filter((record) => record.activity === 'active')
  const phaseTotals = AGENT_WORK_PHASES.map((phase) => ({
    phase,
    total: aggregateRecords(
      active.filter((record) => record.phase === phase),
      diagnostics,
    ),
  }))
  const ownTotal = aggregateRecords(active, diagnostics)
  return {
    issueNumber,
    records: normalizedRecords,
    phaseTotals,
    ownTotal,
    diagnostics: dedupeDiagnostics(diagnostics),
    unrelatedComments,
  }
}

export async function reconcileAgentWorkLedger(
  port: AgentWorkLedgerPort,
  input: ReconcileAgentWorkLedgerInput,
): Promise<ReconcileAgentWorkLedgerReport> {
  const issueNumber = requirePositiveInteger(input.issueNumber, 'issueNumber')
  const bodies = await port.listCommentBodies(issueNumber)
  const ledger = normalizeAgentWorkComments(issueNumber, bodies)
  if (input.record === undefined) {
    return {
      issueNumber,
      apply: input.apply,
      append: { outcome: 'none', appended: false },
      ledger,
      diagnostics: [],
    }
  }

  const record = parseAgentWorkRecord(input.record)
  if (record.issueNumber !== issueNumber) {
    throw new Error('The measurement record issueNumber must match --issue.')
  }
  const existing = ledger.records.find(
    (candidate) => candidate.idempotencyKey === record.idempotencyKey,
  )
  if (existing !== undefined) {
    if (canonicalRecord(existing) !== canonicalRecord(record)) {
      throw new Error('The idempotency key already belongs to a different record.')
    }
    return {
      issueNumber,
      apply: input.apply,
      append: {
        outcome: 'duplicate',
        appended: false,
        idempotencyKey: record.idempotencyKey,
      },
      ledger,
      diagnostics: [],
    }
  }

  const comment = serializeAgentWorkComment(record)
  const plannedLedger = normalizeAgentWorkComments(issueNumber, [...bodies, comment])
  const planned = plannedLedger.records.find(
    (candidate) => candidate.idempotencyKey === record.idempotencyKey,
  )
  if (planned === undefined) {
    throw new Error('The measurement record does not form a valid active ledger entry.')
  }
  if (!input.apply) {
    return {
      issueNumber,
      apply: false,
      append: {
        outcome: 'would-append',
        appended: false,
        idempotencyKey: record.idempotencyKey,
      },
      ledger,
      plannedLedger,
      diagnostics: [],
    }
  }

  let uncertainAppend = false
  try {
    await port.appendComment(issueNumber, comment)
  } catch (error) {
    if (!(error instanceof AgentWorkAppendUncertainError)) {
      if (error instanceof AgentWorkAppendRejectedError) {
        return {
          issueNumber,
          apply: true,
          append: {
            outcome: 'rejected',
            appended: false,
            idempotencyKey: record.idempotencyKey,
          },
          ledger,
          diagnostics: ['append-rejected'],
        }
      }
      throw error
    }
    uncertainAppend = true
  }

  let resolvedBodies: string[]
  try {
    resolvedBodies = await port.listCommentBodies(issueNumber)
  } catch {
    return {
      issueNumber,
      apply: true,
      append: {
        outcome: uncertainAppend ? 'uncertain' : 'appended',
        appended: uncertainAppend ? null : true,
        idempotencyKey: record.idempotencyKey,
      },
      ledger,
      plannedLedger,
      diagnostics: [
        uncertainAppend ? 'append-outcome-uncertain' : 'append-readback-failed',
      ],
    }
  }
  const resolvedLedger = normalizeAgentWorkComments(issueNumber, resolvedBodies)
  const resolved = resolvedLedger.records.find(
    (candidate) => candidate.idempotencyKey === record.idempotencyKey,
  )
  if (resolved !== undefined && canonicalRecord(resolved) === canonicalRecord(record)) {
    return {
      issueNumber,
      apply: true,
      append: {
        outcome: 'appended',
        appended: true,
        idempotencyKey: record.idempotencyKey,
      },
      ledger: resolvedLedger,
      diagnostics: [],
    }
  }
  if (!uncertainAppend) {
    return {
      issueNumber,
      apply: true,
      append: {
        outcome: 'appended',
        appended: true,
        idempotencyKey: record.idempotencyKey,
      },
      ledger: resolvedLedger,
      plannedLedger,
      diagnostics: ['append-confirmed-not-observed'],
    }
  }
  return {
    issueNumber,
    apply: true,
    append: {
      outcome: 'uncertain',
      appended: null,
      idempotencyKey: record.idempotencyKey,
    },
    ledger: resolvedLedger,
    plannedLedger,
    diagnostics: ['append-outcome-uncertain'],
  }
}

function dedupeDiagnostics(
  diagnostics: readonly AgentWorkLedgerDiagnostic[],
): AgentWorkLedgerDiagnostic[] {
  const seen = new Set<string>()
  return diagnostics.filter((diagnostic) => {
    const key = JSON.stringify(diagnostic)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function parseRoute(value: unknown): AgentWorkRoute {
  const route = requireObject(value, 'route')
  requireExactKeys(route, ['initial', 'changes'], [], 'route')
  const initialObject = requireObject(route.initial, 'route.initial')
  requireExactKeys(
    initialObject,
    ['harness'],
    ['modelId', 'requestedReasoningEffort', 'effectiveReasoningEffort'],
    'route.initial',
  )
  const initial: AgentWorkRoute['initial'] = {
    harness: requireEnum(initialObject.harness, HARNESSES, 'route.initial.harness'),
    ...parseRouteFacts(initialObject, 'route.initial'),
  }
  if (!Array.isArray(route.changes)) throw new Error('route.changes must be an array.')
  if (route.changes.length > MAX_ROUTE_CHANGES) {
    throw new Error(`route.changes cannot exceed ${MAX_ROUTE_CHANGES} entries.`)
  }
  let previous: AgentWorkRouteStep = initial
  const changes = route.changes.map((candidate, index) => {
    const change = requireObject(candidate, `route.changes[${index}]`)
    requireExactKeys(
      change,
      ['sequence', 'escalation'],
      ['modelId', 'requestedReasoningEffort', 'effectiveReasoningEffort'],
      `route.changes[${index}]`,
    )
    if (change.sequence !== index + 1) {
      throw new Error('Route change sequence must be contiguous and start at 1.')
    }
    if (typeof change.escalation !== 'boolean') {
      throw new Error('Route change escalation must be boolean.')
    }
    const facts = parseRouteFacts(change, `route.changes[${index}]`)
    if (Object.keys(facts).length === 0 || sameRouteFacts(previous, facts)) {
      throw new Error('Each route change must contain an observed changed route fact.')
    }
    previous = { ...previous, ...facts }
    return { sequence: change.sequence, escalation: change.escalation, ...facts }
  })
  return { initial, changes }
}

function parseRouteFacts(
  value: Readonly<Record<string, unknown>>,
  name: string,
): AgentWorkRouteStep {
  const modelId =
    value.modelId === undefined
      ? undefined
      : requirePattern(value.modelId, ROUTE_VALUE_PATTERN, `${name}.modelId`)
  const requestedReasoningEffort =
    value.requestedReasoningEffort === undefined
      ? undefined
      : requirePattern(
          value.requestedReasoningEffort,
          EFFORT_PATTERN,
          `${name}.requestedReasoningEffort`,
        )
  const effectiveReasoningEffort =
    value.effectiveReasoningEffort === undefined
      ? undefined
      : requirePattern(
          value.effectiveReasoningEffort,
          EFFORT_PATTERN,
          `${name}.effectiveReasoningEffort`,
        )
  return {
    ...(modelId === undefined ? {} : { modelId }),
    ...(requestedReasoningEffort === undefined ? {} : { requestedReasoningEffort }),
    ...(effectiveReasoningEffort === undefined ? {} : { effectiveReasoningEffort }),
  }
}

function parseUsage(value: unknown): AgentWorkUsage {
  const usage = requireObject(value, 'usage')
  requireExactKeys(usage, [], [...AGENT_WORK_COUNTERS, 'normalizedTokenTotal'], 'usage')
  const result: AgentWorkUsage = {}
  for (const counter of AGENT_WORK_COUNTERS) {
    if (usage[counter] !== undefined) {
      result[counter] = requireNonNegativeInteger(usage[counter], `usage.${counter}`)
    }
  }
  if (usage.normalizedTokenTotal !== undefined) {
    result.normalizedTokenTotal = requireNonNegativeInteger(
      usage.normalizedTokenTotal,
      'usage.normalizedTokenTotal',
    )
  }
  if (Object.keys(result).length === 0) throw new Error('usage must contain a counter.')
  return result
}

function parseTiming(value: unknown): AgentWorkTiming {
  const timing = requireObject(value, 'timing')
  requireExactKeys(
    timing,
    [],
    [
      'activeWallMilliseconds',
      'modelOrApiMilliseconds',
      'timeToFirstCandidateMilliseconds',
    ],
    'timing',
  )
  const result: AgentWorkTiming = {}
  for (const name of [
    'activeWallMilliseconds',
    'modelOrApiMilliseconds',
    'timeToFirstCandidateMilliseconds',
  ] as const) {
    if (timing[name] !== undefined) {
      result[name] = requireNonNegativeInteger(timing[name], `timing.${name}`)
    }
  }
  if (Object.keys(result).length === 0) throw new Error('timing must contain a duration.')
  return result
}

function parseOutcome(value: unknown, phase: AgentWorkPhase): AgentWorkOutcome {
  if (phase !== 'implementation') {
    throw new Error('Only implementation records may contain first-pass outcome facts.')
  }
  const outcome = requireObject(value, 'outcome')
  requireExactKeys(outcome, ['firstPass'], ['candidateRef'], 'outcome')
  const firstPass = requireEnum(
    outcome.firstPass,
    FIRST_PASS_OUTCOMES,
    'outcome.firstPass',
  )
  const candidateRef =
    outcome.candidateRef === undefined
      ? undefined
      : requirePattern(outcome.candidateRef, CANDIDATE_PATTERN, 'outcome.candidateRef')
  if (firstPass === 'no-candidate' && candidateRef !== undefined) {
    throw new Error('A no-candidate outcome cannot name a candidate.')
  }
  if (firstPass !== 'no-candidate' && candidateRef === undefined) {
    throw new Error(`A ${firstPass} outcome must name a candidate.`)
  }
  return { firstPass, ...(candidateRef === undefined ? {} : { candidateRef }) }
}

function validateAvailability(input: {
  availability: AgentWorkAvailability
  route?: AgentWorkRoute
  usage?: AgentWorkUsage
  timing?: AgentWorkTiming
  missingFacts?: AgentWorkMissingFact[]
  unavailableReason?: AgentWorkUnavailableReason
}): void {
  const additive = AGENT_WORK_ADDITIVE_TOKEN_COUNTER_NAMES.map(
    (name) => input.usage?.[name],
  )
  if (input.availability === 'complete') {
    if (input.route === undefined) {
      throw new Error('Complete measurements require an initial route.')
    }
    if (additive.some((value) => value === undefined)) {
      throw new Error('Complete measurements require every additive token counter.')
    }
    const total = sumSafe(additive as number[])
    if (total === undefined || input.usage?.normalizedTokenTotal !== total) {
      throw new Error('Complete measurements require the exact normalized token total.')
    }
    if (input.missingFacts !== undefined || input.unavailableReason !== undefined) {
      throw new Error(
        'Complete measurements cannot contain missing or unavailable facts.',
      )
    }
    return
  }
  if (input.availability === 'partial') {
    if (input.route === undefined) {
      throw new Error('Partial measurements require an initial route.')
    }
    if (
      input.missingFacts === undefined ||
      input.missingFacts.length === 0 ||
      input.unavailableReason !== undefined
    ) {
      throw new Error(
        'Partial measurements require missingFacts and no unavailableReason.',
      )
    }
    if (input.usage?.normalizedTokenTotal !== undefined) {
      throw new Error('Partial measurements cannot claim a normalized token total.')
    }
    if (input.usage === undefined && input.timing === undefined) {
      throw new Error('Partial measurements require at least one usage or timing fact.')
    }
    return
  }
  if (
    input.unavailableReason === undefined ||
    input.usage !== undefined ||
    input.timing !== undefined ||
    input.missingFacts !== undefined
  ) {
    throw new Error(
      'Unavailable measurements require one reason and cannot contain usage, timing, or missingFacts.',
    )
  }
}

function aggregateRecords(
  records: readonly NormalizedAgentWorkRecord[],
  diagnostics: AgentWorkLedgerDiagnostic[],
): AgentWorkAggregate {
  const completeRuns = records.filter(
    (record) => record.availability === 'complete',
  ).length
  const partialRuns = records.filter((record) => record.availability === 'partial').length
  const unavailableRuns = records.filter(
    (record) => record.availability === 'unavailable',
  ).length
  const counters: Partial<Record<AgentWorkCounter, AggregateValue>> = {}
  for (const counter of AGENT_WORK_COUNTERS) {
    const values = records.flatMap((record) => {
      const value = record.usage?.[counter]
      return value === undefined ? [] : [value]
    })
    const value = sumSafe(values)
    if (value === undefined && values.length > 0) {
      diagnostics.push({ code: 'aggregate-overflow', field: counter })
    } else if (value !== undefined && values.length > 0) {
      counters[counter] = { value, observedRuns: values.length }
    }
  }
  const knownParts = records.flatMap((record) =>
    AGENT_WORK_ADDITIVE_TOKEN_COUNTER_NAMES.flatMap((counter) => {
      const value = record.usage?.[counter]
      return value === undefined ? [] : [value]
    }),
  )
  const knownTokenSubtotal = sumSafe(knownParts)
  if (knownTokenSubtotal === undefined && knownParts.length > 0) {
    diagnostics.push({ code: 'aggregate-overflow', field: 'knownTokenSubtotal' })
  }
  const normalizedValues = records.flatMap((record) => {
    const value = record.usage?.normalizedTokenTotal
    return value === undefined ? [] : [value]
  })
  const normalizedTokenTotal = sumSafe(normalizedValues)
  if (normalizedTokenTotal === undefined && normalizedValues.length > 0) {
    diagnostics.push({ code: 'aggregate-overflow', field: 'normalizedTokenTotal' })
  }
  const activeWall = aggregateTiming(records, 'activeWallMilliseconds', diagnostics)
  const modelOrApi = aggregateTiming(records, 'modelOrApiMilliseconds', diagnostics)
  return {
    availability:
      records.length === 0 || unavailableRuns === records.length
        ? 'unavailable'
        : completeRuns === records.length && normalizedTokenTotal !== undefined
          ? 'complete'
          : 'partial',
    activeRuns: records.length,
    completeRuns,
    partialRuns,
    unavailableRuns,
    counters,
    ...(knownTokenSubtotal === undefined || knownParts.length === 0
      ? {}
      : { knownTokenSubtotal }),
    ...(completeRuns === records.length &&
    records.length > 0 &&
    normalizedTokenTotal !== undefined
      ? { normalizedTokenTotal }
      : {}),
    timing: {
      ...(activeWall === undefined ? {} : { activeWallMilliseconds: activeWall }),
      ...(modelOrApi === undefined ? {} : { modelOrApiMilliseconds: modelOrApi }),
    },
  }
}

function aggregateTiming(
  records: readonly NormalizedAgentWorkRecord[],
  name: 'activeWallMilliseconds' | 'modelOrApiMilliseconds',
  diagnostics: AgentWorkLedgerDiagnostic[],
): AggregateValue | undefined {
  const values = records.flatMap((record) => {
    const value = record.timing?.[name]
    return value === undefined ? [] : [value]
  })
  const value = sumSafe(values)
  if (value === undefined && values.length > 0) {
    diagnostics.push({ code: 'aggregate-overflow', field: name })
    return undefined
  }
  return value === undefined || values.length === 0
    ? undefined
    : { value, observedRuns: values.length }
}

function canonicalRecord(record: AgentWorkRecord): string {
  const {
    commentOrdinal: _commentOrdinal,
    activity: _activity,
    supersededBy: _supersededBy,
    ...candidate
  } = record as NormalizedAgentWorkRecord
  return JSON.stringify(parseAgentWorkRecord(candidate))
}

function sameRouteFacts(left: AgentWorkRouteStep, right: AgentWorkRouteStep): boolean {
  return (
    (right.modelId === undefined || right.modelId === left.modelId) &&
    (right.requestedReasoningEffort === undefined ||
      right.requestedReasoningEffort === left.requestedReasoningEffort) &&
    (right.effectiveReasoningEffort === undefined ||
      right.effectiveReasoningEffort === left.effectiveReasoningEffort)
  )
}

function requireObject(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`)
  }
  return value as Readonly<Record<string, unknown>>
}

function requireExactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[],
  name: string,
): void {
  const allowed = new Set([...required, ...optional])
  const unexpected = Object.keys(value).find((key) => !allowed.has(key))
  if (unexpected !== undefined) throw new Error(`${name} contains an unexpected field.`)
  const missing = required.find((key) => !Object.hasOwn(value, key))
  if (missing !== undefined) throw new Error(`${name} is missing a required field.`)
}

function requirePositiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value <= 0) {
    throw new Error(`${name} must be a positive integer.`)
  }
  return value
}

function requireNonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`)
  }
  return value
}

function requireKey(value: unknown, name: string): string {
  return requirePattern(value, KEY_PATTERN, name)
}

function requirePattern(value: unknown, pattern: RegExp, name: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`${name} has an invalid bounded identifier.`)
  }
  return value
}

function requireEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  name: string,
): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`${name} has an unsupported value.`)
  }
  return value
}

function requireUniqueEnumArray<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  name: string,
): T[number][] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array.`)
  const result = value.map((candidate) => requireEnum(candidate, allowed, name))
  if (new Set(result).size !== result.length) {
    throw new Error(`${name} must not contain duplicates.`)
  }
  return result.sort((left, right) => left.localeCompare(right))
}

function sumSafe(values: readonly number[]): number | undefined {
  let total = 0
  for (const value of values) {
    const next = total + value
    if (!Number.isSafeInteger(next)) return undefined
    total = next
  }
  return total
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}
