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
})

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' })
}
