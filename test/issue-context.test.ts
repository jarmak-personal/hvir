import { describe, expect, it, vi } from 'vitest'

import {
  formatIssueContext,
  issueContextExitCode,
  parseIssueContextCliOptions,
  resolvePrimaryRepositoryRoot,
} from '../scripts/project-management/issue-context-cli.ts'
import {
  readIssueDeliveryContext,
  type IssueContextPort,
} from '../scripts/project-management/issue-context.ts'
import type {
  NormalizedPlanningRecord,
  PlanningRecordReport,
} from '../scripts/project-management/planning-record.ts'

function contextPort(
  records: Record<number, NormalizedPlanningRecord>,
  options: {
    branches?: string[]
    pullRequests?: Awaited<ReturnType<IssueContextPort['listOpenPullRequestBodies']>>
  } = {},
): IssueContextPort {
  return {
    inspectIssue: vi.fn().mockImplementation((number: number) => {
      const record = records[number]
      if (record === undefined) return Promise.reject(new Error('missing issue'))
      const report: PlanningRecordReport = {
        apply: false,
        applied: false,
        record,
        operations: [],
      }
      return Promise.resolve(report)
    }),
    listEpicBranches: vi.fn().mockResolvedValue(options.branches ?? []),
    listOpenPullRequestBodies: vi.fn().mockResolvedValue(options.pullRequests ?? []),
  }
}

describe('issue delivery context', () => {
  it('reports deterministic ordinary delivery in concise human form', async () => {
    const context = await readIssueDeliveryContext(contextPort({ 168: record(168) }), {
      issueNumber: 168,
      primaryRoot: '/repos/hvir',
    })

    expect(context).toMatchObject({
      repository: 'jarmak-personal/hvir',
      delivery: {
        path: 'ordinary',
        base: 'main',
        branch: 'agent/issue-168',
        worktree: '/repos/hvir-worktrees/issue-168',
      },
      openPullRequests: [],
      conflicts: [],
      ready: true,
    })
    expect(formatIssueContext(context)).toContain(
      'Issue #168 (kind:enhancement) — ready for ordinary delivery',
    )
    expect(issueContextExitCode(context)).toBe(0)
  })

  it('derives an epic child base from native parent metadata and one branch', async () => {
    const context = await readIssueDeliveryContext(
      contextPort(
        {
          168: record(168, {
            parent: {
              repository: 'jarmak-personal/hvir',
              number: 50,
              state: 'OPEN',
            },
          }),
          50: record(50, { kindLabel: 'kind:epic', kindOption: 'Epic' }),
        },
        {
          branches: ['epic/50-project-delivery'],
          pullRequests: [
            {
              repository: 'jarmak-personal/hvir',
              number: 190,
              baseRefName: 'epic/50-project-delivery',
              headRefName: 'agent/issue-168',
              body: 'Completes-child: #168',
            },
          ],
        },
      ),
      { issueNumber: 168, primaryRoot: '/repos/hvir' },
    )

    expect(context).toMatchObject({
      parent: { number: 50, kind: { label: 'kind:epic' } },
      delivery: { path: 'epic-child', base: 'epic/50-project-delivery' },
      openPullRequests: [
        {
          number: 190,
          relationships: ['completing-child'],
        },
      ],
      ready: true,
    })
  })

  it('reports actionable Project, branch, and PR-base conflicts without metadata bodies', async () => {
    const context = await readIssueDeliveryContext(
      contextPort(
        {
          168: record(168, {
            membership: 'missing',
            parent: {
              repository: 'jarmak-personal/hvir',
              number: 50,
              state: 'OPEN',
            },
          }),
          50: record(50, { kindLabel: 'kind:epic', kindOption: 'Epic' }),
        },
        {
          branches: ['epic/50-first', 'epic/50-second'],
          pullRequests: [
            {
              repository: 'jarmak-personal/hvir',
              number: 190,
              baseRefName: 'main',
              headRefName: 'hostile $(command)',
              body: 'Completes-child: #168\nsecret body text',
            },
          ],
        },
      ),
      { issueNumber: 168, primaryRoot: '/repos/hvir' },
    )

    expect(context.ready).toBe(false)
    expect(context.conflicts.map((conflict) => conflict.code)).toEqual([
      'ambiguous-epic-branch',
      'project-membership',
    ])
    expect(JSON.stringify(context)).not.toContain('secret body text')
    expect(issueContextExitCode(context)).toBe(2)
  })
})

describe('issue context CLI', () => {
  it('defaults to human output and accepts explicit JSON', () => {
    expect(parseIssueContextCliOptions(['--issue', '168'])).toEqual({
      help: false,
      issueNumber: 168,
      json: false,
    })
    expect(parseIssueContextCliOptions(['--issue', '168', '--json'])).toEqual({
      help: false,
      issueNumber: 168,
      json: true,
    })
  })

  it.each([
    { args: [] as string[], message: '--issue is required' },
    { args: ['--issue', '0'], message: 'positive integer' },
    { args: ['--unknown'], message: 'Unknown argument' },
  ])('rejects invalid input: $message', ({ args, message }) => {
    expect(() => parseIssueContextCliOptions(args)).toThrow(message)
  })

  it('resolves primary and deterministic issue-worktree layouts without Git', () => {
    expect(resolvePrimaryRepositoryRoot('/repos/hvir', 'hvir', {})).toBe('/repos/hvir')
    expect(
      resolvePrimaryRepositoryRoot('/repos/hvir-worktrees/issue-168', 'hvir', {}),
    ).toBe('/repos/hvir')
    expect(
      resolvePrimaryRepositoryRoot('/tmp/custom', 'hvir', {
        HVIR_PRIMARY_ROOT: '/repos/hvir',
      }),
    ).toBe('/repos/hvir')
  })
})

function record(
  number: number,
  overrides: {
    state?: 'OPEN' | 'CLOSED'
    kindLabel?: 'kind:enhancement' | 'kind:epic'
    kindOption?: 'Enhancement' | 'Epic'
    membership?: 'missing' | 'present' | 'archived'
    status?: string | null
    parent?: NormalizedPlanningRecord['issue']['parent']
  } = {},
): NormalizedPlanningRecord {
  const kindLabel = overrides.kindLabel ?? 'kind:enhancement'
  const kindOption = overrides.kindOption ?? 'Enhancement'
  return {
    repository: 'jarmak-personal/hvir',
    issue: {
      number,
      state: overrides.state ?? 'OPEN',
      kind: {
        state: 'valid',
        label: kindLabel,
        option: kindOption,
        recognizedLabels: [kindLabel],
      },
      areas: ['area:infrastructure'],
      parent: overrides.parent ?? null,
      subIssues: [],
      linkedPullRequests: [],
    },
    project: {
      membership: overrides.membership ?? 'present',
      kind: kindOption,
      status: overrides.status ?? 'Todo',
    },
  }
}
