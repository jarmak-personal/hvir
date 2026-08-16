import { describe, expect, it, vi } from 'vitest'

import {
  AGENT_WORK_COUNTERS,
  AgentWorkAppendRejectedError,
  AgentWorkAppendUncertainError,
  agentWorkLedgerProjectionDiagnostic,
  normalizeAgentWorkComments,
  parseAgentWorkComment,
  parseAgentWorkRecord,
  reconcileAgentWorkLedger,
  requireAgentWorkIssueNumber,
  serializeAgentWorkComment,
  sumAgentWorkSafeIntegers,
  type AgentWorkLedgerDiagnostic,
  type AgentWorkLedgerPort,
  type AgentWorkRecord,
} from '../scripts/project-management/agent-work-ledger.ts'
import {
  agentWorkExitCode,
  parseAgentWorkCliOptions,
} from '../scripts/project-management/agent-work-cli.ts'
import {
  AGENT_WORK_TOKEN_COUNTER_NAMES,
  HARNESS_USAGE_UNAVAILABLE_REASONS,
  type AgentWorkUnavailableReason,
} from '../src/shared/agent-work-measurement.ts'

const ISSUE = 573
const RUN_A = 'a'.repeat(64)
const RUN_B = 'b'.repeat(64)
const KEY_A = '1'.repeat(64)
const KEY_B = '2'.repeat(64)
const KEY_C = '3'.repeat(64)

describe('agent-work ledger shared policy', () => {
  it('owns issue-number validation and overflow-safe aggregation', () => {
    expect(requireAgentWorkIssueNumber(ISSUE)).toBe(ISSUE)
    expect(() => requireAgentWorkIssueNumber(0)).toThrow(
      'Agent-work issue number must be a positive integer.',
    )
    expect(sumAgentWorkSafeIntegers([Number.MAX_SAFE_INTEGER, 0])).toBe(
      Number.MAX_SAFE_INTEGER,
    )
    expect(sumAgentWorkSafeIntegers([Number.MAX_SAFE_INTEGER, 1])).toBeUndefined()
  })

  it('owns the content-free projection diagnostic mapping', () => {
    const diagnostics: AgentWorkLedgerDiagnostic[] = [
      { code: 'invalid-record', commentOrdinal: 1 },
      { code: 'duplicate-record', commentOrdinal: 2 },
      { code: 'idempotency-conflict', commentOrdinal: 3 },
      { code: 'invalid-supersession', commentOrdinal: 4 },
      { code: 'aggregate-overflow', field: 'normalizedTokenTotal' },
    ]

    expect(diagnostics.map(agentWorkLedgerProjectionDiagnostic)).toEqual([
      'ledger-invalid-record',
      'ledger-duplicate-record',
      'ledger-idempotency-conflict',
      'ledger-invalid-supersession',
      'ledger-aggregate-overflow',
    ])
  })
})

describe('agent-work record schema', () => {
  it('round-trips only the exact marked, bounded complete schema', () => {
    const record = completeRecord()
    const body = serializeAgentWorkComment(record)

    expect(parseAgentWorkComment(body)).toEqual({ kind: 'record', record })
    expect(parseAgentWorkComment(`preface\n${body}`)).toEqual({ kind: 'unrelated' })
    expect(
      parseAgentWorkComment(
        body.replace('"schema": 1', '"schema": 1,\n  "prompt": "private"'),
      ),
    ).toEqual({ kind: 'invalid' })
    expect(body).not.toContain('session')
  })

  it('validates enumerations, identifiers, numeric bounds, and availability claims', () => {
    expect(() =>
      parseAgentWorkRecord({ ...completeRecord(), phase: 'delivery' }),
    ).toThrow('unsupported')
    expect(() =>
      parseAgentWorkRecord({ ...completeRecord(), runKey: 'human-readable-run' }),
    ).toThrow('bounded identifier')
    expect(() =>
      parseAgentWorkRecord({
        ...completeRecord(),
        usage: { ...completeRecord().usage, outputTokens: Number.MAX_SAFE_INTEGER + 1 },
      }),
    ).toThrow('non-negative integer')
    expect(() =>
      parseAgentWorkRecord({
        ...completeRecord(),
        usage: { ...completeRecord().usage, normalizedTokenTotal: 999 },
      }),
    ).toThrow('exact normalized')
    expect(() =>
      parseAgentWorkRecord({
        ...completeRecord(),
        availability: 'partial',
        missingFacts: ['cache-write-input-tokens'],
      }),
    ).toThrow('cannot claim a normalized')
    expect(() =>
      parseAgentWorkRecord({
        ...unavailableRecord(),
        timing: { activeWallMilliseconds: 1 },
      }),
    ).toThrow('cannot contain usage, timing')
  })

  it('shares provider counter and unavailable-reason vocabulary without drift', () => {
    const providerReasons: readonly AgentWorkUnavailableReason[] =
      HARNESS_USAGE_UNAVAILABLE_REASONS

    expect(AGENT_WORK_COUNTERS).toBe(AGENT_WORK_TOKEN_COUNTER_NAMES)
    expect(providerReasons).toContain('invalid-session-identity')
    expect(
      parseAgentWorkRecord({
        ...unavailableRecord(),
        unavailableReason: 'invalid-session-identity',
      }),
    ).toMatchObject({
      availability: 'unavailable',
      unavailableReason: 'invalid-session-identity',
    })
  })

  it('requires ordered, truthful route changes and implementation-only outcome facts', () => {
    expect(() =>
      parseAgentWorkRecord({
        ...completeRecord(),
        route: {
          initial: { harness: 'codex', modelId: 'gpt-5' },
          changes: [{ sequence: 2, escalation: true, modelId: 'gpt-6' }],
        },
      }),
    ).toThrow('contiguous')
    expect(() =>
      parseAgentWorkRecord({
        ...completeRecord(),
        phase: 'issue-planning',
        outcome: { firstPass: 'pending', candidateRef: 'abc1234' },
      }),
    ).toThrow('Only implementation records')
    expect(() =>
      parseAgentWorkRecord({
        ...completeRecord(),
        outcome: { firstPass: 'accepted' },
      }),
    ).toThrow('must name a candidate')
  })
})

describe('agent-work ledger normalization', () => {
  it('returns an empty, unavailable history without inventing zero usage', () => {
    const ledger = normalizeAgentWorkComments(ISSUE, [])

    expect(ledger.records).toEqual([])
    expect(ledger.ownTotal).toMatchObject({
      availability: 'unavailable',
      activeRuns: 0,
      counters: {},
    })
    expect(ledger.ownTotal).not.toHaveProperty('knownTokenSubtotal')
    expect(ledger.ownTotal).not.toHaveProperty('normalizedTokenTotal')
  })

  it('aggregates multiple phases into exact Own totals with reasoning non-additive', () => {
    const planning = completeRecord({
      phase: 'issue-planning',
      idempotencyKey: KEY_A,
      runKey: RUN_A,
      usage: usage(10, 20, 30, 40, 25),
      outcome: undefined,
    })
    const implementation = completeRecord({
      idempotencyKey: KEY_B,
      runKey: RUN_B,
      usage: usage(1, 2, 3, 4, 3),
      timing: {
        activeWallMilliseconds: 500,
        modelOrApiMilliseconds: 200,
        timeToFirstCandidateMilliseconds: 500,
      },
    })
    const ledger = normalizeAgentWorkComments(ISSUE, [
      serializeAgentWorkComment(planning),
      serializeAgentWorkComment(implementation),
    ])

    expect(ledger.ownTotal).toMatchObject({
      availability: 'complete',
      activeRuns: 2,
      normalizedTokenTotal: 110,
      knownTokenSubtotal: 110,
      counters: {
        outputTokens: { value: 44, observedRuns: 2 },
        reasoningTokens: { value: 28, observedRuns: 2 },
      },
      timing: {
        activeWallMilliseconds: { value: 600, observedRuns: 2 },
      },
    })
    expect(ledger.ownTotal.timing).not.toHaveProperty('timeToFirstCandidateMilliseconds')
    expect(
      ledger.phaseTotals.find(({ phase }) => phase === 'issue-planning')?.total,
    ).toMatchObject({ normalizedTokenTotal: 100 })
  })

  it('retains multi-run candidate facts on records without inventing aggregate policy', () => {
    const first = completeRecord({
      timing: {
        activeWallMilliseconds: 100,
        timeToFirstCandidateMilliseconds: 100,
      },
      outcome: { firstPass: 'pending', candidateRef: 'abcdef1' },
    })
    const reopened = completeRecord({
      idempotencyKey: KEY_B,
      runKey: RUN_B,
      timing: {
        activeWallMilliseconds: 200,
        timeToFirstCandidateMilliseconds: 999,
      },
      outcome: { firstPass: 'rework-required', candidateRef: 'abcdef2' },
    })
    const ledger = normalizeAgentWorkComments(ISSUE, [
      serializeAgentWorkComment(first),
      serializeAgentWorkComment(reopened),
    ])

    expect(ledger.records.map((record) => record.outcome?.firstPass)).toEqual([
      'pending',
      'rework-required',
    ])
    expect(
      ledger.records.map((record) => record.timing?.timeToFirstCandidateMilliseconds),
    ).toEqual([100, 999])
    expect(ledger.ownTotal).not.toHaveProperty('firstPassOutcome')
    expect(ledger.ownTotal.timing).not.toHaveProperty('timeToFirstCandidateMilliseconds')
  })

  it('deduplicates identical retries and rejects conflicting key reuse', () => {
    const original = serializeAgentWorkComment(completeRecord())
    const conflicting = serializeAgentWorkComment(
      completeRecord({ usage: usage(2, 2, 3, 4, 1) }),
    )
    const ledger = normalizeAgentWorkComments(ISSUE, [original, original, conflicting])

    expect(ledger.records).toHaveLength(1)
    expect(ledger.ownTotal.normalizedTokenTotal).toBe(10)
    expect(ledger.diagnostics).toEqual([
      { code: 'duplicate-record', commentOrdinal: 2 },
      { code: 'idempotency-conflict', commentOrdinal: 3 },
    ])
  })

  it('keeps history while only the latest valid same-run correction stays active', () => {
    const original = completeRecord()
    const correction = unavailableRecord({
      idempotencyKey: KEY_B,
      supersedes: KEY_A,
    })
    const secondCorrection = completeRecord({
      idempotencyKey: KEY_C,
      supersedes: KEY_B,
      usage: usage(1, 1, 1, 1, 1),
    })
    const fork = completeRecord({
      idempotencyKey: '4'.repeat(64),
      supersedes: KEY_A,
    })
    const ledger = normalizeAgentWorkComments(ISSUE, [
      serializeAgentWorkComment(original),
      serializeAgentWorkComment(correction),
      serializeAgentWorkComment(secondCorrection),
      serializeAgentWorkComment(fork),
    ])

    expect(ledger.records.map(({ activity }) => activity)).toEqual([
      'superseded',
      'superseded',
      'active',
    ])
    expect(ledger.ownTotal.normalizedTokenTotal).toBe(4)
    expect(ledger.diagnostics).toContainEqual({
      code: 'invalid-supersession',
      commentOrdinal: 4,
    })
  })

  it('keeps reopened work as a distinct run and reports partial coverage honestly', () => {
    const original = completeRecord()
    const reopened = partialRecord({ idempotencyKey: KEY_B, runKey: RUN_B })
    const ledger = normalizeAgentWorkComments(ISSUE, [
      serializeAgentWorkComment(original),
      'ordinary maintainer discussion',
      serializeAgentWorkComment(reopened),
    ])

    expect(ledger.records).toHaveLength(2)
    expect(ledger.unrelatedComments).toBe(1)
    expect(ledger.ownTotal).toMatchObject({
      availability: 'partial',
      activeRuns: 2,
      completeRuns: 1,
      partialRuns: 1,
      knownTokenSubtotal: 15,
    })
    expect(ledger.ownTotal).not.toHaveProperty('normalizedTokenTotal')
  })

  it('fails aggregate overflow closed without discarding the admitted records', () => {
    const first = completeRecord({
      usage: usage(Number.MAX_SAFE_INTEGER, 0, 0, 0, 0),
    })
    const second = completeRecord({
      idempotencyKey: KEY_B,
      runKey: RUN_B,
      usage: usage(1, 0, 0, 0, 0),
    })
    const ledger = normalizeAgentWorkComments(ISSUE, [
      serializeAgentWorkComment(first),
      serializeAgentWorkComment(second),
    ])

    expect(ledger.records).toHaveLength(2)
    expect(ledger.ownTotal.availability).toBe('partial')
    expect(ledger.ownTotal).not.toHaveProperty('normalizedTokenTotal')
    expect(ledger.diagnostics).toEqual(
      expect.arrayContaining([
        { code: 'aggregate-overflow', field: 'freshInputTokens' },
        { code: 'aggregate-overflow', field: 'knownTokenSubtotal' },
        { code: 'aggregate-overflow', field: 'normalizedTokenTotal' },
      ]),
    )
  })

  it('ignores malformed, wrong-issue, and invalid supersession comments without exposing bodies', () => {
    const hostile = 'SECRET issue body and provider transcript'
    const wrongIssue = serializeAgentWorkComment(
      completeRecord({ issueNumber: ISSUE + 1 }),
    )
    const invalidSupersession = serializeAgentWorkComment(
      completeRecord({ idempotencyKey: KEY_B, supersedes: KEY_C }),
    )
    const ledger = normalizeAgentWorkComments(ISSUE, [
      hostile,
      '<!-- hvir-agent-work-measurement:v1 -->\ninvalid',
      wrongIssue,
      invalidSupersession,
    ])

    expect(ledger.records).toEqual([])
    expect(ledger.diagnostics).toEqual([
      { code: 'invalid-record', commentOrdinal: 2 },
      { code: 'invalid-record', commentOrdinal: 3 },
      { code: 'invalid-supersession', commentOrdinal: 4 },
    ])
    expect(JSON.stringify(ledger)).not.toContain(hostile)
  })
})

describe('agent-work append operation', () => {
  it('plans without mutation and returns projected normalized values', async () => {
    const fixture = fakePort([])
    const report = await reconcileAgentWorkLedger(fixture.port, {
      issueNumber: ISSUE,
      apply: false,
      record: completeRecord(),
    })

    expect(report.append).toMatchObject({ outcome: 'would-append', appended: false })
    expect(report.ledger.records).toEqual([])
    expect(report.plannedLedger?.ownTotal.normalizedTokenTotal).toBe(10)
    expect(fixture.appendComment).not.toHaveBeenCalled()
  })

  it('appends once and resolves a repeated invocation as a duplicate', async () => {
    const bodies: string[] = []
    const fixture = fakePort(bodies)
    const input = { issueNumber: ISSUE, apply: true, record: completeRecord() }

    const first = await reconcileAgentWorkLedger(fixture.port, input)
    const second = await reconcileAgentWorkLedger(fixture.port, input)

    expect(first.append).toMatchObject({ outcome: 'appended', appended: true })
    expect(second.append).toMatchObject({ outcome: 'duplicate', appended: false })
    expect(fixture.appendComment).toHaveBeenCalledTimes(1)
  })

  it('re-reads a confirmed append and reports concurrent history as observed', async () => {
    const bodies: string[] = []
    const concurrent = completeRecord({ idempotencyKey: KEY_B, runKey: RUN_B })
    const listCommentBodies = vi.fn<AgentWorkLedgerPort['listCommentBodies']>(() =>
      Promise.resolve([...bodies]),
    )
    const appendComment = vi.fn<AgentWorkLedgerPort['appendComment']>((_issue, body) => {
      bodies.push(body, serializeAgentWorkComment(concurrent))
      return Promise.resolve()
    })

    const report = await reconcileAgentWorkLedger(
      { listCommentBodies, appendComment },
      { issueNumber: ISSUE, apply: true, record: completeRecord() },
    )

    expect(report.append).toMatchObject({ outcome: 'appended', appended: true })
    expect(report.ledger.records.map(({ idempotencyKey }) => idempotencyKey)).toEqual([
      KEY_A,
      KEY_B,
    ])
    expect(report).not.toHaveProperty('plannedLedger')
    expect(agentWorkExitCode(report)).toBe(0)
    expect(listCommentBodies).toHaveBeenCalledTimes(2)
  })

  it('keeps planned and observed state distinct when confirmed read-back fails', async () => {
    const privateFailure = 'SECRET read failure detail'
    const listCommentBodies = vi
      .fn<AgentWorkLedgerPort['listCommentBodies']>()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error(privateFailure))
    const appendComment = vi
      .fn<AgentWorkLedgerPort['appendComment']>()
      .mockResolvedValue(undefined)

    const report = await reconcileAgentWorkLedger(
      { listCommentBodies, appendComment },
      { issueNumber: ISSUE, apply: true, record: completeRecord() },
    )

    expect(report).toMatchObject({
      append: { outcome: 'appended', appended: true },
      ledger: { records: [] },
      plannedLedger: { records: [expect.objectContaining({ idempotencyKey: KEY_A })] },
      diagnostics: ['append-readback-failed'],
    })
    expect(agentWorkExitCode(report)).toBe(2)
    expect(JSON.stringify(report)).not.toContain(privateFailure)
  })

  it('does not promote a confirmed append projection that read-back has not observed', async () => {
    const fixture = fakePort([])
    fixture.appendComment.mockResolvedValueOnce(undefined)

    const report = await reconcileAgentWorkLedger(fixture.port, {
      issueNumber: ISSUE,
      apply: true,
      record: completeRecord(),
    })

    expect(report).toMatchObject({
      append: { outcome: 'appended', appended: true },
      ledger: { records: [] },
      plannedLedger: { records: [expect.objectContaining({ idempotencyKey: KEY_A })] },
      diagnostics: ['append-confirmed-not-observed'],
    })
    expect(agentWorkExitCode(report)).toBe(2)
  })

  it('resolves an uncertain response by re-reading current state before returning', async () => {
    const bodies: string[] = []
    const record = completeRecord()
    const listCommentBodies = vi.fn<AgentWorkLedgerPort['listCommentBodies']>(() =>
      Promise.resolve([...bodies]),
    )
    const appendComment = vi.fn<AgentWorkLedgerPort['appendComment']>((_issue, body) => {
      bodies.push(body)
      return Promise.reject(new AgentWorkAppendUncertainError())
    })
    const port: AgentWorkLedgerPort = { listCommentBodies, appendComment }

    const report = await reconcileAgentWorkLedger(port, {
      issueNumber: ISSUE,
      apply: true,
      record,
    })

    expect(report.append).toMatchObject({ outcome: 'appended', appended: true })
    expect(report.ledger.records).toHaveLength(1)
    expect(listCommentBodies).toHaveBeenCalledTimes(2)
  })

  it('reports rejected and still-uncertain partial failures with explicit append state', async () => {
    const rejected = fakePort([])
    rejected.appendComment.mockRejectedValueOnce(new AgentWorkAppendRejectedError())
    const rejectedReport = await reconcileAgentWorkLedger(rejected.port, {
      issueNumber: ISSUE,
      apply: true,
      record: completeRecord(),
    })
    expect(rejectedReport).toMatchObject({
      append: { outcome: 'rejected', appended: false },
      diagnostics: ['append-rejected'],
    })
    expect(agentWorkExitCode(rejectedReport)).toBe(2)

    const uncertain = fakePort([])
    uncertain.appendComment.mockRejectedValueOnce(new AgentWorkAppendUncertainError())
    const uncertainReport = await reconcileAgentWorkLedger(uncertain.port, {
      issueNumber: ISSUE,
      apply: true,
      record: completeRecord(),
    })
    expect(uncertainReport).toMatchObject({
      append: { outcome: 'uncertain', appended: null },
      diagnostics: ['append-outcome-uncertain'],
    })
    expect(agentWorkExitCode(uncertainReport)).toBe(2)
  })

  it('reports an uncertain append when its resolution read also fails', async () => {
    const privateFailure = 'SECRET resolution failure detail'
    const listCommentBodies = vi
      .fn<AgentWorkLedgerPort['listCommentBodies']>()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error(privateFailure))
    const appendComment = vi
      .fn<AgentWorkLedgerPort['appendComment']>()
      .mockRejectedValue(new AgentWorkAppendUncertainError())

    const report = await reconcileAgentWorkLedger(
      { listCommentBodies, appendComment },
      { issueNumber: ISSUE, apply: true, record: completeRecord() },
    )

    expect(report).toMatchObject({
      append: { outcome: 'uncertain', appended: null },
      ledger: { records: [] },
      plannedLedger: { records: [expect.objectContaining({ idempotencyKey: KEY_A })] },
      diagnostics: ['append-outcome-uncertain'],
    })
    expect(agentWorkExitCode(report)).toBe(2)
    expect(JSON.stringify(report)).not.toContain(privateFailure)
  })

  it('parses the named CLI input without accepting implicit mutation', () => {
    const record = JSON.stringify(completeRecord())
    expect(
      parseAgentWorkCliOptions(['--issue', `${ISSUE}`, '--append'], {
        HVIR_AGENT_WORK_RECORD: record,
      }),
    ).toMatchObject({ issueNumber: ISSUE, append: true, apply: false })
    expect(() =>
      parseAgentWorkCliOptions(['--issue', `${ISSUE}`, '--apply'], {}),
    ).toThrow('--apply requires --append, --project, or --rollup')
    expect(
      parseAgentWorkCliOptions(['--issue', `${ISSUE}`, '--project'], {}),
    ).toMatchObject({ issueNumber: ISSUE, project: true, apply: false })
    expect(
      parseAgentWorkCliOptions(['--issue', `${ISSUE}`, '--rollup'], {}),
    ).toMatchObject({ issueNumber: ISSUE, rollup: true, apply: false })
    expect(() =>
      parseAgentWorkCliOptions(['--issue', `${ISSUE}`, '--append', '--project'], {
        HVIR_AGENT_WORK_RECORD: record,
      }),
    ).toThrow('separate operations')
    expect(() =>
      parseAgentWorkCliOptions(['--issue', `${ISSUE}`, '--append'], {}),
    ).toThrow('requires HVIR_AGENT_WORK_RECORD')
    expect(() =>
      parseAgentWorkCliOptions(['--issue', `${ISSUE}`, '--append'], {
        HVIR_AGENT_WORK_RECORD: 'SECRET transcript text',
      }),
    ).toThrow('not valid JSON')
    try {
      parseAgentWorkCliOptions(['--issue', `${ISSUE}`, '--append'], {
        HVIR_AGENT_WORK_RECORD: 'SECRET transcript text',
      })
    } catch (error) {
      expect(error).not.toHaveProperty('message', expect.stringContaining('SECRET'))
    }
  })
})

function fakePort(bodies: string[]): {
  port: AgentWorkLedgerPort
  listCommentBodies: ReturnType<typeof vi.fn<AgentWorkLedgerPort['listCommentBodies']>>
  appendComment: ReturnType<typeof vi.fn<AgentWorkLedgerPort['appendComment']>>
} {
  const listCommentBodies = vi.fn<AgentWorkLedgerPort['listCommentBodies']>(() =>
    Promise.resolve([...bodies]),
  )
  const appendComment = vi.fn<AgentWorkLedgerPort['appendComment']>(
    (_issueNumber, body) => {
      bodies.push(body)
      return Promise.resolve()
    },
  )
  return {
    port: { listCommentBodies, appendComment },
    listCommentBodies,
    appendComment,
  }
}

function completeRecord(overrides: Partial<AgentWorkRecord> = {}): AgentWorkRecord {
  return parseAgentWorkRecord({
    schema: 1,
    issueNumber: ISSUE,
    phase: 'implementation',
    runKey: RUN_A,
    idempotencyKey: KEY_A,
    availability: 'complete',
    route: {
      initial: {
        harness: 'codex',
        modelId: 'gpt-5.6-sol',
        requestedReasoningEffort: 'xhigh',
        effectiveReasoningEffort: 'xhigh',
      },
      changes: [],
    },
    usage: usage(1, 2, 3, 4, 2),
    timing: { activeWallMilliseconds: 100, modelOrApiMilliseconds: 50 },
    outcome: { firstPass: 'pending', candidateRef: 'abcdef1' },
    ...overrides,
  })
}

function partialRecord(overrides: Partial<AgentWorkRecord> = {}): AgentWorkRecord {
  return parseAgentWorkRecord({
    ...completeRecord(overrides),
    availability: 'partial',
    usage: { freshInputTokens: 5 },
    missingFacts: [
      'cache-read-input-tokens',
      'cache-write-input-tokens',
      'output-tokens',
    ],
    ...overrides,
  })
}

function unavailableRecord(overrides: Partial<AgentWorkRecord> = {}): AgentWorkRecord {
  const base = completeRecord(overrides)
  return parseAgentWorkRecord({
    schema: 1,
    issueNumber: base.issueNumber,
    phase: base.phase,
    runKey: base.runKey,
    idempotencyKey: base.idempotencyKey,
    availability: 'unavailable',
    route: base.route,
    unavailableReason: 'snapshot-unavailable',
    outcome: base.outcome,
    ...(base.supersedes === undefined ? {} : { supersedes: base.supersedes }),
  })
}

function usage(
  freshInputTokens: number,
  cacheReadInputTokens: number,
  cacheWriteInputTokens: number,
  outputTokens: number,
  reasoningTokens: number,
): AgentWorkRecord['usage'] {
  return {
    freshInputTokens,
    cacheReadInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningTokens,
    normalizedTokenTotal:
      freshInputTokens + cacheReadInputTokens + cacheWriteInputTokens + outputTokens,
  }
}
