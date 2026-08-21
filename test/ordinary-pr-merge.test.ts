import { describe, expect, it, vi } from 'vitest'

import {
  normalizeAgentWorkComments,
  serializeAgentWorkComment,
  type AgentWorkComment,
  type AgentWorkRecord,
} from '../scripts/project-management/agent-work-ledger.ts'
import type {
  AgentWorkProjectFieldName,
  AgentWorkProjectValue,
  AgentWorkProjectValues,
} from '../scripts/project-management/agent-work-project-fields.ts'
import type { AgentWorkProjectionIssue } from '../scripts/project-management/agent-work-projector.ts'
import { parseOrdinaryPullRequestMergeCliOptions } from '../scripts/project-management/ordinary-pr-merge-cli.ts'
import {
  reconcileOrdinaryPullRequestMerge,
  type OrdinaryMergePullRequest,
  type OrdinaryPullRequestMergeDiagnostic,
  type OrdinaryPullRequestMergePorts,
} from '../scripts/project-management/ordinary-pr-merge.ts'
import type {
  NormalizedPlanningRecord,
  PlanningRecordReport,
} from '../scripts/project-management/planning-record.ts'

const candidate = 'a'.repeat(40)
const mergeCommit = 'b'.repeat(40)
const repository = 'jarmak-personal/hvir'

interface FixtureOptions {
  pullRequest?: Partial<OrdinaryMergePullRequest>
  issue?: Partial<NormalizedPlanningRecord['issue']>
  projectStatus?: string | null
  records?: AgentWorkRecord[]
  mergeOutcome?: 'merged' | 'rejected' | 'uncertain'
  closeOnMerge?: boolean
  projectionFailure?: boolean
}

function fixture(options: FixtureOptions = {}): {
  ports: OrdinaryPullRequestMergePorts
  pullRequest: OrdinaryMergePullRequest
  planning: NormalizedPlanningRecord
  comments: AgentWorkComment[]
  projectValues: AgentWorkProjectValues
  mergePullRequest: ReturnType<typeof vi.fn>
  appendComment: ReturnType<typeof vi.fn>
  inspect: ReturnType<typeof vi.fn>
  readCommentHistory: ReturnType<typeof vi.fn>
} {
  const pullRequest: OrdinaryMergePullRequest = {
    repository,
    number: 700,
    state: 'OPEN',
    isDraft: false,
    baseRefName: 'main',
    headRefName: 'agent/issue-611',
    headRefOid: candidate,
    headRepository: repository,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: null,
    mergeCommitOid: null,
    closingIssues: [{ repository, number: 611 }],
    relationshipsComplete: true,
    requiredChecks: [{ name: 'Merge acceptance', outcome: 'success' }],
    checksComplete: true,
    ...options.pullRequest,
  }
  const planning: NormalizedPlanningRecord = {
    repository,
    issue: {
      number: 611,
      state: 'OPEN',
      kind: {
        state: 'valid',
        label: 'kind:maintenance',
        option: 'Maintenance',
        recognizedLabels: ['kind:maintenance'],
      },
      areas: ['area:infrastructure'],
      parent: null,
      subIssues: [],
      linkedPullRequests: [],
      ...options.issue,
    },
    project: {
      membership: 'present',
      kind: 'Maintenance',
      status: options.projectStatus ?? 'In Progress',
    },
  }
  const comments = (options.records ?? [implementationRecord()]).map((record, index) => ({
    body: serializeAgentWorkComment(record),
    authorLogin: 'jarmak-personal',
    createdAt: `2026-08-20T00:00:0${index}.000Z`,
    updatedAt: `2026-08-20T00:00:0${index}.000Z`,
  }))
  const projectValues: AgentWorkProjectValues = {}
  const inspect = vi.fn(() => Promise.resolve(planningReport(planning)))
  const converge = vi.fn((input: { apply: boolean }): Promise<PlanningRecordReport> => {
    const before = planning.project.status
    const outcome =
      before === 'Done' ? 'unchanged' : input.apply ? 'updated' : 'would-update'
    if (input.apply) planning.project.status = 'Done'
    return Promise.resolve({
      ...planningReport(planning),
      apply: input.apply,
      applied: outcome === 'updated',
      operations: [
        { operation: 'ensure-project', outcome: 'unchanged' },
        {
          operation: 'set-status',
          outcome,
          from: before,
          to: 'Done',
        },
      ],
    })
  })
  const mergePullRequest = vi.fn(() => {
    const outcome = options.mergeOutcome ?? 'merged'
    if (outcome === 'merged') {
      pullRequest.state = 'MERGED'
      pullRequest.mergeCommitOid = mergeCommit
      if (options.closeOnMerge !== false) planning.issue.state = 'CLOSED'
      return Promise.resolve({ outcome, mergeCommitOid: mergeCommit } as const)
    }
    return Promise.resolve({ outcome } as const)
  })
  const appendComment = vi.fn((_issueNumber: number, body: string) => {
    comments.push({
      body,
      authorLogin: 'jarmak-personal',
      createdAt: '2026-08-20T00:01:00.000Z',
      updatedAt: '2026-08-20T00:01:00.000Z',
    })
    return Promise.resolve()
  })
  const readCommentHistory = vi.fn(() =>
    Promise.resolve({ trustedActor: 'jarmak-personal', comments: [...comments] }),
  )
  return {
    pullRequest,
    planning,
    comments,
    projectValues,
    mergePullRequest,
    appendComment,
    inspect,
    readCommentHistory,
    ports: {
      pullRequests: {
        readPullRequest: vi.fn(() => Promise.resolve({ ...pullRequest })),
        mergePullRequest,
      },
      planning: { inspect, converge },
      ledger: {
        readCommentHistory,
        appendComment,
      },
      projectionSource: {
        readProjectionIssue: vi.fn(() => Promise.resolve(projectionIssue())),
      },
      project: {
        readAgentWorkProjection: vi.fn(() => Promise.resolve({ ...projectValues })),
        setAgentWorkProjectionField: vi.fn(
          (
            issueNumber: number,
            name: AgentWorkProjectFieldName,
            value: AgentWorkProjectValue | undefined,
          ) => {
            expect(issueNumber).toBe(611)
            if (options.projectionFailure) {
              return Promise.reject(new Error('Project write failed'))
            }
            if (value === undefined) delete projectValues[name]
            else projectValues[name] = value
            return Promise.resolve()
          },
        ),
      },
      wait: vi.fn().mockResolvedValue(undefined),
    },
  }
}

describe('ordinary pull request merge acceptance', () => {
  it('plans an exact open candidate without mutating GitHub or measurement state', async () => {
    const candidateFixture = fixture()

    const result = await reconcileOrdinaryPullRequestMerge(candidateFixture.ports, {
      pullRequestNumber: 700,
      apply: false,
    })

    expect(result).toMatchObject({
      issueNumber: 611,
      candidateOid: candidate,
      outcome: 'would-merge',
      merge: { outcome: 'would-merge' },
      diagnostics: [],
    })
    expect(candidateFixture.mergePullRequest).not.toHaveBeenCalled()
    expect(candidateFixture.appendComment).not.toHaveBeenCalled()
    expect(candidateFixture.projectValues).toEqual({})
  })

  it('merges one exact successful candidate and supersedes pending with accepted', async () => {
    const candidateFixture = fixture()

    const result = await reconcileOrdinaryPullRequestMerge(candidateFixture.ports, {
      pullRequestNumber: 700,
      apply: true,
    })

    expect(result).toMatchObject({
      outcome: 'merged',
      merge: { outcome: 'merged' },
      issue: { state: 'CLOSED', projectStatus: 'Done' },
      measurement: { outcome: 'appended', firstPass: 'accepted' },
      diagnostics: [],
    })
    expect(candidateFixture.mergePullRequest).toHaveBeenCalledWith(700, candidate)
    const ledger = normalizeAgentWorkComments(611, {
      trustedActor: 'jarmak-personal',
      comments: candidateFixture.comments,
    })
    expect(
      ledger.records.find((record) => record.activity === 'active')?.outcome,
    ).toEqual({ firstPass: 'accepted', candidateRef: candidate })
    expect(ledger.ownTotal.normalizedTokenTotal).toBe(18)
    expect(candidateFixture.projectValues['First-pass outcome']).toBe('Accepted')
    expect(candidateFixture.projectValues['Implementation tokens']).toBe(18)
  })

  it.each<
    [string, Partial<OrdinaryMergePullRequest>, OrdinaryPullRequestMergeDiagnostic]
  >([
    ['draft', { isDraft: true }, 'pull-request-draft'],
    ['wrong base', { baseRefName: 'epic/600-delivery' }, 'base-mismatch'],
    [
      'head not recorded by implementation',
      { headRefOid: 'c'.repeat(40) },
      'measurement-candidate-mismatch',
    ],
    [
      'foreign relationship',
      { closingIssues: [{ repository: 'someone-else/hvir', number: 611 }] },
      'relationship-mismatch',
    ],
    ['missing relationship', { closingIssues: [] }, 'relationship-mismatch'],
    [
      'ambiguous relationship',
      {
        closingIssues: [
          { repository, number: 611 },
          { repository, number: 612 },
        ],
      },
      'relationship-ambiguous',
    ],
    ['merge conflict', { mergeable: 'CONFLICTING' }, 'merge-conflict'],
    ['unknown mergeability', { mergeable: 'UNKNOWN' }, 'mergeability-unknown'],
    ['stale base', { mergeStateStatus: 'BEHIND' }, 'merge-state-unresolved'],
  ])('blocks a %s before mutation', async (_name, pullRequest, diagnostic) => {
    const candidateFixture = fixture({ pullRequest })
    const result = await reconcileOrdinaryPullRequestMerge(candidateFixture.ports, {
      pullRequestNumber: 700,
      apply: true,
    })

    expect(result.diagnostics).toContain(diagnostic)
    expect(candidateFixture.mergePullRequest).not.toHaveBeenCalled()
  })

  it('does not read issue-owned state when the pull request cannot resolve one issue', async () => {
    const candidateFixture = fixture({ pullRequest: { closingIssues: [] } })

    const result = await reconcileOrdinaryPullRequestMerge(candidateFixture.ports, {
      pullRequestNumber: 700,
      apply: true,
    })

    expect(result).toMatchObject({
      issueNumber: null,
      candidateOid: candidate,
      issue: { state: null, projectStatus: null },
      diagnostics: ['relationship-mismatch'],
    })
    expect(candidateFixture.inspect).not.toHaveBeenCalled()
    expect(candidateFixture.readCommentHistory).not.toHaveBeenCalled()
  })

  it.each([
    ['pending', 'pending', 'required-check-pending'],
    ['failed', 'failure', 'required-check-failed'],
  ] as const)('blocks a %s required check', async (_name, outcome, diagnostic) => {
    const candidateFixture = fixture({
      pullRequest: {
        requiredChecks: [{ name: 'Merge acceptance', outcome }],
      },
    })

    const result = await reconcileOrdinaryPullRequestMerge(candidateFixture.ports, {
      pullRequestNumber: 700,
      apply: true,
    })

    expect(result.diagnostics).toContain(diagnostic)
    expect(candidateFixture.mergePullRequest).not.toHaveBeenCalled()
  })

  it('resumes from an already merged exact candidate without merging again', async () => {
    const candidateFixture = fixture({
      pullRequest: { state: 'MERGED', mergeCommitOid: mergeCommit },
      issue: { state: 'CLOSED' },
    })

    const result = await reconcileOrdinaryPullRequestMerge(candidateFixture.ports, {
      pullRequestNumber: 700,
      apply: true,
    })

    expect(result).toMatchObject({
      outcome: 'recovered',
      merge: { outcome: 'already-merged' },
      measurement: { outcome: 'appended', firstPass: 'accepted' },
    })
    expect(candidateFixture.mergePullRequest).not.toHaveBeenCalled()
  })

  it('resumes native closure reconciliation after the merge has already succeeded', async () => {
    const candidateFixture = fixture({ closeOnMerge: false })

    const first = await reconcileOrdinaryPullRequestMerge(candidateFixture.ports, {
      pullRequestNumber: 700,
      apply: true,
    })
    expect(first).toMatchObject({
      outcome: 'partial',
      merge: { outcome: 'merged' },
      diagnostics: ['native-issue-closure-pending'],
    })

    candidateFixture.planning.issue.state = 'CLOSED'
    const resumed = await reconcileOrdinaryPullRequestMerge(candidateFixture.ports, {
      pullRequestNumber: 700,
      apply: true,
    })

    expect(resumed).toMatchObject({
      outcome: 'recovered',
      merge: { outcome: 'already-merged' },
      issue: { state: 'CLOSED', projectStatus: 'Done' },
    })
    expect(candidateFixture.mergePullRequest).toHaveBeenCalledTimes(1)
  })

  it('reuses an accepted supersession without duplicating its implementation usage', async () => {
    const original = implementationRecord()
    const accepted: AgentWorkRecord = {
      ...original,
      idempotencyKey: '4'.repeat(64),
      outcome: { firstPass: 'accepted', candidateRef: candidate },
      supersedes: original.idempotencyKey,
    }
    const candidateFixture = fixture({
      pullRequest: { state: 'MERGED', mergeCommitOid: mergeCommit },
      issue: { state: 'CLOSED' },
      projectStatus: 'Done',
      records: [original, accepted],
    })

    const result = await reconcileOrdinaryPullRequestMerge(candidateFixture.ports, {
      pullRequestNumber: 700,
      apply: true,
    })

    expect(result.measurement).toEqual({
      outcome: 'already-reconciled',
      firstPass: 'accepted',
    })
    expect(candidateFixture.appendComment).not.toHaveBeenCalled()
    expect(candidateFixture.projectValues['Implementation tokens']).toBe(18)
  })

  it('keeps rework-required sticky without appending duplicate usage', async () => {
    const candidateFixture = fixture({
      pullRequest: { state: 'MERGED', mergeCommitOid: mergeCommit },
      issue: { state: 'CLOSED' },
      projectStatus: 'Done',
      records: [implementationRecord({ firstPass: 'rework-required' })],
    })

    const result = await reconcileOrdinaryPullRequestMerge(candidateFixture.ports, {
      pullRequestNumber: 700,
      apply: true,
    })

    expect(result.measurement).toEqual({
      outcome: 'sticky-rework',
      firstPass: 'rework-required',
    })
    expect(candidateFixture.appendComment).not.toHaveBeenCalled()
    expect(candidateFixture.projectValues['First-pass outcome']).toBe('Rework required')
  })

  it('marks the first candidate as rework-required when a later implementation run exists', async () => {
    const laterCandidate = 'd'.repeat(40)
    const candidateFixture = fixture({
      pullRequest: {
        state: 'MERGED',
        headRefOid: laterCandidate,
        mergeCommitOid: mergeCommit,
      },
      issue: { state: 'CLOSED' },
      records: [
        implementationRecord(),
        implementationRecord({
          runKey: '2'.repeat(64),
          idempotencyKey: '3'.repeat(64),
          candidateRef: laterCandidate,
        }),
      ],
    })

    const result = await reconcileOrdinaryPullRequestMerge(candidateFixture.ports, {
      pullRequestNumber: 700,
      apply: true,
    })

    expect(result.measurement).toMatchObject({
      outcome: 'appended',
      firstPass: 'rework-required',
    })
    expect(candidateFixture.projectValues['First-pass outcome']).toBe('Rework required')
    expect(candidateFixture.projectValues['Implementation tokens']).toBe(36)
  })

  it('does not invent measurement evidence when no implementation record exists', async () => {
    const candidateFixture = fixture({ records: [] })

    const result = await reconcileOrdinaryPullRequestMerge(candidateFixture.ports, {
      pullRequestNumber: 700,
      apply: true,
    })

    expect(result.outcome).toBe('merged')
    expect(result.measurement.outcome).toBe('unavailable')
    expect(candidateFixture.appendComment).not.toHaveBeenCalled()
    expect(candidateFixture.projectValues['Measurement coverage']).toBe('Unavailable')
    expect(candidateFixture.projectValues['Review tokens']).toBeUndefined()
  })

  it('reports projection failure without rewriting a successful merge', async () => {
    const candidateFixture = fixture({ projectionFailure: true })

    const result = await reconcileOrdinaryPullRequestMerge(candidateFixture.ports, {
      pullRequestNumber: 700,
      apply: true,
    })

    expect(result).toMatchObject({
      outcome: 'partial',
      merge: { outcome: 'merged' },
      projection: { outcome: 'partial' },
    })
    expect(result.diagnostics).toContain('measurement-projection-failed')
    expect(candidateFixture.pullRequest.state).toBe('MERGED')
  })

  it('refuses root epics and direct epic children', async () => {
    const rootEpic = fixture({
      issue: {
        kind: {
          state: 'valid',
          label: 'kind:epic',
          option: 'Epic',
          recognizedLabels: ['kind:epic'],
        },
      },
    })
    const child = fixture({
      issue: { parent: { repository, number: 600, state: 'OPEN' } },
    })

    for (const candidateFixture of [rootEpic, child]) {
      const result = await reconcileOrdinaryPullRequestMerge(candidateFixture.ports, {
        pullRequestNumber: 700,
        apply: true,
      })
      expect(result.diagnostics).toContain('issue-not-ordinary')
      expect(candidateFixture.mergePullRequest).not.toHaveBeenCalled()
    }
  })

  it('accepts only one explicit pull request number', () => {
    expect(
      parseOrdinaryPullRequestMergeCliOptions([
        '--pull-request',
        '700',
        '--apply',
        '--json',
      ]),
    ).toEqual({
      help: false,
      pullRequestNumber: 700,
      apply: true,
      json: true,
    })
    expect(() => parseOrdinaryPullRequestMergeCliOptions([])).toThrow(
      '--pull-request is required',
    )
    expect(() => parseOrdinaryPullRequestMergeCliOptions(['--issue', '611'])).toThrow(
      'Unknown argument: --issue',
    )
    expect(() =>
      parseOrdinaryPullRequestMergeCliOptions(['--candidate', candidate]),
    ).toThrow('Unknown argument: --candidate')
  })
})

function implementationRecord(
  overrides: {
    firstPass?: 'pending' | 'accepted' | 'rework-required' | 'no-candidate'
    runKey?: string
    idempotencyKey?: string
    candidateRef?: string
  } = {},
): AgentWorkRecord {
  return {
    schema: 1,
    issueNumber: 611,
    phase: 'implementation',
    runKey: overrides.runKey ?? '1'.repeat(64),
    idempotencyKey: overrides.idempotencyKey ?? '2'.repeat(64),
    availability: 'complete',
    route: {
      initial: { harness: 'codex', modelId: 'gpt-5.6-sol' },
      changes: [],
    },
    usage: {
      freshInputTokens: 3,
      cacheReadInputTokens: 5,
      cacheWriteInputTokens: 7,
      outputTokens: 3,
      normalizedTokenTotal: 18,
    },
    timing: { activeWallMilliseconds: 100, timeToFirstCandidateMilliseconds: 90 },
    outcome: {
      firstPass: overrides.firstPass ?? 'pending',
      candidateRef: overrides.candidateRef ?? candidate,
    },
  }
}

function planningReport(record: NormalizedPlanningRecord): PlanningRecordReport {
  return { apply: false, applied: false, record, operations: [] }
}

function projectionIssue(): AgentWorkProjectionIssue {
  return {
    body: `## Initial forecast

- Agent difficulty: 3/5
- Reasoning novelty: 1/2
- Ownership breadth: 1/2
- Lifecycle/integration burden: 2/2
- Validation burden: 1/2
- Risk: Moderate
- Estimate confidence: High
- Rationale: bounded contributor workflow.`,
    kind: 'other',
    parent: null,
  }
}
