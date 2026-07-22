import { execFile, execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const sourceCheckout = process.cwd()
const fixtureScript = join(sourceCheckout, 'scripts/create-smoke-repository.sh')
const temporaryRoots: string[] = []

describe('smoke repository fixture', () => {
  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
    )
  })

  it('constructs the deterministic Git and viewer topology from committed source', async () => {
    const sourceStatus = gitRaw(
      sourceCheckout,
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
    )
    const repository = await createFixture()

    expect(
      gitRaw(sourceCheckout, 'status', '--porcelain=v1', '--untracked-files=all'),
    ).toBe(sourceStatus)
    expect(git(repository, 'status', '--short')).toBe('')
    expect(git(repository, 'branch', '--show-current')).toBe('smoke/workflow')
    expect(git(repository, 'merge-base', 'HEAD', 'main')).toBe(
      git(repository, 'rev-parse', 'main'),
    )
    expect(git(repository, 'rev-list', '--count', 'HEAD')).toBe('2')
    expect(git(repository, 'log', '-1', '--format=%s')).toBe('Add smoke workflow history')
    expect(git(repository, 'config', '--get', 'maintenance.auto')).toBe('false')
    expect(git(repository, 'config', '--get', 'gc.auto')).toBe('0')
    expect(git(repository, 'check-ignore', '.hvir-smoke-ignored.log')).toBe(
      '.hvir-smoke-ignored.log',
    )
    expect(git(repository, 'blame', '--porcelain', 'package-lock.json')).toContain(
      'author hvir smoke',
    )
    expect(await readFile(join(repository, 'package.json'), 'utf8')).toBe(
      gitRaw(sourceCheckout, 'show', 'HEAD:package.json'),
    )
  })

  it('keeps parallel fixture repositories independent', async () => {
    const [left, right] = await Promise.all([createFixture(), createFixture()])
    const leftOnly = join(left, '.hvir-smoke-left-only.txt')
    await writeFile(leftOnly, 'left invocation\n')

    expect(left).not.toBe(right)
    expect(git(left, 'status', '--short')).toContain('?? .hvir-smoke-left-only.txt')
    expect(git(right, 'status', '--short')).toBe('')
    await expect(
      readFile(join(right, '.hvir-smoke-left-only.txt'), 'utf8'),
    ).rejects.toThrow()
  })

  it('does not inherit the invoking Git hook repository', async () => {
    const root = await makeTemporaryRoot()
    const repository = join(root, 'repository')

    await execFileAsync('bash', [fixtureScript, sourceCheckout, repository], {
      env: {
        ...process.env,
        GIT_DIR: git(sourceCheckout, 'rev-parse', '--absolute-git-dir'),
        GIT_WORK_TREE: sourceCheckout,
      },
    })

    expect(git(repository, 'branch', '--show-current')).toBe('smoke/workflow')
    expect(git(repository, 'status', '--short')).toBe('')
  })

  it('rejects a destination that already contains predecessor state', async () => {
    const root = await makeTemporaryRoot()
    const repository = join(root, 'repository')
    await writeFile(repository, 'inert predecessor\n')

    await expect(
      execFileAsync('bash', [fixtureScript, sourceCheckout, repository]),
    ).rejects.toThrow('Smoke repository path is not a directory')
  })
})

async function createFixture(): Promise<string> {
  const root = await makeTemporaryRoot()
  const repository = join(root, 'repository')
  await execFileAsync('bash', [fixtureScript, sourceCheckout, repository])
  return repository
}

async function makeTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'hvir-smoke-fixture-test-'))
  temporaryRoots.push(root)
  return root
}

function git(root: string, ...args: string[]): string
function git(root: string, ...args: string[]): string {
  return gitRaw(root, ...args).trim()
}

function gitRaw(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' })
}
