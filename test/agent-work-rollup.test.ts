import { describe, expect, it, vi } from 'vitest'

import {
  reconcileAgentWorkRollup,
  type AgentWorkRollupProjectPort,
  type AgentWorkRollupReport,
  type AgentWorkRollupSourcePort,
  type AgentWorkRollupTargetIssue,
} from '../scripts/project-management/agent-work-rollup.ts'
import {
  parseAgentWorkRecord,
  serializeAgentWorkComment,
  type AgentWorkCommentHistory,
  type AgentWorkRecord,
} from '../scripts/project-management/agent-work-ledger.ts'
import {
  AgentWorkProjectWriteError,
  type AgentWorkProjectValues,
} from '../scripts/project-management/agent-work-project-fields.ts'

const REPOSITORY = 'jarmak-personal/hvir'
const EPIC = 570
const CHILD_A = 571
const CHILD_B = 572
const COMMENT_TIME = '2026-08-17T12:00:00Z'

describe('agent-work epic Rollup reconciliation', () => {
  it('adds parent Own and each native direct child Own exactly once across closed state and supersession', async () => {
    const original = completeRecord(CHILD_B, 20, 'c', '3')
    const corrected = completeRecord(CHILD_B, 30, 'c', '4', {
      supersedes: original.idempotencyKey,
    })
    const fixture = rollupFixture({
      issues: [
        epicIssue({
          directChildren: [reference(CHILD_B), reference(CHILD_A), reference(CHILD_A)],
        }),
        childIssue(CHILD_A, { state: 'CLOSED' }),
        childIssue(CHILD_B, { state: 'OPEN' }),
      ],
      comments: new Map([
        [
          EPIC,
          [
            comment(completeRecord(EPIC, 40, 'd', '5', { phase: 'issue-planning' })),
            comment(
              completeRecord(EPIC, 100, 'a', '1', {
                phase: 'epic-coordination',
              }),
            ),
          ],
        ],
        [CHILD_A, [comment(completeRecord(CHILD_A, 10, 'b', '2'))]],
        [
          CHILD_B,
          [
            comment({ ...original, phase: 'implementation-review' }),
            comment({ ...corrected, phase: 'implementation-review' }),
          ],
        ],
      ]),
    })

    const report = await reconcileAgentWorkRollup(fixture.source, fixture.project, {
      issueNumber: EPIC,
      apply: false,
    })

    expect(report.source.directChildren).toEqual([CHILD_A, CHILD_B])
    expect(report.source.participants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          issueNumber: CHILD_A,
          state: 'CLOSED',
          normalizedTokenTotal: 10,
        }),
        expect.objectContaining({
          issueNumber: CHILD_B,
          state: 'OPEN',
          normalizedTokenTotal: 30,
        }),
      ]),
    )
    expect(report.rollup).toMatchObject({
      availability: 'complete',
      activeRuns: 4,
      contributingIssues: 3,
      knownTokenSubtotal: 180,
      normalizedTokenTotal: 180,
    })
    expect(report.rollup.phaseTotals).toEqual([
      {
        phase: 'issue-planning',
        total: {
          availability: 'complete',
          activeRuns: 1,
          knownTokenSubtotal: 40,
          normalizedTokenTotal: 40,
        },
      },
      {
        phase: 'implementation',
        total: {
          availability: 'complete',
          activeRuns: 1,
          knownTokenSubtotal: 10,
          normalizedTokenTotal: 10,
        },
      },
      {
        phase: 'implementation-review',
        total: {
          availability: 'complete',
          activeRuns: 1,
          knownTokenSubtotal: 30,
          normalizedTokenTotal: 30,
        },
      },
      {
        phase: 'epic-coordination',
        total: {
          availability: 'complete',
          activeRuns: 1,
          knownTokenSubtotal: 100,
          normalizedTokenTotal: 100,
        },
      },
    ])
    expect(report.projection.values).toEqual({
      'Planning tokens': 40,
      'Implementation tokens': 10,
      'Review tokens': 30,
      'Lifecycle tokens': 180,
      'Measurement coverage': 'Complete',
    })
    expect(report.projection).toMatchObject({
      outcome: 'would-update',
      preservedFields: [],
    })
    expect(report.projection.changes.map(({ field }) => field)).toEqual([
      'Planning tokens',
      'Implementation tokens',
      'Review tokens',
      'Lifecycle tokens',
      'Measurement coverage',
    ])
    expect(fixture.readRollupTarget).toHaveBeenCalledOnce()
    expect(fixture.readRollupParticipant).toHaveBeenCalledTimes(2)
    expect(fixture.readRollupParticipant).toHaveBeenCalledWith(CHILD_A)
    expect(fixture.readRollupParticipant).toHaveBeenCalledWith(CHILD_B)
  })

  it('reports missing and partial child Own totals without substituting zero', async () => {
    const partial = parseAgentWorkRecord({
      ...completeRecord(CHILD_B, 5, 'c', '3'),
      availability: 'partial',
      usage: { freshInputTokens: 5 },
      missingFacts: [
        'cache-read-input-tokens',
        'cache-write-input-tokens',
        'output-tokens',
      ],
    })
    const fixture = rollupFixture({
      currentProjection: {
        'Planning tokens': 11,
        'Review tokens': 22,
        'Lifecycle tokens': 999,
        'Measurement coverage': 'Complete',
      },
      issues: [
        epicIssue({ directChildren: [reference(CHILD_A), reference(CHILD_B)] }),
        childIssue(CHILD_A),
        childIssue(CHILD_B),
      ],
      comments: new Map([
        [
          EPIC,
          [comment(completeRecord(EPIC, 100, 'a', '1', { phase: 'epic-coordination' }))],
        ],
        [CHILD_A, []],
        [CHILD_B, [comment(partial)]],
      ]),
    })

    const report = await reconcileAgentWorkRollup(fixture.source, fixture.project, {
      issueNumber: EPIC,
      apply: false,
    })

    expect(report.rollup).toMatchObject({
      availability: 'partial',
      activeRuns: 2,
      contributingIssues: 3,
      knownTokenSubtotal: 105,
    })
    expect(report.rollup.phaseTotals).toHaveLength(4)
    expect(report.projection.values).toEqual({
      'Implementation tokens': 5,
      'Lifecycle tokens': 105,
      'Measurement coverage': 'Partial',
    })
    expect(report.projection).toMatchObject({
      outcome: 'would-update',
      preservedFields: [],
    })
    expect(report.projection.changes).toEqual([
      expect.objectContaining({ field: 'Planning tokens', operation: 'clear' }),
      expect.objectContaining({
        field: 'Implementation tokens',
        operation: 'set',
        value: 5,
      }),
      expect.objectContaining({ field: 'Review tokens', operation: 'clear' }),
      expect.objectContaining({
        field: 'Lifecycle tokens',
        operation: 'set',
        value: 105,
      }),
      expect.objectContaining({
        field: 'Measurement coverage',
        operation: 'set',
        value: 'Partial',
      }),
    ])
    expect(
      report.source.participants.find(({ issueNumber }) => issueNumber === CHILD_A),
    ).toMatchObject({
      availability: 'unavailable',
      activeRuns: 0,
    })
  })

  it('clears stale token subtotals and records unavailable when no safe subtotal exists', async () => {
    const fixture = rollupFixture({
      currentProjection: {
        'Planning tokens': 11,
        'Implementation tokens': 22,
        'Review tokens': 33,
        'Lifecycle tokens': 66,
        'Measurement coverage': 'Partial',
      },
      issues: [epicIssue({ directChildren: [reference(CHILD_A)] }), childIssue(CHILD_A)],
    })

    const report = await reconcileAgentWorkRollup(fixture.source, fixture.project, {
      issueNumber: EPIC,
      apply: false,
    })

    expect(report.rollup).toMatchObject({
      availability: 'unavailable',
      activeRuns: 0,
      contributingIssues: 2,
    })
    expect(report.projection.values).toEqual({
      'Measurement coverage': 'Unavailable',
    })
    expect(report.projection.changes).toHaveLength(5)
    expect(report.projection.changes.slice(0, 4)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: 'clear' }),
        expect.objectContaining({ operation: 'clear' }),
        expect.objectContaining({ operation: 'clear' }),
        expect.objectContaining({ operation: 'clear' }),
      ]),
    )
  })

  it('applies additional runs once and converges idempotently on retry', async () => {
    const fixture = rollupFixture({
      currentProjection: {
        'Implementation tokens': 10,
        'Lifecycle tokens': 110,
        'Measurement coverage': 'Complete',
      },
      issues: [epicIssue({ directChildren: [reference(CHILD_A)] }), childIssue(CHILD_A)],
      comments: new Map([
        [
          EPIC,
          [comment(completeRecord(EPIC, 100, 'a', '1', { phase: 'epic-coordination' }))],
        ],
        [
          CHILD_A,
          [
            comment(completeRecord(CHILD_A, 10, 'b', '2')),
            comment(completeRecord(CHILD_A, 5, 'c', '3')),
          ],
        ],
      ]),
    })

    const updated = await reconcileAgentWorkRollup(fixture.source, fixture.project, {
      issueNumber: EPIC,
      apply: true,
    })
    const retry = await reconcileAgentWorkRollup(fixture.source, fixture.project, {
      issueNumber: EPIC,
      apply: true,
    })

    expect(updated.projection).toMatchObject({
      outcome: 'updated',
      values: {
        'Implementation tokens': 15,
        'Lifecycle tokens': 115,
        'Measurement coverage': 'Complete',
      },
    })
    expect(updated.projection.changes).toEqual([
      expect.objectContaining({ field: 'Implementation tokens', outcome: 'updated' }),
      expect.objectContaining({ field: 'Lifecycle tokens', outcome: 'updated' }),
    ])
    expect(retry.projection).toMatchObject({ outcome: 'unchanged', changes: [] })
    expect(fixture.setField).toHaveBeenCalledTimes(2)
    expect(
      fixture.setField.mock.calls.every(([issueNumber]) => issueNumber === EPIC),
    ).toBe(true)
  })

  it('uses the shared content-free Project write classification', async () => {
    const fixture = rollupFixture({
      issues: [epicIssue()],
      comments: new Map([
        [
          EPIC,
          [comment(completeRecord(EPIC, 100, 'a', '1', { phase: 'epic-coordination' }))],
        ],
      ]),
    })
    fixture.setField.mockRejectedValue(new AgentWorkProjectWriteError('schema'))

    const report = await reconcileAgentWorkRollup(fixture.source, fixture.project, {
      issueNumber: EPIC,
      apply: true,
    })

    expect(report.projection.outcome).toBe('partial')
    expect(report.projection.changes[0]).toMatchObject({
      field: 'Lifecycle tokens',
      outcome: 'failed',
    })
    expect(report.projection.changes.slice(1)).toEqual(
      expect.arrayContaining([expect.objectContaining({ outcome: 'not-attempted' })]),
    )
    expect(report.diagnostics).toContain('project-write-schema-invalid')
    expect(report.diagnostics).not.toContain('project-write-failed')
  })

  it('preserves issue-owned measurement fields on ordinary issues and epic children', async () => {
    for (const issue of [ordinaryIssue(600), childIssue(CHILD_A)]) {
      const fixture = rollupFixture({
        currentProjection: projectedValues(42),
        issues: [issue],
      })
      const report = await reconcileAgentWorkRollup(fixture.source, fixture.project, {
        issueNumber: issue.number,
        apply: true,
      })

      expect(report.source.eligibility).toBe(
        issue.parent === null ? 'ordinary' : 'epic-child',
      )
      expect(report.projection).toEqual({
        outcome: 'unchanged',
        changes: [],
        values: projectedValues(42),
        preservedFields: [
          'Planning tokens',
          'Implementation tokens',
          'Review tokens',
          'Lifecycle tokens',
          'Measurement coverage',
        ],
      })
      expect(fixture.setField).not.toHaveBeenCalled()
    }
  })

  it('preserves Rollup on a nested-epic target without writing the Project', async () => {
    const fixture = rollupFixture({
      currentProjection: projectedValues(42),
      issues: [childIssue(CHILD_A, { kind: 'epic' })],
    })

    const report = await reconcileAgentWorkRollup(fixture.source, fixture.project, {
      issueNumber: CHILD_A,
      apply: true,
    })

    expect(report.source.eligibility).toBe('nested-epic')
    expect(report.diagnostics).toEqual(['nested-epic'])
    expectPreservedProjection(report.projection, 42)
    expect(fixture.setField).not.toHaveBeenCalled()
  })

  it('rejects nested descendants instead of recursively aggregating them', async () => {
    const nested = childIssue(CHILD_A, {
      kind: 'epic',
      directChildren: [reference(599)],
    })
    const fixture = rollupFixture({
      currentProjection: projectedValues(42),
      issues: [epicIssue({ directChildren: [reference(CHILD_A)] }), nested],
    })

    const report = await reconcileAgentWorkRollup(fixture.source, fixture.project, {
      issueNumber: EPIC,
      apply: true,
    })

    expect(report.diagnostics).toEqual(
      expect.arrayContaining(['nested-epic', 'nested-descendants']),
    )
    expectPreservedProjection(report.projection, 42)
    expect(fixture.setField).not.toHaveBeenCalled()
  })

  it('rejects cross-repository children before reading a same-number local issue', async () => {
    const fixture = rollupFixture({
      currentProjection: projectedValues(42),
      issues: [
        epicIssue({
          directChildren: [{ number: CHILD_A, repository: 'someone/else' }],
        }),
      ],
    })

    const report = await reconcileAgentWorkRollup(fixture.source, fixture.project, {
      issueNumber: EPIC,
      apply: true,
    })

    expect(report.diagnostics).toEqual(['cross-repository-child'])
    expectPreservedProjection(report.projection, 42)
    expect(fixture.readRollupTarget).toHaveBeenCalledTimes(1)
    expect(fixture.readRollupParticipant).not.toHaveBeenCalled()
  })

  it('preserves a Rollup when kind authority is ambiguous', async () => {
    const fixture = rollupFixture({
      currentProjection: projectedValues(42),
      issues: [ordinaryIssue(600, { kind: 'invalid' })],
    })

    const report = await reconcileAgentWorkRollup(fixture.source, fixture.project, {
      issueNumber: 600,
      apply: true,
    })

    expect(report.diagnostics).toEqual(['target-kind-invalid'])
    expectPreservedProjection(report.projection, 42)
  })

  it('preserves the current projection when aggregate overflow makes evidence unsafe', async () => {
    const fixture = rollupFixture({
      currentProjection: projectedValues(42),
      issues: [epicIssue({ directChildren: [reference(CHILD_A)] }), childIssue(CHILD_A)],
      comments: new Map([
        [
          EPIC,
          [
            comment(
              completeRecord(EPIC, Number.MAX_SAFE_INTEGER, 'a', '1', {
                phase: 'epic-coordination',
              }),
            ),
          ],
        ],
        [CHILD_A, [comment(completeRecord(CHILD_A, 1, 'b', '2'))]],
      ]),
    })

    const report = await reconcileAgentWorkRollup(fixture.source, fixture.project, {
      issueNumber: EPIC,
      apply: false,
    })

    expect(report.diagnostics).toContain('rollup-aggregate-overflow')
    expect(report.rollup).not.toHaveProperty('normalizedTokenTotal')
    expectPreservedProjection(report.projection, 42)
  })

  it('rejects parent-only coordination records attributed to a child', async () => {
    const fixture = rollupFixture({
      currentProjection: projectedValues(42),
      issues: [epicIssue({ directChildren: [reference(CHILD_A)] }), childIssue(CHILD_A)],
      comments: new Map([
        [
          EPIC,
          [comment(completeRecord(EPIC, 100, 'a', '1', { phase: 'epic-coordination' }))],
        ],
        [
          CHILD_A,
          [
            comment(
              completeRecord(CHILD_A, 10, 'b', '2', {
                phase: 'epic-coordination',
              }),
            ),
          ],
        ],
      ]),
    })

    const report = await reconcileAgentWorkRollup(fixture.source, fixture.project, {
      issueNumber: EPIC,
      apply: true,
    })

    expect(report.diagnostics).toContain('child-coordination-record')
    expectPreservedProjection(report.projection, 42)
    expect(fixture.setField).not.toHaveBeenCalled()
  })
})

function rollupFixture(input: {
  currentProjection?: AgentWorkProjectValues
  issues: AgentWorkRollupTargetIssue[]
  comments?: Map<number, string[]>
}): {
  source: AgentWorkRollupSourcePort
  project: AgentWorkRollupProjectPort
  setField: ReturnType<
    typeof vi.fn<AgentWorkRollupProjectPort['setAgentWorkProjectionField']>
  >
  readRollupTarget: ReturnType<
    typeof vi.fn<AgentWorkRollupSourcePort['readRollupTarget']>
  >
  readRollupParticipant: ReturnType<
    typeof vi.fn<AgentWorkRollupSourcePort['readRollupParticipant']>
  >
} {
  const issues = new Map(input.issues.map((issue) => [issue.number, issue]))
  const values: AgentWorkProjectValues = { ...input.currentProjection }
  const setField = vi.fn<AgentWorkRollupProjectPort['setAgentWorkProjectionField']>(
    (_issue, field, value) => {
      if (value === undefined) delete values[field]
      else values[field] = value
      return Promise.resolve()
    },
  )
  const readRollupTarget = vi.fn<AgentWorkRollupSourcePort['readRollupTarget']>(
    (issueNumber) => {
      const issue = issues.get(issueNumber)
      if (issue === undefined) throw new Error('missing fixture issue')
      return Promise.resolve(issue)
    },
  )
  const readRollupParticipant = vi.fn<AgentWorkRollupSourcePort['readRollupParticipant']>(
    (issueNumber) => {
      const issue = issues.get(issueNumber)
      if (issue === undefined) throw new Error('missing fixture issue')
      return Promise.resolve(issue)
    },
  )
  const readCommentHistory = vi.fn<AgentWorkRollupSourcePort['readCommentHistory']>(
    (issueNumber) =>
      Promise.resolve(commentHistory(input.comments?.get(issueNumber) ?? [])),
  )
  return {
    source: {
      readRollupTarget,
      readRollupParticipant,
      readCommentHistory,
    },
    project: {
      readAgentWorkProjection: vi.fn(() => Promise.resolve({ ...values })),
      setAgentWorkProjectionField: setField,
    },
    setField,
    readRollupTarget,
    readRollupParticipant,
  }
}

function commentHistory(bodies: readonly string[]): AgentWorkCommentHistory {
  return {
    trustedActor: 'jarmak-personal',
    comments: bodies.map((body) => ({
      body,
      authorLogin: 'jarmak-personal',
      createdAt: COMMENT_TIME,
      updatedAt: COMMENT_TIME,
    })),
  }
}

function projectedValues(lifecycle: number): AgentWorkProjectValues {
  return {
    'Planning tokens': 1,
    'Implementation tokens': 2,
    'Review tokens': 3,
    'Lifecycle tokens': lifecycle,
    'Measurement coverage': 'Complete',
  }
}

function expectPreservedProjection(
  projection: AgentWorkRollupReport['projection'],
  lifecycle: number,
): void {
  expect(projection).toEqual({
    outcome: 'unchanged',
    changes: [],
    values: projectedValues(lifecycle),
    preservedFields: [
      'Planning tokens',
      'Implementation tokens',
      'Review tokens',
      'Lifecycle tokens',
      'Measurement coverage',
    ],
  })
}

function epicIssue(
  overrides: Partial<AgentWorkRollupTargetIssue> = {},
): AgentWorkRollupTargetIssue {
  return rollupIssue({
    number: EPIC,
    repository: REPOSITORY,
    state: 'OPEN',
    kind: 'epic',
    parent: null,
    directChildren: [],
    ...overrides,
  })
}

function ordinaryIssue(
  number: number,
  overrides: Partial<AgentWorkRollupTargetIssue> = {},
): AgentWorkRollupTargetIssue {
  return rollupIssue({
    number,
    repository: REPOSITORY,
    state: 'OPEN',
    kind: 'other',
    parent: null,
    directChildren: [],
    ...overrides,
  })
}

function childIssue(
  number: number,
  overrides: Partial<AgentWorkRollupTargetIssue> = {},
): AgentWorkRollupTargetIssue {
  return rollupIssue({
    number,
    repository: REPOSITORY,
    state: 'OPEN',
    kind: 'other',
    parent: reference(EPIC),
    directChildren: [],
    ...overrides,
  })
}

function rollupIssue(
  issue: Omit<AgentWorkRollupTargetIssue, 'hasDirectChildren'> & {
    hasDirectChildren?: boolean
  },
): AgentWorkRollupTargetIssue {
  return {
    ...issue,
    hasDirectChildren: issue.hasDirectChildren ?? issue.directChildren.length > 0,
  }
}

function reference(number: number): { number: number; repository: string } {
  return { number, repository: REPOSITORY }
}

function completeRecord(
  issueNumber: number,
  total: number,
  runCharacter: string,
  keyCharacter: string,
  overrides: Partial<AgentWorkRecord> = {},
): AgentWorkRecord {
  return parseAgentWorkRecord({
    schema: 1,
    issueNumber,
    phase: 'implementation',
    runKey: runCharacter.repeat(64),
    idempotencyKey: keyCharacter.repeat(64),
    availability: 'complete',
    route: { initial: { harness: 'codex' }, changes: [] },
    usage: {
      freshInputTokens: total,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      normalizedTokenTotal: total,
    },
    ...overrides,
  })
}

function comment(record: AgentWorkRecord): string {
  return serializeAgentWorkComment(record)
}
