import { describe, expect, it, vi } from 'vitest'

import { agentWorkExitCode } from '../scripts/project-management/agent-work-cli.ts'
import { AgentWorkProjectWriteError } from '../scripts/project-management/agent-work-project-fields.ts'
import {
  deriveAgentWorkProjection,
  reconcileAgentWorkProjection,
  type AgentWorkProjectPort,
  type AgentWorkProjectionSourcePort,
} from '../scripts/project-management/agent-work-projector.ts'
import {
  normalizeAgentWorkComments,
  parseAgentWorkRecord,
  serializeAgentWorkComment,
  type AgentWorkRecord,
} from '../scripts/project-management/agent-work-ledger.ts'

const ISSUE = 574
const RUN_A = 'a'.repeat(64)
const RUN_B = 'b'.repeat(64)
const KEY_A = '1'.repeat(64)
const KEY_B = '2'.repeat(64)

describe('agent-work Project derivation', () => {
  it('projects the validated forecast and every ledger-owned field type', () => {
    const planning = completeRecord({
      phase: 'issue-planning',
      runKey: RUN_A,
      idempotencyKey: KEY_A,
      usage: usage(10, 20, 30, 40),
      timing: { activeWallMilliseconds: 50 },
      outcome: undefined,
    })
    const implementation = completeRecord({
      runKey: RUN_B,
      idempotencyKey: KEY_B,
      usage: usage(1, 2, 3, 4),
      route: {
        initial: {
          harness: 'codex',
          modelId: 'gpt-5.6-sol',
          requestedReasoningEffort: 'high',
          effectiveReasoningEffort: 'xhigh',
        },
        changes: [
          {
            sequence: 1,
            escalation: true,
            modelId: 'gpt-6',
            effectiveReasoningEffort: 'xhigh',
          },
        ],
      },
      timing: {
        activeWallMilliseconds: 100,
        timeToFirstCandidateMilliseconds: 90,
      },
      outcome: { firstPass: 'accepted', candidateRef: 'abcdef1' },
    })
    const ledger = normalizeAgentWorkComments(ISSUE, [
      serializeAgentWorkComment(planning),
      serializeAgentWorkComment(implementation),
    ])

    expect(deriveAgentWorkProjection(forecastBody(), ledger)).toEqual({
      forecast: 'available',
      diagnostics: [],
      preservedFields: [],
      values: {
        'Agent difficulty': 3,
        Risk: 'Moderate',
        'Estimate confidence': 'High',
        'Initial model': 'gpt-5.6-sol',
        'Reasoning effort': 'xhigh',
        'Model route':
          'codex:gpt-5.6-sol@xhigh | codex:gpt-5.6-sol@xhigh -> escalated:gpt-6@xhigh',
        'Planning tokens': 100,
        'Implementation tokens': 10,
        'Own lifecycle tokens': 110,
        'Time to first candidate (ms)': 90,
        'First-pass outcome': 'Accepted',
      },
    })
  })

  it('omits exact totals for partial evidence and validates the anchored rubric', () => {
    const partial = parseAgentWorkRecord({
      ...completeRecord(),
      availability: 'partial',
      usage: { freshInputTokens: 5 },
      missingFacts: [
        'cache-read-input-tokens',
        'cache-write-input-tokens',
        'output-tokens',
      ],
    })
    const ledger = normalizeAgentWorkComments(ISSUE, [serializeAgentWorkComment(partial)])
    const result = deriveAgentWorkProjection(
      forecastBody().replace('Agent difficulty: 3/5', 'Agent difficulty: 5/5'),
      ledger,
    )

    expect(result.forecast).toBe('invalid')
    expect(result.diagnostics).toEqual(['invalid-forecast'])
    expect(result.values).not.toHaveProperty('Agent difficulty')
    expect(result.values).not.toHaveProperty('Implementation tokens')
    expect(result.values).not.toHaveProperty('Own lifecycle tokens')
    expect(result.values['Initial model']).toBe('gpt-5.6-sol')
  })

  it('keeps first-pass rework sticky across active runs', () => {
    const first = completeRecord({
      outcome: { firstPass: 'pending', candidateRef: 'abcdef1' },
    })
    const correction = completeRecord({
      runKey: RUN_B,
      idempotencyKey: KEY_B,
      outcome: { firstPass: 'rework-required', candidateRef: 'abcdef2' },
    })
    const values = deriveAgentWorkProjection(
      '',
      normalizeAgentWorkComments(ISSUE, [
        serializeAgentWorkComment(first),
        serializeAgentWorkComment(correction),
      ]),
    ).values

    expect(values['First-pass outcome']).toBe('Rework required')
  })

  it('projects the latest valid pre-implementation revision without erasing the initial section', () => {
    const revised = `${forecastBody()}\n\n## Pre-implementation forecast revision\n\n- Agent difficulty: 4/5\n- Reasoning novelty: 2/2\n- Ownership breadth: 2/2\n- Lifecycle/integration burden: 1/2\n- Validation burden: 1/2\n- Risk: High\n- Estimate confidence: Medium`
    const values = deriveAgentWorkProjection(
      revised,
      normalizeAgentWorkComments(ISSUE, []),
    ).values

    expect(values).toMatchObject({
      'Agent difficulty': 4,
      Risk: 'High',
      'Estimate confidence': 'Medium',
    })
  })
})

describe('agent-work Project reconciliation', () => {
  it('plans fixed set and clear operations without mutation', async () => {
    const fixture = projectorFixture({
      'Agent difficulty': 2,
      'Planning tokens': 999,
      'Epic rollup tokens': 500,
    })
    const report = await reconcileAgentWorkProjection(fixture.source, fixture.project, {
      issueNumber: ISSUE,
      apply: false,
    })

    expect(report.projection.outcome).toBe('would-update')
    expect(report.projection.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'Agent difficulty',
          type: 'number',
          operation: 'set',
          value: 3,
        }),
        expect.objectContaining({
          field: 'Planning tokens',
          operation: 'clear',
        }),
        expect.objectContaining({
          field: 'Risk',
          type: 'single-select',
          value: 'Moderate',
        }),
      ]),
    )
    expect(report.projection.changes).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'Epic rollup tokens' })]),
    )
    expect(fixture.setField).not.toHaveBeenCalled()
  })

  it('applies sequentially, reports partial failure, and converges on retry', async () => {
    const current: Record<string, string | number> = {}
    const fixture = projectorFixture(current)
    fixture.setField.mockImplementation((_issue, field, value) => {
      if (field === 'Risk') throw new Error('private permission detail')
      if (value === undefined) delete current[field]
      else current[field] = value
      return Promise.resolve()
    })

    const partial = await reconcileAgentWorkProjection(fixture.source, fixture.project, {
      issueNumber: ISSUE,
      apply: true,
    })
    expect(partial.projection.outcome).toBe('partial')
    expect(partial.diagnostics).toContain('project-write-failed')
    expect(JSON.stringify(partial)).not.toContain('private permission detail')

    fixture.setField.mockImplementation((_issue, field, value) => {
      if (value === undefined) delete current[field]
      else current[field] = value
      return Promise.resolve()
    })
    const retry = await reconcileAgentWorkProjection(fixture.source, fixture.project, {
      issueNumber: ISSUE,
      apply: true,
    })
    const noop = await reconcileAgentWorkProjection(fixture.source, fixture.project, {
      issueNumber: ISSUE,
      apply: true,
    })

    expect(retry.projection.outcome).toBe('updated')
    expect(noop.projection).toMatchObject({ outcome: 'unchanged', changes: [] })
  })

  it('classifies redacted write failures separately from generic failure', async () => {
    for (const [failure, diagnostic] of [
      ['permission', 'project-write-permission-denied'],
      ['schema', 'project-write-schema-invalid'],
      ['transport', 'project-write-transport-failed'],
    ] as const) {
      const classified = projectorFixture({})
      classified.setField.mockRejectedValue(new AgentWorkProjectWriteError(failure))

      const report = await reconcileAgentWorkProjection(
        classified.source,
        classified.project,
        { issueNumber: ISSUE, apply: true },
      )

      expect(report.diagnostics).toContain(diagnostic)
      expect(report.diagnostics).not.toContain('project-write-failed')
    }

    const generic = projectorFixture({})
    generic.setField.mockRejectedValue(new Error('private generic response'))
    const genericReport = await reconcileAgentWorkProjection(
      generic.source,
      generic.project,
      { issueNumber: ISSUE, apply: true },
    )

    expect(genericReport.diagnostics).toContain('project-write-failed')
    expect(JSON.stringify(genericReport)).not.toContain('private generic response')
  })

  it('preserves current forecast fields when a revision is malformed', async () => {
    const fixture = projectorFixture({
      'Agent difficulty': 3,
      Risk: 'Moderate',
      'Estimate confidence': 'High',
      'Planning tokens': 999,
    })
    fixture.readIssueBody.mockResolvedValue(
      `${forecastBody()}\n\n## Pre-implementation forecast revision\n\n- Agent difficulty: 5/5`,
    )

    const report = await reconcileAgentWorkProjection(fixture.source, fixture.project, {
      issueNumber: ISSUE,
      apply: false,
    })

    expect(report.diagnostics).toContain('invalid-forecast')
    expect(report.projection.preservedFields).toEqual(
      expect.arrayContaining(['Agent difficulty', 'Risk', 'Estimate confidence']),
    )
    expect(report.projection.changes).toEqual([
      expect.objectContaining({ field: 'Planning tokens', operation: 'clear' }),
    ])
  })

  it('preserves the current route when the derived route is too large', async () => {
    const routeChanges = Array.from({ length: 10 }, (_, index) => ({
      sequence: index + 1,
      escalation: index % 2 === 0,
      modelId: `model-${index}-${'x'.repeat(110)}`,
    }))
    const record = completeRecord({
      route: {
        initial: { harness: 'codex', modelId: 'initial-model' },
        changes: routeChanges,
      },
    })
    const fixture = projectorFixture({ 'Model route': 'known-good-route' })
    fixture.listCommentBodies.mockResolvedValue([serializeAgentWorkComment(record)])

    const report = await reconcileAgentWorkProjection(fixture.source, fixture.project, {
      issueNumber: ISSUE,
      apply: false,
    })

    expect(report.diagnostics).toContain('model-route-too-large')
    expect(report.projection.preservedFields).toContain('Model route')
    expect(report.projection.values).not.toHaveProperty('Model route')
    expect(report.projection.changes).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'Model route' })]),
    )
  })

  it('reports aggregate overflow and does not present ledger values as exact', async () => {
    const maximum = completeRecord({
      usage: usage(Number.MAX_SAFE_INTEGER, 0, 0, 0),
    })
    const one = completeRecord({
      runKey: RUN_B,
      idempotencyKey: KEY_B,
      usage: usage(1, 0, 0, 0),
    })
    const fixture = projectorFixture({
      'Implementation tokens': 42,
      'Own lifecycle tokens': 42,
    })
    fixture.listCommentBodies.mockResolvedValue([
      serializeAgentWorkComment(maximum),
      serializeAgentWorkComment(one),
    ])

    const report = await reconcileAgentWorkProjection(fixture.source, fixture.project, {
      issueNumber: ISSUE,
      apply: false,
    })

    expect(report.diagnostics).toContain('ledger-aggregate-overflow')
    expect(agentWorkExitCode(report)).toBe(2)
    expect(report.projection.values).not.toHaveProperty('Implementation tokens')
    expect(report.projection.values).not.toHaveProperty('Own lifecycle tokens')
    expect(report.projection.preservedFields).toEqual(
      expect.arrayContaining(['Implementation tokens', 'Own lifecycle tokens']),
    )
    expect(report.projection.changes).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'Implementation tokens' }),
        expect.objectContaining({ field: 'Own lifecycle tokens' }),
      ]),
    )
  })

  it('reports malformed and conflicting records without leaking or clearing ledger fields', async () => {
    const original = completeRecord()
    const conflict = completeRecord({
      outcome: { firstPass: 'accepted', candidateRef: 'abcdef2' },
    })
    const fixture = projectorFixture({
      'Initial model': 'known-model',
      'Implementation tokens': 10,
    })
    fixture.listCommentBodies.mockResolvedValue([
      '<!-- hvir-agent-work-measurement:v1 -->\nprivate malformed body',
      serializeAgentWorkComment(original),
      serializeAgentWorkComment(conflict),
    ])

    const report = await reconcileAgentWorkProjection(fixture.source, fixture.project, {
      issueNumber: ISSUE,
      apply: false,
    })

    expect(report.diagnostics).toEqual(
      expect.arrayContaining(['ledger-invalid-record', 'ledger-idempotency-conflict']),
    )
    expect(agentWorkExitCode(report)).toBe(2)
    expect(report.projection.values).not.toHaveProperty('Initial model')
    expect(report.projection.values).not.toHaveProperty('Implementation tokens')
    expect(report.projection.changes).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'Initial model' }),
        expect.objectContaining({ field: 'Implementation tokens' }),
      ]),
    )
    expect(JSON.stringify(report)).not.toContain('private malformed body')
  })
})

function projectorFixture(current: Record<string, string | number>): {
  source: AgentWorkProjectionSourcePort
  project: AgentWorkProjectPort
  setField: ReturnType<typeof vi.fn<AgentWorkProjectPort['setAgentWorkProjectionField']>>
  readIssueBody: ReturnType<typeof vi.fn<AgentWorkProjectionSourcePort['readIssueBody']>>
  listCommentBodies: ReturnType<
    typeof vi.fn<AgentWorkProjectionSourcePort['listCommentBodies']>
  >
} {
  const setField = vi.fn<AgentWorkProjectPort['setAgentWorkProjectionField']>(
    (_issue, field, value) => {
      if (value === undefined) delete current[field]
      else current[field] = value
      return Promise.resolve()
    },
  )
  const readIssueBody = vi.fn(() => Promise.resolve(forecastBody()))
  const listCommentBodies = vi.fn(() => Promise.resolve<string[]>([]))
  return {
    source: {
      readIssueBody,
      listCommentBodies,
    },
    project: {
      readAgentWorkProjection: vi.fn(() => Promise.resolve({ ...current })),
      setAgentWorkProjectionField: setField,
    },
    setField,
    readIssueBody,
    listCommentBodies,
  }
}

function forecastBody(): string {
  return `## Initial forecast

Provisional bootstrap estimate:

- Agent difficulty: 3/5
- Reasoning novelty: 1/2
- Ownership breadth: 1/2
- Lifecycle/integration burden: 1/2
- Validation burden: 1/2
- Risk: Moderate
- Estimate confidence: High

## Desired outcome

Safe prose that is not projected.`
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
    usage: usage(1, 2, 3, 4),
    timing: { activeWallMilliseconds: 100 },
    outcome: { firstPass: 'pending', candidateRef: 'abcdef1' },
    ...overrides,
  })
}

function usage(
  freshInputTokens: number,
  cacheReadInputTokens: number,
  cacheWriteInputTokens: number,
  outputTokens: number,
): AgentWorkRecord['usage'] {
  return {
    freshInputTokens,
    cacheReadInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    normalizedTokenTotal:
      freshInputTokens + cacheReadInputTokens + cacheWriteInputTokens + outputTokens,
  }
}
