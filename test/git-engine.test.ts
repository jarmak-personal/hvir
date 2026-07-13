import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { GitEngine } from '../src/main/git/git-engine'
import { LocalHost } from '../src/main/project-host'
import { localPath } from '../src/shared'

const cleanups: string[] = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true })))
})

describe('GitEngine', () => {
  it('produces index, HEAD, and branch-point inputs for one file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hvir-git-'))
    cleanups.push(root)
    git(root, ['init', '-b', 'main'])
    git(root, ['config', 'user.email', 'hvir@example.test'])
    git(root, ['config', 'user.name', 'hvir test'])
    const filename = join(root, 'file.txt')
    await writeFile(filename, 'base\n')
    git(root, ['add', 'file.txt'])
    git(root, ['commit', '-m', 'base'])
    git(root, ['checkout', '-b', 'feature'])
    await writeFile(filename, 'feature\n')
    git(root, ['add', 'file.txt'])
    git(root, ['commit', '-m', 'feature'])
    await writeFile(filename, 'dirty\n')

    const host = new LocalHost()
    const engine = new GitEngine(host, localPath(root))
    const path = localPath(filename)
    const index = await engine.diffInputs(path, 'working-tree')
    const head = await engine.diffInputs(path, 'head')
    const branchPoint = await engine.diffInputs(path, 'branch-point')

    expect(index.baseContent).toBe('feature\n')
    expect(head.baseContent).toBe('feature\n')
    expect(branchPoint.baseContent).toBe('base\n')
    expect(branchPoint.currentContent).toBe('feature\n')
    expect(branchPoint.currentLabel).toBe('HEAD')
    await host.dispose()
  })

  it('derives the git path when the project is opened through a symlink', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'hvir-git-link-'))
    cleanups.push(parent)
    const root = join(parent, 'real')
    const link = join(parent, 'linked')
    git(parent, ['init', '-b', 'main', root])
    git(root, ['config', 'user.email', 'hvir@example.test'])
    git(root, ['config', 'user.name', 'hvir test'])
    await writeFile(join(root, 'file.txt'), 'through link\n')
    git(root, ['add', 'file.txt'])
    git(root, ['commit', '-m', 'base'])
    await symlink(root, link, 'dir')

    const host = new LocalHost()
    const engine = new GitEngine(host)
    const result = await engine.diffInputs(localPath(join(link, 'file.txt')), 'head')

    expect(result.baseContent).toBe('through link\n')
    expect(result.currentContent).toBe('through link\n')
    await host.dispose()
  })

  it('keeps uncommitted work out of the branch-point group', async () => {
    const root = await repository()
    const filename = join(root, 'file.txt')
    git(root, ['checkout', '-b', 'feature'])
    await writeFile(filename, 'committed on feature\n')
    git(root, ['add', 'file.txt'])
    git(root, ['commit', '-m', 'feature'])
    await writeFile(filename, 'uncommitted line one\nuncommitted line two\n')

    const host = new LocalHost()
    const changes = await new GitEngine(host).changes(localPath(root))

    expect(changes.workingTree).toEqual([
      expect.objectContaining({ additions: 2, deletions: 1 }),
    ])
    expect(changes.branchPoint).toEqual([
      expect.objectContaining({ additions: 1, deletions: 1 }),
    ])
    await host.dispose()
  })

  it('opens a tracked deletion as a HEAD-to-empty diff', async () => {
    const root = await repository()
    const filename = join(root, 'file.txt')
    await unlink(filename)

    const host = new LocalHost()
    const engine = new GitEngine(host)
    const changes = await engine.changes(localPath(root))
    const deleted = changes.workingTree[0]

    expect(deleted?.path.path).toBe(filename)
    expect(deleted).toEqual(expect.objectContaining({ additions: 0, deletions: 1 }))
    const diff = await engine.diffInputs(localPath(filename), 'head')
    expect(diff.baseContent).toBe('base\n')
    expect(diff.currentContent).toBe('')
    await host.dispose()
  })

  it('opens a tracked deletion after its parent directory is removed', async () => {
    const root = await repository()
    await mkdir(join(root, 'removed'))
    const filename = join(root, 'removed', 'nested.txt')
    await writeFile(filename, 'nested\n')
    git(root, ['add', 'removed/nested.txt'])
    git(root, ['commit', '-m', 'nested'])
    await rm(join(root, 'removed'), { recursive: true })

    const host = new LocalHost()
    const engine = new GitEngine(host, localPath(root))
    const changes = await engine.changes(localPath(root))

    expect(changes.workingTree).toEqual([
      expect.objectContaining({ path: localPath(filename), deletions: 1 }),
    ])
    await expect(engine.diffInputs(localPath(filename), 'head')).resolves.toEqual(
      expect.objectContaining({ baseContent: 'nested\n', currentContent: '' }),
    )
    await host.dispose()
  })

  it('expands untracked directories and reports their actual line counts', async () => {
    const root = await repository()
    await mkdir(join(root, 'newdir'))
    await writeFile(join(root, 'newdir', 'one.txt'), 'one\ntwo\nthree\n')
    await writeFile(join(root, 'newdir', 'two.txt'), 'one\ntwo')

    const host = new LocalHost()
    const changes = await new GitEngine(host).changes(localPath(root))

    expect(changes.workingTree).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: localPath(join(root, 'newdir', 'one.txt')),
          untracked: true,
          additions: 3,
        }),
        expect.objectContaining({
          path: localPath(join(root, 'newdir', 'two.txt')),
          untracked: true,
          additions: 2,
        }),
      ]),
    )
    expect(changes.workingTree.some((file) => file.path.path.endsWith('/newdir/'))).toBe(
      false,
    )
    await host.dispose()
  })

  it('omits fabricated counts for a large untracked binary with an unusual path', async () => {
    const root = await repository()
    const filename = join(root, 'large\tbinary.bin')
    await writeFile(filename, Buffer.alloc(2 * 1024 * 1024))

    const host = new LocalHost()
    const changes = await new GitEngine(host).changes(localPath(root))
    const binary = changes.workingTree.find((file) => file.path.path === filename)

    expect(binary?.untracked).toBe(true)
    expect(binary?.additions).toBeUndefined()
    expect(binary?.deletions).toBeUndefined()
    await host.dispose()
  })

  it('parses rename records and unquoted unicode paths from NUL output', async () => {
    const root = await repository()
    git(root, ['mv', 'file.txt', '? renamed ünicode.txt'])

    const host = new LocalHost()
    const changes = await new GitEngine(host).changes(localPath(root))

    expect(changes.workingTree).toHaveLength(1)
    expect(changes.workingTree[0]?.path.path).toBe(join(root, '? renamed ünicode.txt'))
    expect(changes.workingTree[0]?.staged).toBe(true)
    await host.dispose()
  })

  it('keeps Changes useful in an unborn repository with no default branch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hvir-git-unborn-'))
    cleanups.push(root)
    git(root, ['init'])
    await writeFile(join(root, 'first.txt'), 'first\n')
    git(root, ['add', 'first.txt'])

    const host = new LocalHost()
    const changes = await new GitEngine(host).changes(localPath(root))

    expect(changes.workingTree).toEqual([
      expect.objectContaining({ additions: 1, deletions: 0, staged: true }),
    ])
    expect(changes.branchPoint).toEqual([])
    expect(changes.repositoryState).toBe('unborn')
    expect(changes.branchPointAvailable).toBe(false)
    expect(changes.branchPointUnavailableReason).toContain('no commits')
    await host.dispose()
  })

  it('does not misidentify a feature upstream as the default branch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hvir-git-upstream-'))
    cleanups.push(root)
    git(root, ['init', '-b', 'trunk'])
    git(root, ['config', 'user.email', 'hvir@example.test'])
    git(root, ['config', 'user.name', 'hvir test'])
    await writeFile(join(root, 'file.txt'), 'base\n')
    git(root, ['add', 'file.txt'])
    git(root, ['commit', '-m', 'base'])
    git(root, ['branch', 'review-base'])
    git(root, ['checkout', '-b', 'feature'])
    git(root, ['branch', '--set-upstream-to=review-base'])
    await writeFile(join(root, 'file.txt'), 'feature\n')
    git(root, ['commit', '-am', 'feature'])

    const host = new LocalHost()
    const changes = await new GitEngine(host).changes(localPath(root))

    expect(changes.branchPointAvailable).toBe(false)
    expect(changes.branchPoint).toEqual([])
    expect(changes.branchPointUnavailableReason).toContain(
      'Cannot determine the default branch',
    )
    await host.dispose()
  })

  it('returns explicit empty states for a non-Git directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hvir-non-git-'))
    cleanups.push(root)
    const host = new LocalHost()
    const engine = new GitEngine(host)

    await expect(engine.changes(localPath(root))).resolves.toEqual({
      repositoryState: 'not-git',
      workingTree: [],
      branchPoint: [],
      branchPointAvailable: false,
      branchPointUnavailableReason: 'Not a Git repository',
    })
    await expect(engine.history(localPath(root), 50)).resolves.toEqual({
      repositoryState: 'not-git',
      commits: [],
      hasMore: false,
    })
    await host.dispose()
  })

  it('keeps Git scoped and usable when the project root is below the repository', async () => {
    const root = await repository()
    const project = join(root, 'nested')
    await mkdir(project)
    await writeFile(join(project, 'inside.txt'), 'inside base\n')
    await writeFile(join(root, 'outside.txt'), 'outside base\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-m', 'nested base'])
    await writeFile(join(project, 'inside.txt'), 'inside changed\n')
    await writeFile(join(root, 'outside.txt'), 'outside changed\n')

    const host = new LocalHost()
    const engine = new GitEngine(host, localPath(project))
    const changes = await engine.changes(localPath(project))

    expect(changes.workingTree.map((file) => file.path.path)).toEqual([
      join(project, 'inside.txt'),
    ])
    const diff = await engine.diffInputs(localPath(join(project, 'inside.txt')), 'head')
    expect(diff.baseContent).toBe('inside base\n')
    expect(diff.currentContent).toBe('inside changed\n')
    const history = await engine.history(localPath(project), 50)
    expect(history.commits.map((commit) => commit.subject)).toContain('nested base')
    await host.dispose()
  })

  it('preserves tabs in numstat paths', async () => {
    const root = await repository()
    const filename = 'tab\tname.txt'
    await writeFile(join(root, filename), 'first\n')
    git(root, ['add', filename])
    git(root, ['commit', '-m', 'tabbed path'])
    await writeFile(join(root, filename), 'first\nsecond\n')

    const host = new LocalHost()
    const engine = new GitEngine(host)
    const changes = await engine.changes(localPath(root))
    expect(changes.workingTree).toEqual([
      expect.objectContaining({
        path: localPath(join(root, filename)),
        additions: 1,
        deletions: 0,
      }),
    ])
    await host.dispose()
  })

  it('accepts SHA-256 object IDs in history, detail, diff, and blame', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hvir-git-sha256-'))
    cleanups.push(root)
    git(root, ['init', '--object-format=sha256', '-b', 'main'])
    git(root, ['config', 'user.email', 'hvir@example.test'])
    git(root, ['config', 'user.name', 'hvir test'])
    await writeFile(join(root, 'file.txt'), 'sha256\n')
    git(root, ['add', 'file.txt'])
    git(root, ['commit', '-m', 'sha256 base'])

    const host = new LocalHost()
    const engine = new GitEngine(host)
    const history = await engine.history(localPath(root), 1)
    const commit = history.commits[0]
    expect(commit?.hash).toHaveLength(64)
    const detail = await engine.commitDetail(localPath(root), commit!.hash)
    expect(detail.hash).toBe(commit!.hash)
    const diff = await engine.diffInputs(
      localPath(join(root, 'file.txt')),
      'head',
      commit!.hash,
    )
    expect(diff.currentContent).toBe('sha256\n')
    expect(await engine.blame(localPath(join(root, 'file.txt')))).toEqual([
      expect.objectContaining({ hash: commit!.hash, startLine: 1, lineCount: 1 }),
    ])
    await host.dispose()
  })

  it('pages history and opens commit detail as a historical file diff', async () => {
    const root = await repository()
    await writeFile(join(root, 'file.txt'), 'second\n')
    git(root, ['add', 'file.txt'])
    git(root, ['commit', '-m', 'second subject\n\nbody line'])

    const host = new LocalHost()
    const engine = new GitEngine(host)
    const history = await engine.history(localPath(root), 1)
    expect(history.commits).toHaveLength(1)
    expect(history.hasMore).toBe(true)

    const commit = history.commits[0]
    expect(commit).toBeDefined()
    const detail = await engine.commitDetail(localPath(root), commit!.hash)
    expect(detail.message).toContain('body line')
    expect(detail.files).toEqual([
      expect.objectContaining({ additions: 1, deletions: 1 }),
    ])

    const diff = await engine.diffInputs(
      localPath(join(root, 'file.txt')),
      'head',
      commit!.hash,
    )
    expect(diff.baseContent).toBe('base\n')
    expect(diff.currentContent).toBe('second\n')
    await host.dispose()
  })

  it('continues across every merge parent without skip rescans', async () => {
    const root = await repository()
    git(root, ['checkout', '-b', 'side'])
    await writeFile(join(root, 'side.txt'), 'side one\n')
    git(root, ['add', 'side.txt'])
    git(root, ['commit', '-m', 'side one'])
    await writeFile(join(root, 'side.txt'), 'side two\n')
    git(root, ['commit', '-am', 'side two'])
    git(root, ['checkout', 'main'])
    await writeFile(join(root, 'main.txt'), 'main one\n')
    git(root, ['add', 'main.txt'])
    git(root, ['commit', '-m', 'main one'])
    await writeFile(join(root, 'main.txt'), 'main two\n')
    git(root, ['commit', '-am', 'main two'])
    git(root, ['merge', '--no-ff', 'side', '-m', 'merge side'])
    const expected = gitOutput(root, ['log', '--topo-order', '--format=%H', '--', '.'])
      .trim()
      .split('\n')

    const host = new LocalHost()
    const engine = new GitEngine(host)
    const first = await engine.history(localPath(root), 1)
    expect(first.commits[0]?.parents).toHaveLength(2)
    expect(first.nextCursor).toBeDefined()

    // A new HEAD after page one must not perturb the opaque continuation.
    await writeFile(join(root, 'later.txt'), 'later\n')
    git(root, ['add', 'later.txt'])
    git(root, ['commit', '-m', 'later'])

    const commits = [...first.commits]
    let cursor = first.nextCursor
    while (cursor) {
      const page = await engine.history(localPath(root), 1, cursor)
      commits.push(...page.commits)
      cursor = page.nextCursor
    }
    const hashes = commits.map((commit) => commit.hash)
    // Topological order is a partial order: independent merge lanes with the
    // same commit timestamp may legitimately swap when their parent hashes
    // become the next frontier. Completeness and child-before-parent ordering
    // are the stable cursor contract.
    expect(new Set(hashes)).toEqual(new Set(expected))
    expect(new Set(hashes).size).toBe(hashes.length)
    const positions = new Map(hashes.map((hash, index) => [hash, index]))
    for (const commit of commits) {
      for (const parent of commit.parents) {
        if (positions.has(parent)) {
          expect(positions.get(commit.hash)).toBeLessThan(positions.get(parent)!)
        }
      }
    }
    await expect(
      engine.history(localPath(root), 10, 'not-a-valid-cursor'),
    ).rejects.toThrow('Invalid Git history cursor')
    await host.dispose()
  })

  it('preserves Git path-history simplification across cursor pages', async () => {
    const root = await repository()
    git(root, ['checkout', '-b', 'side'])
    const filename = join(root, 'side.txt')
    await writeFile(filename, 'side one\n')
    git(root, ['add', 'side.txt'])
    git(root, ['commit', '-m', 'side one'])
    await writeFile(filename, 'side two\n')
    git(root, ['commit', '-am', 'side two'])
    git(root, ['checkout', 'main'])
    await writeFile(join(root, 'main.txt'), 'main\n')
    git(root, ['add', 'main.txt'])
    git(root, ['commit', '-m', 'main'])
    git(root, ['merge', '--no-ff', 'side', '-m', 'merge side'])
    const expected = gitOutput(root, [
      'log',
      '--topo-order',
      '--format=%H',
      '--',
      'side.txt',
    ])
      .trim()
      .split('\n')

    const host = new LocalHost()
    const engine = new GitEngine(host, localPath(root))
    const hashes: string[] = []
    let cursor: string | undefined
    do {
      const page = await engine.history(localPath(root), 1, cursor, localPath(filename))
      hashes.push(...page.commits.map((commit) => commit.hash))
      cursor = page.nextCursor
    } while (cursor)

    expect(hashes).toEqual(expected)
    expect(new Set(hashes).size).toBe(hashes.length)
    await host.dispose()
  })

  it('compacts consecutive blame metadata into runs', async () => {
    const root = await repository()
    await writeFile(join(root, 'file.txt'), 'one\ntwo\nthree\n')
    git(root, ['commit', '-am', 'three lines'])
    const host = new LocalHost()

    const runs = await new GitEngine(host).blame(localPath(join(root, 'file.txt')))

    expect(runs).toEqual([
      expect.objectContaining({ startLine: 1, lineCount: 3, summary: 'three lines' }),
    ])
    await host.dispose()
  })
})

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'hvir-git-changes-'))
  cleanups.push(root)
  git(root, ['init', '-b', 'main'])
  git(root, ['config', 'user.email', 'hvir@example.test'])
  git(root, ['config', 'user.name', 'hvir test'])
  await writeFile(join(root, 'file.txt'), 'base\n')
  git(root, ['add', 'file.txt'])
  git(root, ['commit', '-m', 'base'])
  return root
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' })
}

function gitOutput(cwd: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
}
