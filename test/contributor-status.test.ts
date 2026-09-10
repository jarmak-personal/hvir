import { describe, expect, it, vi } from 'vitest'
import {
  formatContributorStatus,
  contributorPullRequestRelationship,
  readContributorStatus,
  readIssueTokenSummary,
  type ContributorStatusPorts,
  type PullRequestStatus,
} from '../scripts/project-management/contributor-status.ts'
import type { PullRequestSnapshot } from '../scripts/project-management/pull-request-relationships.ts'
import type { PlanningIssueSnapshot } from '../scripts/project-management/issue-planning.ts'

const pr: PullRequestStatus = {
  number: 900,
  state: 'OPEN',
  base: 'main',
  head: 'a'.repeat(40),
  draft: false,
  mergeRequest: false,
  review: 'APPROVED',
  mergeability: 'CLEAN',
  checks: [{ name: 'CI', bucket: 'pass' }],
  checksAvailable: true,
  stale: false,
}
const issue = (number = 757): PlanningIssueSnapshot => ({
  id: 'private',
  number,
  repository: 'owner/repo',
  state: 'OPEN',
  updatedAt: 'now',
  labels: ['kind:refactor'],
  parent: null,
  subIssues: [],
  linkedPullRequests: [
    {
      number: 900,
      repository: 'owner/repo',
      state: 'OPEN',
      mergedAt: null,
      relationship: 'closing',
    },
  ],
})
const ports = (): ContributorStatusPorts => {
  const p: ContributorStatusPorts = {
    issue: vi.fn<ContributorStatusPorts['issue']>((number) =>
      Promise.resolve(issue(number)),
    ),
    project: vi.fn<ContributorStatusPorts['project']>(() =>
      Promise.resolve({
        membership: 'present',
        kind: 'Refactor',
        status: 'Done',
      }),
    ),
    pullRequest: vi.fn<ContributorStatusPorts['pullRequest']>(() =>
      Promise.resolve({ ...pr }),
    ),
    relatedPullRequest: (number, selected) =>
      contributorPullRequestRelationship(
        {
          issue: (n) => p.issue(n),
          pullRequest: () => Promise.resolve(nativePr()),
          listEpicBranches: () => Promise.resolve(['epic/733-refactor']),
        },
        number,
        selected,
      ),
    tokens: {
      read: vi.fn(() => Promise.resolve({ receipts: [], legacy: true, diagnostics: [] })),
      append: vi.fn(),
    },
  }
  return p
}

const nativePr = (): PullRequestSnapshot => ({
  repository: 'owner/repo',
  number: 900,
  state: 'OPEN',
  isDraft: false,
  baseRefName: 'main',
  headRefName: 'agent/issue-757',
  body: 'Closes #757',
  closingIssues: [{ number: 757, repository: 'owner/repo', state: 'OPEN' }],
})

describe('deterministic contributor status', () => {
  it('uses delivery policy for historical child reports without Project credentials or native closing links', async () => {
    const child = {
      ...issue(),
      parent: { number: 733, repository: 'owner/repo', state: 'CLOSED' as const },
      linkedPullRequests: [],
    }
    const parent = { ...issue(733), state: 'CLOSED' as const, labels: ['kind:epic'] }
    const pull = {
      ...nativePr(),
      state: 'MERGED' as const,
      baseRefName: 'epic/733-refactor',
      body: 'Completes-child: #757',
      closingIssues: [],
    }
    const p = ports()
    p.issue = (number) => Promise.resolve(number === 733 ? parent : child)
    p.project = vi.fn().mockRejectedValue(new Error('Project unavailable'))
    p.pullRequest = () =>
      Promise.resolve({ ...pr, base: pull.baseRefName, state: pull.state })
    const relationship = (
      selectedPull = pull,
      selectedParent: PlanningIssueSnapshot = parent,
      branches = ['epic/733-refactor'],
    ) =>
      contributorPullRequestRelationship(
        {
          issue: (number) => Promise.resolve(number === 733 ? selectedParent : child),
          pullRequest: () => Promise.resolve(selectedPull),
          listEpicBranches: () => Promise.resolve(branches),
        },
        757,
        900,
      )
    p.relatedPullRequest = () => relationship()
    expect((await readContributorStatus(p, 757, 900)).acceptance).toBe('integrated-child')
    expect(await relationship({ ...pull, baseRefName: 'other' })).toBeNull()
    expect(
      await relationship(pull, parent, ['epic/733-refactor', 'epic/733-duplicate']),
    ).toBeNull()
    expect(await relationship({ ...pull, body: 'Fixes #757' })).toBeNull()
    expect(await relationship(pull, { ...parent, labels: [] })).toBeNull()
    expect(
      await relationship(pull, { ...parent, labels: ['kind:epic', 'kind:bug'] }),
    ).toBeNull()
    expect(
      await relationship(pull, {
        ...parent,
        parent: { number: 1, repository: 'owner/repo', state: 'OPEN' },
      }),
    ).toBeNull()
    p.relatedPullRequest = () => relationship({ ...pull, baseRefName: 'other' })
    expect((await readContributorStatus(p, 757, 900)).acceptance).toBe('unknown')
  })
  it('keeps a known subtotal when another child or unrelated receipt is unavailable', async () => {
    const p = ports()
    p.issue = vi.fn<ContributorStatusPorts['issue']>((number) =>
      number === 733
        ? Promise.resolve({
            ...issue(733),
            labels: ['kind:epic'],
            subIssues: [{ number: 757, repository: 'owner/repo', state: 'OPEN' }],
          })
        : Promise.reject(new Error('private network error')),
    )
    p.tokens.read = vi.fn<ContributorStatusPorts['tokens']['read']>(() =>
      Promise.resolve({
        receipts: [
          {
            schema: 2,
            issue: 733,
            receipt: 'a'.repeat(64),
            provider: 'codex',
            tokens: 42,
          },
        ],
        diagnostics: ['invalid-receipt'],
        legacy: true,
      }),
    )
    expect(await readIssueTokenSummary(p, 733)).toMatchObject({
      tokens: 42,
      contributions: 1,
      diagnostics: ['child-evidence-unavailable:#757', 'invalid-receipt'],
    })
  })
  it('does not infer acceptance from Done, issue closure, approved review or green checks', async () => {
    const p = ports()
    p.issue = vi.fn<ContributorStatusPorts['issue']>(() =>
      Promise.resolve({
        ...issue(),
        state: 'CLOSED',
      }),
    )
    const report = await readContributorStatus(p, 757)
    expect(report).toMatchObject({
      acceptance: 'pending',
      approval: 'unknown',
      tokens: { tokens: null, legacy: true },
    })
    expect(
      formatContributorStatus(report)
        .split('\n')
        .slice(0, 3)
        .map((line) => line.split(':')[0]),
    ).toEqual(['Tokens', 'Project', 'Acceptance'])
    expect(formatContributorStatus(report)).toContain(
      'missing phase evidence remains unknown',
    )
  })
  it('distinguishes pending native merge requests, final merge and child integration', async () => {
    const p = ports()
    p.pullRequest = vi.fn<ContributorStatusPorts['pullRequest']>(() =>
      Promise.resolve({
        ...pr,
        mergeRequest: true,
      }),
    )
    expect(await readContributorStatus(p, 757)).toMatchObject({
      acceptance: 'pending',
      approval: 'unknown',
    })
    p.pullRequest = vi.fn<ContributorStatusPorts['pullRequest']>(() =>
      Promise.resolve({
        ...pr,
        state: 'MERGED',
      }),
    )
    expect((await readContributorStatus(p, 757)).acceptance).toBe('merged-to-main')
  })
  it('keeps ambiguous relationships, failed optional reads, and stale checks explicit', async () => {
    const p = ports()
    p.project = vi
      .fn<ContributorStatusPorts['project']>()
      .mockRejectedValue(new Error('secret'))
    p.tokens.read = vi
      .fn<ContributorStatusPorts['tokens']['read']>()
      .mockRejectedValue(new Error('secret'))
    p.pullRequest = vi.fn<ContributorStatusPorts['pullRequest']>(() =>
      Promise.resolve({
        ...pr,
        stale: true,
      }),
    )
    const report = await readContributorStatus(p, 757)
    expect(report.issueState).toBe('OPEN')
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([
        'token-history-unavailable:#757',
        'project-unavailable',
        'pull-request-evidence-stale',
      ]),
    )
    expect(formatContributorStatus(report)).not.toContain('secret')
    p.issue = vi.fn<ContributorStatusPorts['issue']>(() =>
      Promise.resolve({
        ...issue(),
        linkedPullRequests: [
          issue().linkedPullRequests[0]!,
          { ...issue().linkedPullRequests[0]!, number: 901 },
        ],
      }),
    )
    expect((await readContributorStatus(p, 757)).diagnostics).toContain(
      'pull-request-ambiguous',
    )
  })
  it('aggregates direct child receipts once, never Project totals or grandchildren', async () => {
    const p = ports()
    p.issue = vi.fn<ContributorStatusPorts['issue']>((number) =>
      Promise.resolve(
        number === 733
          ? {
              ...issue(733),
              labels: ['kind:epic'],
              subIssues: [{ number: 757, repository: 'owner/repo', state: 'CLOSED' }],
            }
          : {
              ...issue(number),
              parent: { number: 733, repository: 'owner/repo', state: 'OPEN' },
            },
      ),
    )
    p.tokens.read = vi.fn<ContributorStatusPorts['tokens']['read']>((number) =>
      Promise.resolve({
        receipts: [
          {
            schema: 2,
            issue: number,
            receipt: (number === 733 ? 'a' : 'b').repeat(64),
            provider: 'codex',
            tokens: number === 733 ? 20 : 100,
          },
        ],
        legacy: false,
        diagnostics: [],
      }),
    )
    expect(await readIssueTokenSummary(p, 733)).toMatchObject({
      tokens: 120,
      contributions: 2,
      participants: [733, 757],
    })
    expect(p.project).not.toHaveBeenCalled()
    p.issue = vi.fn<ContributorStatusPorts['issue']>((number) =>
      Promise.resolve({
        ...issue(number),
        labels: ['kind:epic'],
        parent: { number: 1, repository: 'owner/repo', state: 'OPEN' },
      }),
    )
    await expect(readIssueTokenSummary(p, 733)).rejects.toThrow('Nested')
  })
})
