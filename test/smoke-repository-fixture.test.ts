import { execFile, execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const sourceCheckout = process.cwd()
const fixtureScript = join(sourceCheckout, 'scripts/create-smoke-repository.sh')
const temporaryRoots: string[] = []
const pendingFixtureWork: Promise<unknown>[] = []
const fixtureIntegrationTimeout = 30_000

// These cases archive the committed checkout and create real Git history. Their
// finite integration allowance is separate from product and native UI deadlines.
describe('smoke repository fixture', () => {
  afterEach(async () => {
    await cleanupFixtures()
  }, fixtureIntegrationTimeout)

  fixtureCase(
    'constructs the deterministic Git and viewer topology from committed source',
    async () => {
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
      expect(git(repository, 'log', '-1', '--format=%s')).toBe(
        'Add smoke workflow history',
      )
      expect(git(repository, 'config', '--get', 'maintenance.auto')).toBe('false')
      expect(git(repository, 'config', '--get', 'gc.auto')).toBe('0')
      expect(git(repository, 'check-ignore', '.hvir-smoke-ignored.log')).toBe(
        '.hvir-smoke-ignored.log',
      )
      expect(
        git(repository, 'blame', '--porcelain', '-L', '1,1', '--', 'package-lock.json'),
      ).toContain('author hvir smoke')
      expect(await readFile(join(repository, 'package.json'), 'utf8')).toBe(
        gitRaw(sourceCheckout, 'show', 'HEAD:package.json'),
      )
    },
  )

  fixtureCase('keeps parallel fixture repositories independent', async () => {
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

  fixtureCase('does not inherit the invoking Git hook repository', async () => {
    const root = await makeTemporaryRoot()
    const repository = join(root, 'repository')

    await ownFixtureWork(() =>
      execFileAsync('bash', [fixtureScript, sourceCheckout, repository], {
        env: {
          ...process.env,
          GIT_DIR: git(sourceCheckout, 'rev-parse', '--absolute-git-dir'),
          GIT_WORK_TREE: sourceCheckout,
        },
      }),
    )

    expect(git(repository, 'branch', '--show-current')).toBe('smoke/workflow')
    expect(git(repository, 'status', '--short')).toBe('')
  })

  fixtureCase(
    'rejects a destination that already contains predecessor state',
    async () => {
      const root = await makeTemporaryRoot()
      const repository = join(root, 'repository')
      await writeFile(repository, 'inert predecessor\n')

      await expect(
        ownFixtureWork(() =>
          execFileAsync('bash', [fixtureScript, sourceCheckout, repository]),
        ),
      ).rejects.toThrow('Smoke repository path is not a directory')
    },
  )

  it('drains partial root acquisition before deleting it', async () => {
    const acquiring = makeTemporaryRoot()
    const cleanup = cleanupFixtures()
    const root = await acquiring
    await cleanup
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('drains admitted post-construction fixture work before deleting its root', async () => {
    const root = await makeTemporaryRoot()
    let complete!: () => void
    const admitted = ownFixtureWork(async () => {
      await new Promise<void>((resolve) => {
        complete = resolve
      })
      await writeFile(join(root, 'late-test-write'), 'settled\n')
    })
    // Let the admitted operation acquire its deferred completion boundary.
    await Promise.resolve()
    const cleanup = cleanupFixtures()
    await writeFile(join(root, 'still-owned'), 'pending\n')
    complete()
    await admitted
    await cleanup
    await expect(readFile(join(root, 'late-test-write'), 'utf8')).rejects.toThrow()
  })

  it('preserves construction failure and drains its parallel sibling before cleanup', async () => {
    const root = await makeTemporaryRoot()
    const failure = new Error('fixture construction failed')
    let complete!: () => void
    const late = ownFixtureWork(async () => {
      await new Promise<void>((resolve) => {
        complete = resolve
      })
      await writeFile(join(root, 'late-sibling'), 'settled\n')
    })
    const failed = ownFixtureWork(() => Promise.reject(failure))
    await expect(Promise.all([failed, late])).rejects.toBe(failure)
    const cleanup = cleanupFixtures()
    await writeFile(join(root, 'still-owned'), 'pending\n')
    complete()
    await late
    await cleanup
    await expect(readFile(join(root, 'late-sibling'), 'utf8')).rejects.toThrow()
  })
})

function fixtureCase(name: string, run: () => Promise<void>): void {
  // Vitest can time out while the callback still has filesystem work to finish.
  it(name, () => ownFixtureWork(run), fixtureIntegrationTimeout)
}

function createFixture(): Promise<string> {
  return ownFixtureWork(async () => {
    const root = await makeTemporaryRoot()
    const repository = join(root, 'repository')
    await execFileAsync('bash', [fixtureScript, sourceCheckout, repository])
    return repository
  })
}

function makeTemporaryRoot(): Promise<string> {
  return ownFixtureWork(async () => {
    const root = await mkdtemp(join(tmpdir(), 'hvir-smoke-fixture-test-'))
    temporaryRoots.push(root)
    return root
  })
}

function ownFixtureWork<T>(run: () => Promise<T>): Promise<T> {
  const construction = Promise.resolve().then(run)
  pendingFixtureWork.push(construction)
  // Keep the caller's original rejection while cleanup retains its receipt.
  void construction.catch(() => undefined)
  return construction
}

async function cleanupFixtures(): Promise<void> {
  // A partial startup can admit its next physical operation while being drained.
  while (pendingFixtureWork.length > 0) {
    await Promise.allSettled(pendingFixtureWork.splice(0))
  }
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  )
}

function git(root: string, ...args: string[]): string
function git(root: string, ...args: string[]): string {
  return gitRaw(root, ...args).trim()
}

function gitRaw(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' })
}
