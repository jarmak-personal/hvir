import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { GitWorktreeRepository } from '../scripts/issue-worktree/git-worktree-repository.ts'
import type {
  PullRequestLookup,
  PullRequestMetadata,
} from '../scripts/issue-worktree/github-pull-requests.ts'
import { runIssueWorktreeLifecycle } from '../scripts/issue-worktree/lifecycle.ts'
import { NodeSystemRunner } from '../scripts/issue-worktree/system-runner.ts'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('issue worktree lifecycle', () => {
  it('creates and reuses the exact issue branch and worktree from an explicit base', async () => {
    const fixture = await createFixture()
    await writeFile(path.join(fixture.primary, 'README.md'), 'dirty tracked state\n')
    await writeFile(path.join(fixture.primary, 'scratch.txt'), 'dirty untracked state\n')
    await mkdir(path.join(fixture.primary, 'node_modules'))
    await writeFile(
      path.join(fixture.primary, 'node_modules', 'cache'),
      'dirty ignored state\n',
    )

    const dryRun = await fixture.run({
      issueNumber: 129,
      baseRef: 'refs/heads/main',
      apply: false,
    })
    expect(dryRun.selection).toMatchObject({
      branchRef: 'refs/heads/agent/issue-129',
      status: 'would-create',
    })
    expect(await fixture.repository.pathExists(dryRun.selection.path)).toBe(false)

    const applied = await fixture.run({
      issueNumber: 129,
      baseRef: 'refs/heads/main',
      apply: true,
    })
    expect(applied.selection.status).toBe('created')
    expect(await fixture.repository.pathExists(applied.selection.path)).toBe(true)
    await expect(fixture.repository.upstreamState(129)).resolves.toEqual({
      configuredForOrigin: true,
      remoteRef: 'refs/remotes/origin/agent/issue-129',
      remoteRefExists: false,
    })
    expect(await readFixtureFile(fixture.primary, 'README.md')).toBe(
      'dirty tracked state\n',
    )
    expect(await readFixtureFile(fixture.primary, 'scratch.txt')).toBe(
      'dirty untracked state\n',
    )
    expect(await readFixtureFile(fixture.primary, 'node_modules/cache')).toBe(
      'dirty ignored state\n',
    )

    await writeFile(path.join(applied.selection.path, 'in-progress.txt'), 'preserved\n')
    const reused = await fixture.run({
      issueNumber: 129,
      baseRef: 'refs/heads/main',
      apply: false,
    })
    expect(reused.selection.status).toBe('reused')
    expect(reused.reconciliation[0]).toMatchObject({
      issueNumber: 129,
      status: 'retained',
    })
    expect(await readFixtureFile(applied.selection.path, 'in-progress.txt')).toBe(
      'preserved\n',
    )
  })

  it('stops on a changed base, unowned branch, or deterministic path collision', async () => {
    const fixture = await createFixture()
    await fixture.run({ issueNumber: 129, baseRef: 'refs/heads/main', apply: true })

    await expect(
      fixture.run({
        issueNumber: 129,
        baseRef: 'refs/remotes/origin/main',
        apply: false,
      }),
    ).rejects.toThrow('was created from refs/heads/main')

    git(fixture.primary, ['branch', 'agent/issue-130', 'main'])
    await expect(
      fixture.run({ issueNumber: 130, baseRef: 'refs/heads/main', apply: false }),
    ).rejects.toThrow('already exists without workflow ownership')

    const collisionPath = fixture.repository.expectedPath(131)
    await mkdir(collisionPath, { recursive: true })
    await expect(
      fixture.run({ issueNumber: 131, baseRef: 'refs/heads/main', apply: false }),
    ).rejects.toThrow('deterministic path already exists on disk')
  })

  it('dry-runs and applies exact-head cleanup without touching unrelated worktrees', async () => {
    const fixture = await createFixture()
    const created = await fixture.run({
      issueNumber: 129,
      baseRef: 'refs/heads/main',
      apply: true,
    })
    const headOid = await fixture.commitAndRetire(129, 'candidate.ts')
    fixture.pullRequests.setMerged(129, headOid, 'main')

    const unrelated = path.join(fixture.root, 'unrelated-worktree')
    git(fixture.primary, ['worktree', 'add', '-b', 'user/experiment', unrelated, 'main'])
    await writeFile(path.join(unrelated, 'notes.txt'), 'do not touch\n')

    const dryRun = await fixture.run({
      issueNumber: 130,
      baseRef: 'refs/heads/main',
      apply: false,
    })
    expect(dryRun.reconciliation).toContainEqual({
      issueNumber: 129,
      branchRef: 'refs/heads/agent/issue-129',
      path: created.selection.path,
      status: 'would-remove',
      reasons: [],
      pullRequestNumber: 1129,
    })
    expect(dryRun.selection.status).toBe('would-create')
    expect(await fixture.repository.pathExists(created.selection.path)).toBe(true)
    expect(await readFixtureFile(unrelated, 'notes.txt')).toBe('do not touch\n')

    const applied = await fixture.run({
      issueNumber: 130,
      baseRef: 'refs/heads/main',
      apply: true,
    })
    expect(applied.reconciliation[0]?.status).toBe('removed')
    expect(applied.selection.status).toBe('created')
    expect(await fixture.repository.pathExists(created.selection.path)).toBe(false)
    expect(
      await fixture.repository.branchOid('refs/heads/agent/issue-129'),
    ).toBeUndefined()
    expect(
      git(fixture.primary, ['config', '--get', 'branch.agent/issue-129.remote'], [0, 1]),
    ).toBe(1)
    expect(
      (await fixture.repository.listOwnedRecords()).map((record) => record.issueNumber),
    ).toEqual([130])
    expect(await readFixtureFile(unrelated, 'notes.txt')).toBe('do not touch\n')
  })

  it('allows only known disposable ignored artifacts during cleanup', async () => {
    const fixture = await createFixture()
    const created = await fixture.run({
      issueNumber: 129,
      baseRef: 'refs/heads/main',
      apply: true,
    })
    const headOid = await fixture.commitAndRetire(129, 'candidate.ts')
    fixture.pullRequests.setMerged(129, headOid, 'main')

    await mkdir(path.join(created.selection.path, 'node_modules', 'pkg'), {
      recursive: true,
    })
    await writeFile(
      path.join(created.selection.path, 'node_modules', 'pkg', 'cache'),
      'ok\n',
    )
    const safeIgnored = await fixture.run({
      issueNumber: 130,
      baseRef: 'refs/heads/main',
      apply: false,
    })
    expect(safeIgnored.reconciliation[0]?.status).toBe('would-remove')

    await writeFile(
      path.join(fixture.primary, '.git', 'info', 'exclude'),
      '.private-cache/\n',
      {
        flag: 'a',
      },
    )
    await mkdir(path.join(created.selection.path, '.private-cache'))
    await writeFile(
      path.join(created.selection.path, '.private-cache', 'token'),
      'retain\n',
    )
    const unsafeIgnored = await fixture.run({
      issueNumber: 130,
      baseRef: 'refs/heads/main',
      apply: false,
    })
    expect(unsafeIgnored.reconciliation[0]).toMatchObject({
      status: 'retained',
      reasons: [expect.stringContaining('non-disposable ignored state')],
    })
  })

  it.each([
    {
      name: 'tracked changes',
      arrange: (_fixture: Fixture, worktreePath: string) =>
        writeFile(path.join(worktreePath, 'candidate.ts'), 'changed after review\n'),
      reason: 'tracked or untracked state exists',
    },
    {
      name: 'untracked files',
      arrange: (_fixture: Fixture, worktreePath: string) =>
        writeFile(path.join(worktreePath, 'scratch.txt'), 'retain\n'),
      reason: 'tracked or untracked state exists',
    },
    {
      name: 'locked state',
      arrange: (fixture: Fixture, worktreePath: string) => {
        git(fixture.primary, [
          'worktree',
          'lock',
          '--reason',
          'manual hold',
          worktreePath,
        ])
        return Promise.resolve()
      },
      reason: 'worktree is locked',
    },
    {
      name: 'detached state',
      arrange: (_fixture: Fixture, worktreePath: string) => {
        git(worktreePath, ['checkout', '--detach'])
        return Promise.resolve()
      },
      reason: 'detached worktree',
    },
  ])('retains $name without blocking another issue', async ({ arrange, reason }) => {
    const fixture = await createFixture()
    const created = await fixture.run({
      issueNumber: 129,
      baseRef: 'refs/heads/main',
      apply: true,
    })
    const headOid = await fixture.commitAndRetire(129, 'candidate.ts')
    fixture.pullRequests.setMerged(129, headOid, 'main')
    await arrange(fixture, created.selection.path)

    const report = await fixture.run({
      issueNumber: 130,
      baseRef: 'refs/heads/main',
      apply: false,
    })
    const retained = report.reconciliation[0]
    expect(retained).toMatchObject({
      issueNumber: 129,
      status: 'retained',
    })
    expect(retained?.reasons.some((candidate) => candidate.includes(reason))).toBe(true)
    expect(report.selection.status).toBe('would-create')
  })

  it('retains a later local commit that no merged PR records', async () => {
    const fixture = await createFixture()
    const created = await fixture.run({
      issueNumber: 129,
      baseRef: 'refs/heads/main',
      apply: true,
    })
    const reviewedHead = await fixture.commitAndRetire(129, 'candidate.ts')
    fixture.pullRequests.setMerged(129, reviewedHead, 'main')

    await writeFile(path.join(created.selection.path, 'later.ts'), 'later\n')
    git(created.selection.path, ['add', 'later.ts'])
    git(created.selection.path, ['commit', '-m', 'later local commit'])

    const report = await fixture.run({
      issueNumber: 130,
      baseRef: 'refs/heads/main',
      apply: false,
    })
    expect(report.reconciliation[0]).toMatchObject({
      status: 'retained',
      reasons: ['no merged pull request records the exact local head and base'],
    })
  })

  it('requires both a pruned upstream and an exact merged pull request', async () => {
    const fixture = await createFixture()
    await fixture.run({ issueNumber: 129, baseRef: 'refs/heads/main', apply: true })
    const headOid = await fixture.commitAndPush(129, 'candidate.ts')
    fixture.pullRequests.setMerged(129, headOid, 'main')

    const remoteStillPresent = await fixture.run({
      issueNumber: 130,
      baseRef: 'refs/heads/main',
      apply: false,
    })
    expect(remoteStillPresent.reconciliation[0]?.reasons).toContain(
      'the pruned upstream ref refs/remotes/origin/agent/issue-129 still exists',
    )

    git(fixture.repository.expectedPath(129), [
      'push',
      'origin',
      '--delete',
      'agent/issue-129',
    ])
    fixture.pullRequests.setOpen(129, headOid, 'main')
    const openPullRequest = await fixture.run({
      issueNumber: 130,
      baseRef: 'refs/heads/main',
      apply: false,
    })
    expect(openPullRequest.reconciliation[0]?.reasons).toEqual([
      'an associated pull request is still open',
      'no merged pull request records the exact local head and base',
    ])
  })

  it('cleans an unmerged-to-base head for an epic-target PR without ancestry assumptions', async () => {
    const fixture = await createFixture()
    git(fixture.primary, ['branch', 'epic/127-agent-workflow', 'main'])
    const created = await fixture.run({
      issueNumber: 129,
      baseRef: 'refs/heads/epic/127-agent-workflow',
      apply: true,
    })
    const headOid = await fixture.commitAndRetire(129, 'candidate.ts')
    fixture.pullRequests.setMerged(129, headOid, 'epic/127-agent-workflow')

    expect(
      git(fixture.primary, ['merge-base', '--is-ancestor', headOid, 'main'], [0, 1]),
    ).toBe(1)
    const report = await fixture.run({
      issueNumber: 130,
      baseRef: 'refs/heads/main',
      apply: true,
    })
    expect(report.reconciliation[0]?.status).toBe('removed')
    expect(await fixture.repository.pathExists(created.selection.path)).toBe(false)
  })
})

class FakePullRequests implements PullRequestLookup {
  private readonly byHead = new Map<string, PullRequestMetadata[]>()

  setMerged(issueNumber: number, headRefOid: string, baseRefName: string): void {
    const headRefName = `agent/issue-${issueNumber}`
    this.byHead.set(headRefName, [
      {
        number: 1000 + issueNumber,
        state: 'MERGED',
        mergedAt: '2026-07-21T12:00:00Z',
        headRefName,
        headRefOid,
        baseRefName,
      },
    ])
  }

  setOpen(issueNumber: number, headRefOid: string, baseRefName: string): void {
    const headRefName = `agent/issue-${issueNumber}`
    this.byHead.set(headRefName, [
      {
        number: 1000 + issueNumber,
        state: 'OPEN',
        headRefName,
        headRefOid,
        baseRefName,
      },
    ])
  }

  listByHead(headRefName: string): Promise<PullRequestMetadata[]> {
    return Promise.resolve(this.byHead.get(headRefName) ?? [])
  }
}

interface Fixture {
  root: string
  primary: string
  repository: GitWorktreeRepository
  pullRequests: FakePullRequests
  run: typeof runIssueWorktreeLifecycle extends (
    repository: never,
    pullRequests: never,
    input: infer Input,
  ) => infer Output
    ? (input: Input) => Output
    : never
  commitAndRetire(issueNumber: number, fileName: string): Promise<string>
  commitAndPush(issueNumber: number, fileName: string): Promise<string>
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'hvir-issue-worktree-'))
  temporaryRoots.push(root)
  const primary = path.join(root, 'repo')
  const remote = path.join(root, 'remote.git')
  await mkdir(primary)
  git(root, ['init', '--bare', remote])
  git(primary, ['init', '-b', 'main'])
  git(primary, ['config', 'user.email', 'test@example.com'])
  git(primary, ['config', 'user.name', 'Test'])
  await writeFile(
    path.join(primary, '.gitignore'),
    'node_modules/\nout/\ndist/\ncoverage/\n',
  )
  await writeFile(path.join(primary, 'README.md'), 'fixture\n')
  git(primary, ['add', '.'])
  git(primary, ['commit', '-m', 'base'])
  git(primary, ['remote', 'add', 'origin', remote])
  git(primary, ['push', '-u', 'origin', 'main'])

  const repository = await GitWorktreeRepository.open(new NodeSystemRunner(), primary)
  const pullRequests = new FakePullRequests()
  const commitAndPush = async (
    issueNumber: number,
    fileName: string,
  ): Promise<string> => {
    const worktreePath = repository.expectedPath(issueNumber)
    await writeFile(path.join(worktreePath, fileName), 'candidate\n')
    git(worktreePath, ['add', fileName])
    git(worktreePath, ['commit', '-m', `issue ${issueNumber}`])
    git(worktreePath, ['push'])
    return gitOutput(worktreePath, ['rev-parse', 'HEAD'])
  }
  return {
    root,
    primary,
    repository,
    pullRequests,
    run: (input) => runIssueWorktreeLifecycle(repository, pullRequests, input),
    async commitAndRetire(issueNumber, fileName) {
      const headOid = await commitAndPush(issueNumber, fileName)
      const worktreePath = repository.expectedPath(issueNumber)
      git(worktreePath, ['push', 'origin', '--delete', `agent/issue-${issueNumber}`])
      return headOid
    },
    commitAndPush,
  }
}

function git(cwd: string, args: readonly string[], acceptedExitCodes = [0]): number {
  try {
    execFileSync('git', [...args], { cwd, encoding: 'utf8', stdio: 'pipe' })
    return 0
  } catch (error) {
    const status =
      typeof error === 'object' && error !== null && 'status' in error
        ? Number(error.status)
        : 1
    if (acceptedExitCodes.includes(status)) return status
    throw error
  }
}

function gitOutput(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()
}

function readFixtureFile(cwd: string, fileName: string): Promise<string> {
  return readFile(path.join(cwd, fileName), 'utf8')
}
