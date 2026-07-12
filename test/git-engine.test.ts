import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
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
    const engine = new GitEngine(host)
    const path = localPath(filename)
    const index = await engine.diffInputs(path, 'working-tree')
    const head = await engine.diffInputs(path, 'head')
    const branchPoint = await engine.diffInputs(path, 'branch-point')

    expect(index.baseContent).toBe('feature\n')
    expect(head.baseContent).toBe('feature\n')
    expect(branchPoint.baseContent).toBe('base\n')
    expect(branchPoint.currentContent).toBe('dirty\n')
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

  it('pages history and opens commit detail as a historical file diff', async () => {
    const root = await repository()
    await writeFile(join(root, 'file.txt'), 'second\n')
    git(root, ['add', 'file.txt'])
    git(root, ['commit', '-m', 'second subject\n\nbody line'])

    const host = new LocalHost()
    const engine = new GitEngine(host)
    const history = await engine.history(localPath(root), 0, 1)
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
