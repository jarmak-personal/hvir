import { describe, expect, it, vi } from 'vitest'

import {
  reconcileAgentWorkRollup,
  type AgentWorkRollupIssue,
  type AgentWorkRollupProjectPort,
  type AgentWorkRollupSourcePort,
} from '../scripts/project-management/agent-work-rollup.ts'
import {
  parseAgentWorkRecord,
  serializeAgentWorkComment,
  type AgentWorkRecord,
} from '../scripts/project-management/agent-work-ledger.ts'

const REPOSITORY = 'jarmak-personal/hvir'
const EPIC = 570
const CHILD_A = 571
const CHILD_B = 572

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
          [comment(completeRecord(EPIC, 100, 'a', '1', { phase: 'epic-coordination' }))],
        ],
        [CHILD_A, [comment(completeRecord(CHILD_A, 10, 'b', '2'))]],
        [CHILD_B, [comment(original), comment(corrected)]],
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
    expect(report.rollup).toEqual({
      availability: 'complete',
      contributingIssues: 3,
      knownTokenSubtotal: 140,
      normalizedTokenTotal: 140,
    })
    expect(report.projection).toEqual({
      outcome: 'would-update',
      operation: 'set',
      value: 140,
    })
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
      currentRollup: 999,
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

    expect(report.rollup).toEqual({
      availability: 'partial',
      contributingIssues: 3,
      knownTokenSubtotal: 105,
    })
    expect(report.projection).toEqual({
      outcome: 'would-update',
      operation: 'clear',
    })
    expect(
      report.source.participants.find(({ issueNumber }) => issueNumber === CHILD_A),
    ).toMatchObject({
      availability: 'unavailable',
      activeRuns: 0,
    })
  })

  it('applies additional runs once and converges idempotently on retry', async () => {
    const fixture = rollupFixture({
      currentRollup: 110,
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

    expect(updated.projection).toEqual({
      outcome: 'updated',
      operation: 'set',
      value: 115,
    })
    expect(retry.projection).toEqual({ outcome: 'unchanged', operation: 'none' })
    expect(fixture.setField).toHaveBeenCalledTimes(1)
  })

  it('clears Rollup from ordinary issues and epic children', async () => {
    for (const issue of [ordinaryIssue(600), childIssue(CHILD_A)]) {
      const fixture = rollupFixture({ currentRollup: 42, issues: [issue] })
      const report = await reconcileAgentWorkRollup(fixture.source, fixture.project, {
        issueNumber: issue.number,
        apply: true,
      })

      expect(report.source.eligibility).toBe(
        issue.parent === null ? 'ordinary' : 'epic-child',
      )
      expect(report.projection).toEqual({ outcome: 'updated', operation: 'clear' })
    }
  })

  it('preserves Rollup on a nested-epic target without writing the Project', async () => {
    const fixture = rollupFixture({
      currentRollup: 42,
      issues: [childIssue(CHILD_A, { kind: 'epic' })],
    })

    const report = await reconcileAgentWorkRollup(fixture.source, fixture.project, {
      issueNumber: CHILD_A,
      apply: true,
    })

    expect(report.source.eligibility).toBe('nested-epic')
    expect(report.diagnostics).toEqual(['nested-epic'])
    expect(report.projection).toEqual({ outcome: 'unchanged', operation: 'preserve' })
    expect(fixture.setField).not.toHaveBeenCalled()
  })

  it('rejects nested descendants instead of recursively aggregating them', async () => {
    const nested = childIssue(CHILD_A, {
      kind: 'epic',
      directChildren: [reference(599)],
    })
    const fixture = rollupFixture({
      currentRollup: 42,
      issues: [epicIssue({ directChildren: [reference(CHILD_A)] }), nested],
    })

    const report = await reconcileAgentWorkRollup(fixture.source, fixture.project, {
      issueNumber: EPIC,
      apply: true,
    })

    expect(report.diagnostics).toEqual(
      expect.arrayContaining(['nested-epic', 'nested-descendants']),
    )
    expect(report.projection).toEqual({ outcome: 'unchanged', operation: 'preserve' })
    expect(fixture.setField).not.toHaveBeenCalled()
  })

  it('rejects cross-repository children before reading a same-number local issue', async () => {
    const fixture = rollupFixture({
      currentRollup: 42,
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
    expect(report.projection).toEqual({ outcome: 'unchanged', operation: 'preserve' })
    expect(fixture.readRollupIssue).toHaveBeenCalledTimes(1)
  })

  it('preserves a Rollup when kind authority is ambiguous', async () => {
    const fixture = rollupFixture({
      currentRollup: 42,
      issues: [ordinaryIssue(600, { kind: 'invalid' })],
    })

    const report = await reconcileAgentWorkRollup(fixture.source, fixture.project, {
      issueNumber: 600,
      apply: true,
    })

    expect(report.diagnostics).toEqual(['target-kind-invalid'])
    expect(report.projection).toEqual({ outcome: 'unchanged', operation: 'preserve' })
  })

  it('preserves the current projection when aggregate overflow makes evidence unsafe', async () => {
    const fixture = rollupFixture({
      currentRollup: 42,
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
    expect(report.projection).toEqual({ outcome: 'unchanged', operation: 'preserve' })
  })

  it('rejects parent-only coordination records attributed to a child', async () => {
    const fixture = rollupFixture({
      currentRollup: 42,
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
    expect(report.projection).toEqual({ outcome: 'unchanged', operation: 'preserve' })
    expect(fixture.setField).not.toHaveBeenCalled()
  })
})

function rollupFixture(input: {
  currentRollup?: number
  issues: AgentWorkRollupIssue[]
  comments?: Map<number, string[]>
}): {
  source: AgentWorkRollupSourcePort
  project: AgentWorkRollupProjectPort
  setField: ReturnType<
    typeof vi.fn<AgentWorkRollupProjectPort['setAgentWorkProjectionField']>
  >
  readRollupIssue: ReturnType<typeof vi.fn<AgentWorkRollupSourcePort['readRollupIssue']>>
} {
  const issues = new Map(input.issues.map((issue) => [issue.number, issue]))
  const values: { 'Epic rollup tokens'?: number } = {
    ...(input.currentRollup === undefined
      ? {}
      : { 'Epic rollup tokens': input.currentRollup }),
  }
  const setField = vi.fn<AgentWorkRollupProjectPort['setAgentWorkProjectionField']>(
    (_issue, _field, value) => {
      if (value === undefined) delete values['Epic rollup tokens']
      else values['Epic rollup tokens'] = value
      return Promise.resolve()
    },
  )
  const readRollupIssue = vi.fn<AgentWorkRollupSourcePort['readRollupIssue']>(
    (issueNumber) => {
      const issue = issues.get(issueNumber)
      if (issue === undefined) throw new Error('missing fixture issue')
      return Promise.resolve(issue)
    },
  )
  const listCommentBodies = vi.fn<AgentWorkRollupSourcePort['listCommentBodies']>(
    (issueNumber) => Promise.resolve(input.comments?.get(issueNumber) ?? []),
  )
  return {
    source: {
      readRollupIssue,
      listCommentBodies,
    },
    project: {
      readAgentWorkProjection: vi.fn(() => Promise.resolve({ ...values })),
      setAgentWorkProjectionField: setField,
    },
    setField,
    readRollupIssue,
  }
}

function epicIssue(overrides: Partial<AgentWorkRollupIssue> = {}): AgentWorkRollupIssue {
  return {
    number: EPIC,
    repository: REPOSITORY,
    state: 'OPEN',
    kind: 'epic',
    parent: null,
    directChildren: [],
    ...overrides,
  }
}

function ordinaryIssue(
  number: number,
  overrides: Partial<AgentWorkRollupIssue> = {},
): AgentWorkRollupIssue {
  return {
    number,
    repository: REPOSITORY,
    state: 'OPEN',
    kind: 'other',
    parent: null,
    directChildren: [],
    ...overrides,
  }
}

function childIssue(
  number: number,
  overrides: Partial<AgentWorkRollupIssue> = {},
): AgentWorkRollupIssue {
  return {
    number,
    repository: REPOSITORY,
    state: 'OPEN',
    kind: 'other',
    parent: reference(EPIC),
    directChildren: [],
    ...overrides,
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
