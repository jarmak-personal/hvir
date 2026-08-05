import { execFileSync } from 'node:child_process'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  runIssueStart,
  type IssueStartMetadataPort,
} from '../scripts/project-management/issue-start.ts'
import type { IssueDeliveryContext } from '../scripts/project-management/issue-context.ts'
import { NativeIssueWorktreeRepository } from '../scripts/project-management/native-issue-worktrees.ts'

interface GitFixture {
  root: string
  primary: string
}

const fixtures: GitFixture[] = []

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((fixture) =>
      rm(fixture.root, {
        recursive: true,
        force: true,
      }),
    ),
  )
})

describe('issue start native Git fixture', () => {
  it('plans without local setup mutation, then creates and reuses the exact ordinary worktree', async () => {
    const fixture = await createGitFixture()

    const plan = await runNative(fixture, deliveryContext(fixture, 442), false)
    expect(plan.outcome).toBe('planned')
    expect(plan.selectedHead).toBe(git(fixture.primary, 'rev-parse', 'origin/main'))
    expect(
      gitResult(
        fixture.primary,
        'show-ref',
        '--verify',
        '--quiet',
        'refs/heads/agent/issue-442',
      ),
    ).toBe(1)
    await expectPath(`${fixture.primary}-worktrees/issue-442`, false)

    const applied = await runNative(fixture, deliveryContext(fixture, 442), true)
    expect(applied.outcome).toBe('ready')
    expect(git(fixture.primary, 'rev-parse', 'agent/issue-442')).toBe(
      git(fixture.primary, 'rev-parse', 'origin/main'),
    )
    await expectPath(`${fixture.primary}-worktrees/issue-442`, true)

    const repeated = await runNative(fixture, deliveryContext(fixture, 442), true)
    expect(repeated.outcome, JSON.stringify(repeated, null, 2)).toBe('ready')
    expect(repeated.operations).toContainEqual(
      expect.objectContaining({ operation: 'select-worktree', outcome: 'reused' }),
    )
    expect(
      git(fixture.primary, 'worktree', 'list', '--porcelain').match(
        /branch refs\/heads\/agent\/issue-442/g,
      ),
    ).toHaveLength(1)
  })

  it('creates an epic child from the exact fetched epic branch rather than main', async () => {
    const fixture = await createGitFixture()
    const mainHead = git(fixture.primary, 'rev-parse', 'main')
    const tree = git(fixture.primary, 'rev-parse', 'main^{tree}')
    const epicHead = gitWithInput(
      fixture.primary,
      'epic base',
      'commit-tree',
      tree,
      '-p',
      mainHead,
    )
    git(fixture.primary, 'push', 'origin', `${epicHead}:refs/heads/epic/50-delivery`)

    const report = await runNative(
      fixture,
      deliveryContext(fixture, 442, {
        parent: 50,
        path: 'epic-child',
        base: 'epic/50-delivery',
      }),
      true,
    )

    expect(epicHead).not.toBe(mainHead)
    expect(report.delivery.startRef).toBe('origin/epic/50-delivery')
    expect(report.selectedHead).toBe(epicHead)
    expect(git(fixture.primary, 'rev-parse', 'agent/issue-442')).toBe(epicHead)
  })

  it('cleans exact proven completed state while preserving an unrelated dirty worktree', async () => {
    const fixture = await createGitFixture()
    const safePath = `${fixture.primary}-worktrees/issue-400`
    const dirtyPath = `${fixture.primary}-worktrees/issue-401`
    git(
      fixture.primary,
      'worktree',
      'add',
      '-b',
      'agent/issue-400',
      safePath,
      'origin/main',
    )
    git(safePath, 'push', '-u', 'origin', 'agent/issue-400')
    const safeHead = git(safePath, 'rev-parse', 'HEAD')
    await mkdir(join(safePath, 'out'))
    await writeFile(join(safePath, 'out', 'disposable.txt'), 'generated\n')
    git(fixture.primary, 'push', 'origin', '--delete', 'agent/issue-400')

    git(
      fixture.primary,
      'worktree',
      'add',
      '-b',
      'agent/issue-401',
      dirtyPath,
      'origin/main',
    )
    await writeFile(join(dirtyPath, 'unfinished.txt'), 'preserve me\n')
    const metadata = metadataPort({
      'agent/issue-400': {
        number: 500,
        state: 'MERGED',
        baseRefName: 'main',
        headRefName: 'agent/issue-400',
        headRefOid: safeHead,
      },
    })

    const report = await runNative(fixture, deliveryContext(fixture, 442), true, metadata)

    expect(report.outcome, JSON.stringify(report, null, 2)).toBe('ready')
    await expectPath(safePath, false)
    expect(
      gitResult(
        fixture.primary,
        'show-ref',
        '--verify',
        '--quiet',
        'refs/heads/agent/issue-400',
      ),
    ).toBe(1)
    await expectPath(join(dirtyPath, 'unfinished.txt'), true)
    expect(report.retained).toContainEqual(
      expect.objectContaining({
        issueNumber: 401,
        reasons: ['untracked-content', 'upstream-active'],
      }),
    )
  })

  it('retains one selected worktree after dependency failure and retries it in place', async () => {
    const fixture = await createGitFixture({
      preinstall: 'node -e "process.exit(17)"',
    })
    const context = deliveryContext(fixture, 442)

    const first = await runNative(fixture, context, true)
    expect(first.outcome).toBe('failed')
    expect(first.dependency.status).toBe('failed')
    await expectPath(`${fixture.primary}-worktrees/issue-442`, true)

    const second = await runNative(fixture, context, true)
    expect(second.outcome, JSON.stringify(second, null, 2)).toBe('failed')
    expect(second.operations).toContainEqual(
      expect.objectContaining({ operation: 'select-worktree', outcome: 'reused' }),
    )
    expect(
      git(fixture.primary, 'worktree', 'list', '--porcelain').match(
        /branch refs\/heads\/agent\/issue-442/g,
      ),
    ).toHaveLength(1)
  })
})

async function runNative(
  fixture: GitFixture,
  context: IssueDeliveryContext,
  apply: boolean,
  metadata: IssueStartMetadataPort = metadataPort({}),
) {
  return runIssueStart(
    {
      context: {
        readIssueContext: vi.fn().mockResolvedValue(context),
        readExpectedBase: vi.fn().mockResolvedValue('main'),
      },
      metadata,
      repository: new NativeIssueWorktreeRepository({
        primaryRoot: fixture.primary,
        output: { stdout: () => undefined, stderr: () => undefined },
      }),
    },
    {
      issueNumber: context.issue.number,
      primaryRoot: fixture.primary,
      invocationRoot: fixture.primary,
      apply,
    },
  )
}

async function createGitFixture(
  scripts: Record<string, string> = {},
): Promise<GitFixture> {
  const root = await mkdtemp(join(tmpdir(), 'hvir-issue-start-'))
  const fixture = { root, primary: join(root, 'hvir') }
  fixtures.push(fixture)
  const origin = join(root, 'origin.git')
  execFileSync('git', ['init', '--bare', '--initial-branch=main', origin], {
    stdio: 'ignore',
  })
  execFileSync('git', ['init', '--initial-branch=main', fixture.primary], {
    stdio: 'ignore',
  })
  git(fixture.primary, 'config', 'user.name', 'hvir test')
  git(fixture.primary, 'config', 'user.email', 'hvir-test@example.invalid')
  git(fixture.primary, 'remote', 'add', 'origin', origin)
  const packageJson = {
    name: 'hvir-issue-start-fixture',
    version: '1.0.0',
    private: true,
    scripts,
  }
  const packageLock = {
    name: packageJson.name,
    version: packageJson.version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: packageJson.name,
        version: packageJson.version,
        scripts,
      },
    },
  }
  await Promise.all([
    writeFile(
      join(fixture.primary, 'package.json'),
      `${JSON.stringify(packageJson, null, 2)}\n`,
    ),
    writeFile(
      join(fixture.primary, 'package-lock.json'),
      `${JSON.stringify(packageLock, null, 2)}\n`,
    ),
    writeFile(join(fixture.primary, '.gitignore'), 'node_modules/\nout/\n'),
  ])
  git(fixture.primary, 'add', '.')
  git(fixture.primary, 'commit', '-m', 'fixture')
  git(fixture.primary, 'push', '-u', 'origin', 'main')
  return fixture
}

function deliveryContext(
  fixture: GitFixture,
  issueNumber: number,
  delivery: {
    parent?: number
    path?: 'ordinary' | 'epic-child'
    base?: string
  } = {},
): IssueDeliveryContext {
  const parent = delivery.parent ?? null
  return {
    repository: 'jarmak-personal/hvir',
    issue: {
      number: issueNumber,
      state: 'OPEN',
      kind: {
        state: 'valid',
        label: 'kind:maintenance',
        option: 'Maintenance',
        recognizedLabels: ['kind:maintenance'],
      },
      areas: ['area:infrastructure'],
      parent:
        parent === null
          ? null
          : { repository: 'jarmak-personal/hvir', number: parent, state: 'OPEN' },
    },
    parent:
      parent === null
        ? null
        : {
            number: parent,
            state: 'OPEN',
            kind: {
              state: 'valid',
              label: 'kind:epic',
              option: 'Epic',
              recognizedLabels: ['kind:epic'],
            },
            planning: { membership: 'present', kind: 'Epic', status: 'Todo' },
          },
    delivery: {
      path: delivery.path ?? 'ordinary',
      base: delivery.base ?? 'main',
      branch: `agent/issue-${issueNumber}`,
      worktree: `${fixture.primary}-worktrees/issue-${issueNumber}`,
    },
    planning: { membership: 'present', kind: 'Maintenance', status: 'Todo' },
    openPullRequests: [],
    conflicts: [],
    ready: true,
  }
}

function metadataPort(
  evidence: Record<
    string,
    {
      number: number
      state: 'OPEN' | 'CLOSED' | 'MERGED'
      baseRefName: string
      headRefName: string
      headRefOid: string
    }
  >,
): IssueStartMetadataPort {
  return {
    listWorkflowPullRequestEvidence: vi.fn((branch: string) =>
      Promise.resolve({
        complete: true,
        pullRequests: evidence[branch] === undefined ? [] : [evidence[branch]],
      }),
    ),
  }
}

async function expectPath(path: string, exists: boolean): Promise<void> {
  if (exists) await expect(access(path)).resolves.toBeUndefined()
  else await expect(access(path)).rejects.toThrow()
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function gitWithInput(cwd: string, input: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', input }).trim()
}

function gitResult(cwd: string, ...args: string[]): number {
  try {
    execFileSync('git', args, { cwd, stdio: 'ignore' })
    return 0
  } catch (error) {
    if (error instanceof Error && 'status' in error && typeof error.status === 'number') {
      return error.status
    }
    throw error
  }
}
