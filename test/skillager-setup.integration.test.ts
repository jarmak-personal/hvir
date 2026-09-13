import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { SkillagerCli } from '../src/main/skillager/skillager-cli'
import { LocalHost } from '../src/main/project-host/local-host'
import type { ExecOptions } from '../src/main/project-host/project-host'
import type { ExecResult } from '../src/shared/fs-types'
import { localPath } from '../src/shared/host-path'
import { skillagerFixtureEnvironment } from '../src/main/smoke/skillager-fixture-environment'

const executable = process.env.HVIR_SKILLAGER_EXECUTABLE
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hvir-library-setup-')))
  const environment = skillagerFixtureEnvironment(localPath(root), process.env)
  const calls: Array<{ args: readonly string[]; cwd?: string; result: ExecResult }> = []
  class FixtureHost extends LocalHost {
    override defaultShell() {
      return Promise.resolve('/bin/sh')
    }
    override async exec(
      command: string,
      args: readonly string[],
      options: ExecOptions = {},
    ) {
      const result = await super.exec(command, args, {
        ...options,
        unsetEnv: [
          ...environment.unsetEnv,
          ...Object.keys(process.env).filter((key) => key.startsWith('GIT_')),
        ],
        env: { ...environment.env, ...options.env },
      })
      if (args.includes('init')) calls.push({ args, cwd: options.cwd?.path, result })
      return result
    }
  }
  const host = new FixtureHost(),
    cli = new SkillagerCli(host, localPath(join(root, 'scratch')))
  onTestFinished(async () => {
    await cli.dispose()
    await host.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await mkdir(join(root, 'home'))
  const signal = AbortSignal.timeout(60_000)
  const selection = await cli.probe(localPath(executable!), signal)
  return { root, host, cli, signal, selection, calls, environment }
}

it.runIf(Boolean(executable)).each([true, false])(
  'installed CLI creates and verifies a confined personal library with Git=%s, idempotent identity and ordinary reads',
  async (gitHistory) => {
    const f = await fixture()
    expect(f.selection.library).toBeUndefined()
    expect(f.calls).toHaveLength(0)
    const target = await f.cli.defaultLibraryRoot(f.selection)
    expect(target).toEqual(localPath(join(f.root, 'home/.skillager/library')))
    const initialized = await f.cli.initializeLibrary(
      f.selection,
      target,
      gitHistory,
      f.signal,
    )
    expect(initialized.kind).toBe('ready')
    if (initialized.kind !== 'ready' || !initialized.status.library)
      throw Error('Expected verified setup')
    expect(initialized.status.gitHistory).toBe(gitHistory)
    expect(await readdir(target.path)).toEqual(
      expect.arrayContaining(['.skillager', 'skills', ...(gitHistory ? ['.git'] : [])]),
    )
    if (!gitHistory)
      await expect(access(join(target.path, '.git'))).rejects.toMatchObject({
        code: 'ENOENT',
      })
    const connected = { ...f.selection, library: initialized.status.library }
    await f.cli.validate(connected, f.signal)
    expect(await f.cli.inventory(connected, f.signal)).toEqual([])
    expect(
      await f.cli.search(
        connected,
        {
          connectionId: 'fixture',
          requestId: 1,
          workspaceRoot: localPath(join(f.root, 'unrelated-workspace')),
          agent: 'codex',
          query: 'first skill',
          scope: 'library',
        },
        f.signal,
      ),
    ).toEqual([])
    expect(
      await f.cli.initializeLibrary(f.selection, target, !gitHistory, f.signal),
    ).toEqual(initialized)
    expect((await f.cli.probe(localPath(executable!), f.signal)).library).toEqual(
      connected.library,
    )
    expect(
      f.calls.every((call) => call.cwd?.startsWith(join(f.root, 'scratch/skillager-'))),
    ).toBe(true)
    await expect(access(join(f.root, 'unrelated-workspace'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await f.cli.dispose()
    expect(await readdir(join(f.root, 'scratch'))).toEqual([])
    expect(
      await readFile(join(target.path, '.skillager/library.json'), 'utf8'),
    ).toContain(initialized.status.library.id)
  },
  60_000,
)

it.runIf(Boolean(executable))(
  'installed CLI refuses a conflicting registration without creating the second library',
  async () => {
    const f = await fixture(),
      target = localPath(join(f.root, 'library'))
    const first = await f.cli.initializeLibrary(f.selection, target, false, f.signal)
    expect(first.kind).toBe('ready')
    const other = localPath(join(f.root, 'other-library'))
    await expect(
      f.cli.initializeLibrary(f.selection, other, true, f.signal),
    ).rejects.toMatchObject({ reason: 'uncertain' })
    await expect(access(other.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await f.cli.libraryStatus(f.selection, f.signal)).library?.root).toEqual(
      target,
    )
  },
  60_000,
)

it.runIf(Boolean(executable))(
  'installed Git-unavailable preflight has the exact refusal envelope and no destination or registration',
  async () => {
    const f = await fixture(),
      target = localPath(join(f.root, 'missing-git-library'))
    const withoutGit = {
      ...f.selection,
      environment: { ...f.selection.environment, PATH: join(f.root, 'no-executables') },
    }
    expect(await f.cli.initializeLibrary(withoutGit, target, true, f.signal)).toEqual({
      kind: 'refused',
      message:
        'Git was not found in the selected Skillager environment. Install Git or explicitly turn off Keep Git history before creating the library.',
    })
    expect(f.calls[0]!.result).toEqual({
      code: 2,
      signal: null,
      stdout: '',
      stderr:
        'skillager: error: git executable is unavailable; install Git or run `skillager library init --no-git`\n',
    })
    await expect(access(target.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await f.cli.probe(localPath(executable!), f.signal)).library).toBeUndefined()
    expect(await f.cli.libraryStatus(f.selection, f.signal)).toEqual({})
    expect(f.calls).toHaveLength(1)
  },
  60_000,
)

it.runIf(Boolean(executable))(
  'registers an existing valid library through public init and indexes pending metadata without changing its identity or Git mode',
  async () => {
    const f = await fixture(),
      target = localPath(join(f.root, 'existing-library'))
    const original = await f.cli.initializeLibrary(f.selection, target, false, f.signal)
    if (original.kind !== 'ready' || !original.status.library)
      throw Error('Expected initial fixture library')
    const authored = await f.host.exec(
      executable!,
      [
        '--catalog-state-dir',
        f.selection.catalog.path,
        '--state-dir',
        join(f.root, 'author-state'),
        'library',
        'new',
        'first-skill',
        '--json',
      ],
      { cwd: localPath(join(f.root, 'home')), signal: f.signal },
    )
    expect(authored.code).toBe(0)
    const identityBefore = await readFile(
      join(target.path, '.skillager/library.json'),
      'utf8',
    )
    const secondCatalog = {
      ...f.selection,
      catalog: localPath(join(f.root, 'second-catalog')),
    }
    expect(await f.cli.libraryStatus(secondCatalog, f.signal)).toEqual({})
    const registered = await f.cli.initializeLibrary(
      secondCatalog,
      target,
      true,
      f.signal,
    )
    expect(registered).toEqual(original)
    expect(await readFile(join(target.path, '.skillager/library.json'), 'utf8')).toBe(
      identityBefore,
    )
    const inventory = await f.cli.inventory(
      { ...secondCatalog, library: original.status.library },
      f.signal,
    )
    expect(inventory).toHaveLength(1)
    expect(inventory[0]).toMatchObject({
      id: 'lib/first-skill',
      source: { ownership: 'library' },
    })
    expect(['reviewed', 'trusted', 'pinned']).not.toContain(inventory[0]!.trust)
    expect(Object.keys(inventory[0]!)).not.toContain('body')
    expect(f.calls.at(-1)!.result.code).toBe(0)
    expect(JSON.parse(f.calls.at(-1)!.result.stdout)).toMatchObject({
      status: 'already-initialized',
      created: false,
      indexed: 1,
    })
  },
  60_000,
)

it.runIf(Boolean(executable))(
  'canonicalizes a missing catalog through its existing symlinked ancestor and preserves that identity after creation',
  async () => {
    const f = await fixture()
    await mkdir(join(f.root, 'catalog-parent'))
    await symlink(join(f.root, 'catalog-parent'), join(f.root, 'catalog-alias'))
    f.environment.env.SKILLAGER_CATALOG_STATE_DIR = join(
      f.root,
      'catalog-alias/not-created/catalog',
    )
    const before = await f.cli.probe(localPath(executable!), f.signal)
    expect(before.catalog).toEqual(
      localPath(join(f.root, 'catalog-parent/not-created/catalog')),
    )
    await f.cli.initializeLibrary(
      before,
      localPath(join(f.root, 'alias-library')),
      false,
      f.signal,
    )
    const alias = await f.cli.probe(localPath(executable!), f.signal)
    f.environment.env.SKILLAGER_CATALOG_STATE_DIR = before.catalog.path
    const direct = await f.cli.probe(localPath(executable!), f.signal)
    expect(alias.catalog).toEqual(direct.catalog)
    expect(alias.library).toEqual(direct.library)
  },
  60_000,
)

it.runIf(Boolean(executable))(
  'refuses dangling catalog/default-library symlinks before initialization can create their targets',
  async () => {
    const f = await fixture()
    const missingCatalog = join(f.root, 'missing-catalog')
    await symlink(missingCatalog, join(f.root, 'dangling-catalog'))
    f.environment.env.SKILLAGER_CATALOG_STATE_DIR = join(f.root, 'dangling-catalog/child')
    const probe = f.cli.probe(localPath(executable!), f.signal)
    await expect(probe).rejects.toMatchObject({ reason: 'unsupported' })
    await expect(probe).rejects.toThrow('symbolic link')
    await expect(access(missingCatalog)).rejects.toMatchObject({ code: 'ENOENT' })
    const missingLibrary = join(f.root, 'missing-library-home')
    await symlink(missingLibrary, join(f.root, 'home/.skillager'))
    await expect(f.cli.defaultLibraryRoot(f.selection)).rejects.toMatchObject({
      reason: 'unsupported',
    })
    await expect(access(missingLibrary)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.calls).toHaveLength(0)
  },
  60_000,
)
