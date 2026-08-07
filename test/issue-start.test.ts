import { describe, expect, it, vi } from 'vitest'

import {
  formatIssueStartOperationalFailure,
  formatIssueStartReport,
  parseIssueStartCliOptions,
} from '../scripts/project-management/issue-start-cli.ts'
import {
  isDisposableIgnoredPath,
  issueStartExitCode,
  runIssueStart,
  type IssueStartPorts,
  type IssueStartRepositoryPort,
  type IssueWorktreeSnapshot,
} from '../scripts/project-management/issue-start.ts'
import type { IssueDeliveryContext } from '../scripts/project-management/issue-context.ts'
import {
  parseWorktreeList,
  parseWorktreeStatus,
} from '../scripts/project-management/native-issue-worktrees.ts'

const PRIMARY_ROOT = '/repos/hvir'
const WORKTREE = '/repos/hvir-worktrees/issue-442'
const HEAD = 'a'.repeat(40)

describe('issue start CLI', () => {
  it('parses planning, apply, JSON, and help modes', () => {
    expect(parseIssueStartCliOptions(['--issue', '442'])).toEqual({
      help: false,
      issueNumber: 442,
      apply: false,
      json: false,
    })
    expect(parseIssueStartCliOptions(['--issue', '442', '--apply', '--json'])).toEqual({
      help: false,
      issueNumber: 442,
      apply: true,
      json: true,
    })
    expect(parseIssueStartCliOptions(['--help'])).toEqual({
      help: true,
      apply: false,
      json: false,
    })
  })

  it.each([
    { args: [] as string[], message: '--issue is required' },
    { args: ['--issue'], message: '--issue requires a value' },
    { args: ['--issue', '0'], message: 'positive integer' },
    { args: ['--unknown'], message: 'Unknown argument' },
  ])('rejects invalid input: $message', ({ args, message }) => {
    expect(() => parseIssueStartCliOptions(args)).toThrow(message)
  })

  it('uses a bounded fixed operational error instead of raw failure text', () => {
    const output = formatIssueStartOperationalFailure(true)
    expect(output).toContain('startup-failed')
    expect(output).not.toContain('token')
    expect(output).not.toContain('body')
  })
})

describe('issue start coordination', () => {
  it('refreshes before context and prints the complete ordinary plan without mutation', async () => {
    const calls: string[] = []
    const repository = fakeRepository({
      refreshRemoteRefs: vi.fn(() => {
        calls.push('fetch')
        return Promise.resolve()
      }),
      resolveRef: vi.fn(() => {
        calls.push('resolve')
        return Promise.resolve(HEAD)
      }),
      listWorktrees: vi.fn(() => {
        calls.push('worktrees')
        return Promise.resolve([])
      }),
      inspectBranch: vi.fn().mockResolvedValue(null),
      pathExists: vi.fn().mockResolvedValue(false),
    })
    const ports = fakePorts(repository, {
      readIssueContext: vi.fn(() => {
        calls.push('context')
        return Promise.resolve(deliveryContext())
      }),
      readExpectedBase: vi.fn().mockResolvedValue('main'),
    })

    const report = await runIssueStart(ports, input(false))

    expect(calls.slice(0, 2)).toEqual(['fetch', 'context'])
    expect(report).toMatchObject({
      outcome: 'planned',
      delivery: {
        pullRequestBase: 'main',
        startRef: 'origin/main',
        branch: 'agent/issue-442',
        worktree: WORKTREE,
      },
      selectedHead: HEAD,
      dependency: { status: 'planned', timeoutMs: 900_000 },
      retained: [],
      blockers: [],
      failures: [],
    })
    expect(
      report.operations.map(({ operation, outcome }) => [operation, outcome]),
    ).toEqual([
      ['fetch-prune', 'completed'],
      ['select-worktree', 'would-create'],
      ['prepare-dependencies', 'would-run'],
    ])
    expect(repository.createWorktree).not.toHaveBeenCalled()
    expect(repository.prepareDependencies).not.toHaveBeenCalled()
    expect(issueStartExitCode(report)).toBe(0)
  })

  it('stops on canonical context conflicts after fetch and before local mutation', async () => {
    const repository = fakeRepository()
    const blocked = deliveryContext({
      ready: false,
      conflicts: [
        {
          code: 'project-status',
          message: 'Issue #442 Project Status does not match its issue lifecycle state.',
        },
      ],
    })

    const report = await runIssueStart(
      fakePorts(repository, {
        readIssueContext: vi.fn().mockResolvedValue(blocked),
        readExpectedBase: vi.fn().mockResolvedValue('main'),
      }),
      input(true),
    )

    expect(report.outcome).toBe('blocked')
    expect(issueStartExitCode(report)).toBe(2)
    expect(repository.resolveRef).not.toHaveBeenCalled()
    expect(repository.createWorktree).not.toHaveBeenCalled()
  })

  it('reuses only the exact worktree and reports dependency failure as retained partial state', async () => {
    const existing = worktree(442, HEAD)
    const repository = fakeRepository({
      listWorktrees: vi.fn().mockResolvedValue([existing]),
      inspectBranch: vi.fn().mockResolvedValue({
        head: HEAD,
        upstream: { name: 'origin/agent/issue-442', gone: false },
      }),
      prepareDependencies: vi.fn().mockResolvedValue({
        ready: false,
        failure: 'native-rebuild',
      }),
    })

    const report = await runIssueStart(fakePorts(repository), input(true))

    expect(report.outcome).toBe('failed')
    expect(report.selectedHead).toBe(HEAD)
    expect(report.operations).toContainEqual({
      operation: 'select-worktree',
      outcome: 'reused',
      issueNumber: 442,
      worktree: WORKTREE,
      branch: 'agent/issue-442',
    })
    expect(report.dependency).toMatchObject({
      status: 'failed',
      failure: 'native-rebuild',
    })
    expect(report.retained).toContainEqual({
      issueNumber: 442,
      branch: 'agent/issue-442',
      worktree: WORKTREE,
      reasons: ['dependency-preparation-failed'],
    })
    expect(repository.createWorktree).not.toHaveBeenCalled()
    expect(issueStartExitCode(report)).toBe(1)
  })

  it('plans exact cleanup only with clean local state, a gone upstream, and exact merged PR evidence', async () => {
    const safeHead = 'b'.repeat(40)
    const dirtyHead = 'c'.repeat(40)
    const repository = fakeRepository({
      listWorktrees: vi
        .fn()
        .mockResolvedValue([worktree(400, safeHead), worktree(401, dirtyHead)]),
      inspectBranch: vi.fn((branch: string) => {
        if (branch === 'agent/issue-442') return Promise.resolve(null)
        return Promise.resolve({
          head: branch === 'agent/issue-400' ? safeHead : dirtyHead,
          upstream: { name: `origin/${branch}`, gone: true },
        })
      }),
      inspectWorktreeState: vi.fn((path: string) =>
        Promise.resolve({
          trackedChanges: false,
          untrackedPaths: path.endsWith('issue-401'),
          ignoredPaths: path.endsWith('issue-400') ? ['node_modules/'] : [],
        }),
      ),
    })
    const metadata = {
      listWorkflowPullRequestEvidence: vi.fn((branch: string) =>
        Promise.resolve({
          complete: true,
          pullRequests: [
            {
              number: 500,
              state: 'MERGED' as const,
              baseRefName: 'main',
              headRefName: branch,
              headRefOid: safeHead,
            },
          ],
        }),
      ),
    }

    const report = await runIssueStart(
      fakePorts(repository, undefined, metadata),
      input(false),
    )

    expect(report.operations).toContainEqual({
      operation: 'remove-worktree',
      outcome: 'would-remove',
      issueNumber: 400,
      worktree: '/repos/hvir-worktrees/issue-400',
    })
    expect(report.operations).toContainEqual({
      operation: 'delete-branch',
      outcome: 'would-delete',
      issueNumber: 400,
      branch: 'agent/issue-400',
      expectedHead: safeHead,
    })
    expect(report.retained).toContainEqual({
      issueNumber: 401,
      branch: 'agent/issue-401',
      worktree: '/repos/hvir-worktrees/issue-401',
      reasons: ['untracked-content'],
    })
    expect(metadata.listWorkflowPullRequestEvidence).toHaveBeenCalledTimes(1)
  })

  it('continues selected setup but returns partial failure when eligible cleanup fails', async () => {
    const oldHead = 'b'.repeat(40)
    const repository = fakeRepository({
      listWorktrees: vi.fn().mockResolvedValue([worktree(400, oldHead)]),
      inspectBranch: vi.fn((branch: string) =>
        Promise.resolve(
          branch === 'agent/issue-400'
            ? {
                head: oldHead,
                upstream: { name: 'origin/agent/issue-400', gone: true },
              }
            : null,
        ),
      ),
      removeWorktree: vi.fn().mockRejectedValue(new Error('private raw failure')),
    })
    const metadata = {
      listWorkflowPullRequestEvidence: vi.fn().mockResolvedValue({
        complete: true,
        pullRequests: [
          {
            number: 500,
            state: 'MERGED' as const,
            baseRefName: 'main',
            headRefName: 'agent/issue-400',
            headRefOid: oldHead,
          },
        ],
      }),
    }

    const report = await runIssueStart(
      fakePorts(repository, undefined, metadata),
      input(true),
    )

    expect(repository.createWorktree).toHaveBeenCalled()
    expect(repository.prepareDependencies).toHaveBeenCalled()
    expect(report.outcome).toBe('failed')
    expect(formatIssueStartReport(report)).not.toContain('private raw failure')
    expect(report.operations).not.toContainEqual(
      expect.objectContaining({ operation: 'delete-branch', issueNumber: 400 }),
    )
  })

  it('blocks a pre-existing selected branch without the exact registered worktree', async () => {
    const repository = fakeRepository({
      inspectBranch: vi.fn().mockResolvedValue({ head: HEAD, upstream: null }),
    })

    const report = await runIssueStart(fakePorts(repository), input(true))

    expect(report.outcome).toBe('blocked')
    expect(report.blockers.map(({ code }) => code)).toContain('conflicting-branch')
    expect(repository.createWorktree).not.toHaveBeenCalled()
  })
})

describe('native worktree parsing policy', () => {
  it('parses registered, detached, locked, and prunable worktrees', () => {
    const output = [
      'worktree /repos/hvir',
      `HEAD ${HEAD}`,
      'branch refs/heads/main',
      '',
      'worktree /repos/hvir-worktrees/issue-442',
      `HEAD ${'b'.repeat(40)}`,
      'detached',
      'locked held',
      'prunable missing',
      '',
    ].join('\0')

    expect(parseWorktreeList(output)).toEqual([
      {
        path: '/repos/hvir',
        head: HEAD,
        branch: 'main',
        locked: false,
        prunable: false,
      },
      {
        path: '/repos/hvir-worktrees/issue-442',
        head: 'b'.repeat(40),
        branch: null,
        locked: true,
        prunable: true,
      },
    ])
  })

  it('separates tracked, untracked, and ignored state conservatively', () => {
    expect(
      parseWorktreeStatus(' M tracked.ts\0?? draft.txt\0!! node_modules/\0'),
    ).toEqual({
      trackedChanges: true,
      untrackedPaths: true,
      ignoredPaths: ['node_modules/'],
    })
    expect(isDisposableIgnoredPath('node_modules/pkg/index.js')).toBe(true)
    expect(isDisposableIgnoredPath('out/main.js')).toBe(true)
    expect(isDisposableIgnoredPath('.private-notes')).toBe(false)
  })
})

function fakePorts(
  repository: IssueStartRepositoryPort,
  context: IssueStartPorts['context'] = {
    readIssueContext: vi.fn().mockResolvedValue(deliveryContext()),
    readExpectedBase: vi.fn().mockResolvedValue('main'),
  },
  metadata: IssueStartPorts['metadata'] = {
    listWorkflowPullRequestEvidence: vi.fn().mockResolvedValue({
      complete: true,
      pullRequests: [],
    }),
  },
): IssueStartPorts {
  return { context, metadata, repository }
}

function fakeRepository(
  overrides: Partial<IssueStartRepositoryPort> = {},
): IssueStartRepositoryPort {
  return {
    refreshRemoteRefs: vi.fn().mockResolvedValue(undefined),
    canonicalPath: vi.fn((path: string) => Promise.resolve(path)),
    listWorktrees: vi.fn().mockResolvedValue([]),
    inspectBranch: vi.fn().mockResolvedValue(null),
    inspectWorktreeState: vi.fn().mockResolvedValue({
      trackedChanges: false,
      untrackedPaths: false,
      ignoredPaths: [],
    }),
    pathExists: vi.fn().mockResolvedValue(false),
    resolveRef: vi.fn().mockResolvedValue(HEAD),
    removeWorktree: vi.fn().mockResolvedValue(undefined),
    deleteBranch: vi.fn().mockResolvedValue(undefined),
    createWorktree: vi.fn().mockResolvedValue(undefined),
    prepareDependencies: vi.fn().mockResolvedValue({ ready: true }),
    ...overrides,
  }
}

function deliveryContext(
  overrides: Partial<IssueDeliveryContext> = {},
): IssueDeliveryContext {
  return {
    repository: 'jarmak-personal/hvir',
    issue: {
      number: 442,
      state: 'OPEN',
      kind: {
        state: 'valid',
        label: 'kind:maintenance',
        option: 'Maintenance',
        recognizedLabels: ['kind:maintenance'],
      },
      areas: ['area:infrastructure'],
      parent: null,
    },
    parent: null,
    delivery: {
      path: 'ordinary',
      base: 'main',
      branch: 'agent/issue-442',
      worktree: WORKTREE,
    },
    planning: {
      membership: 'present',
      kind: 'Maintenance',
      status: 'Todo',
    },
    openPullRequests: [],
    conflicts: [],
    ready: true,
    ...overrides,
  }
}

function worktree(issueNumber: number, head: string): IssueWorktreeSnapshot {
  return {
    path: `/repos/hvir-worktrees/issue-${issueNumber}`,
    head,
    branch: `agent/issue-${issueNumber}`,
    locked: false,
    prunable: false,
  }
}

function input(apply: boolean): {
  issueNumber: number
  primaryRoot: string
  invocationRoot: string
  apply: boolean
} {
  return {
    issueNumber: 442,
    primaryRoot: PRIMARY_ROOT,
    invocationRoot: PRIMARY_ROOT,
    apply,
  }
}
