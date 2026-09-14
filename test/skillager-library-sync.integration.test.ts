import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
  readFile,
  readdir,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { SkillagerCli } from '../src/main/skillager/skillager-cli'
import { SkillagerLibrarySyncOwner } from '../src/main/skillager/skillager-library-sync-owner'
import { LocalHost } from '../src/main/project-host/local-host'
import type { ExecOptions } from '../src/main/project-host/project-host'
import { localPath } from '../src/shared/host-path'
import { skillagerFixtureEnvironment } from '../src/main/smoke/skillager-fixture-environment'
import { createRendererResourceFixture } from './fixtures/renderer-resource-fixture'

const executable = process.env.HVIR_SKILLAGER_EXECUTABLE
const baseline = process.env.HVIR_SKILLAGER_APPROVAL_EXECUTABLE

/** Released pre-sync CLI supplies a real prior approval; consumer only uses current public commands. */
it.runIf(Boolean(executable && baseline)).each([true, false])(
  'public CLI sync backfills prior project approval and preserves independent canonical acceptance; Git=%s',
  async (gitHistory) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hvir-library-sync-')))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const environment = skillagerFixtureEnvironment(localPath(root), process.env)
    const calls: { args: readonly string[]; cwd?: string }[] = []
    class FixtureHost extends LocalHost {
      override defaultShell() {
        return Promise.resolve('/bin/sh')
      }
      override async exec(
        command: string,
        args: readonly string[],
        options: ExecOptions = {},
      ) {
        calls.push({ args, cwd: options.cwd?.path })
        return super.exec(command, args, {
          ...options,
          unsetEnv: [
            ...environment.unsetEnv,
            ...Object.keys(process.env).filter((key) => key.startsWith('GIT_')),
          ],
          env: { ...environment.env, ...options.env },
        })
      }
    }
    const host = new FixtureHost(),
      cli = new SkillagerCli(host, localPath(join(root, 'scratch')))
    onTestFinished(() => host.dispose())
    onTestFinished(() => cli.dispose())
    const project = localPath(join(root, 'project')),
      source = join(project.path, '.skills/example')
    await mkdir(join(root, 'home'))
    await mkdir(source, { recursive: true })
    await writeFile(join(project.path, 'pyproject.toml'), '[project]\nname = "fixture"\n')
    const body =
      '---\nname: example\ndescription: Use precise project guidance.\n---\n\nUse precise project guidance.\n'
    await writeFile(join(source, 'SKILL.md'), body)
    await writeFile(join(source, 'support.txt'), 'Preserve supporting bytes.\n')
    const baselineVersion = await host.exec(baseline!, ['--version'], { cwd: project })
    expect(baselineVersion.code).toBe(0)
    expect(baselineVersion.stdout.trim()).toBe('skillager 0.9.1')
    const approved = await host.exec(
      baseline!,
      [
        'review',
        'approve',
        '--source',
        'project',
        '--project-only',
        '--bulk-approve',
        '--json',
      ],
      { cwd: project },
    )
    expect(approved.code, approved.stderr).toBe(0)
    const signal = AbortSignal.timeout(90_000),
      selected = await cli.probe(localPath(executable!), signal)
    expect(selected.library).toBeUndefined()
    const init = await cli.initializeLibrary(
      selected,
      localPath(join(root, 'library')),
      gitHistory,
      signal,
    )
    if (init.kind !== 'ready' || !init.status.library) throw Error('Expected library')
    const selection = { ...selected, library: init.status.library }
    const before = await readFile(
      join(selection.library.root.path, '.skillager/library.json'),
      'utf8',
    )
    const initialEntries = await readdir(selection.library.skillsRoot.path)
    const legacy = await cli.probe(localPath(baseline!), signal)
    expect(legacy.version).toBe('skillager 0.9.1')
    await expect(cli.syncStatus(legacy, project, signal)).rejects.toMatchObject({
      reason: 'unsupported',
    })
    expect(calls.filter((call) => call.args.includes('sync'))).toHaveLength(1)
    expect(calls.find((call) => call.args.includes('sync'))!.args).toContain('--status')
    expect(calls.some((call) => call.args.includes('--approved'))).toBe(false)
    expect(await readdir(selection.library.skillsRoot.path)).toEqual(initialEntries)
    expect(
      await readFile(
        join(selection.library.root.path, '.skillager/library.json'),
        'utf8',
      ),
    ).toBe(before)
    const observed = await cli.syncStatus(selection, project, signal)
    expect(observed.coverage).toMatchObject({
      selectedSources: 1,
      processedSources: 1,
      complete: true,
    })
    expect(observed.candidates).toMatchObject([{ state: 'eligible-create' }])
    expect(await readdir(selection.library.skillsRoot.path)).toEqual(initialEntries)
    const resources = createRendererResourceFixture(),
      owner = resources.activateOwner()
    const sync = new SkillagerLibrarySyncOwner(cli, resources.scopes, () => ({
      selection,
      assertCurrent: () => undefined,
    }))
    onTestFinished(() => sync.dispose())
    const request = {
      connectionId: 'fixture',
      requestId: 1,
      workspaceRoot: project,
      agent: 'codex' as const,
    }
    const preparation = await sync.observe(owner, request)
    if (!preparation.ok || !preparation.value.observationId)
      throw Error('Expected complete observation')
    const applied = await sync.apply(owner, {
      ...request,
      requestId: 2,
      observationId: preparation.value.observationId,
    })
    expect(applied).toMatchObject({
      ok: true,
      value: { status: 'completed', counts: { created: 1, failed: 0 } },
    })
    const current = await cli.syncStatus(selection, project, signal),
      lineage = current.lineages[0]!
    expect(lineage).toMatchObject({
      canonical: {
        libraryId: selection.library.id,
        acceptance: 'accepted',
        reuse: 'all-projects',
      },
      sourceApproval: { scope: 'project' },
      preservation: 'verified',
    })
    expect(await readFile(join(lineage.canonical.path.path, 'SKILL.md'), 'utf8')).toBe(
      body,
    )
    expect(await readFile(join(lineage.canonical.path.path, 'support.txt'), 'utf8')).toBe(
      'Preserve supporting bytes.\n',
    )
    expect(
      (await cli.syncApproved(selection, project, signal, () => undefined)).counts,
    ).toMatchObject({ created: 0, updated: 0, unchanged: 1 })
    await writeFile(join(source, 'support.txt'), 'Original changed after approval.\n')
    const drift = await cli.syncStatus(selection, project, signal)
    expect(drift.lineages[0]!.canonical.acceptance).toBe('accepted')
    expect(drift.lineages[0]!.origins[0]!.observation.status).toBe('unapproved')
    expect(drift.lineages[0]!.origins[0]!.observation.contentHash).not.toBe(
      lineage.sourceApproval.contentHash,
    )
    expect(await readFile(join(lineage.canonical.path.path, 'support.txt'), 'utf8')).toBe(
      'Preserve supporting bytes.\n',
    )
    const nested = localPath(join(project.path, 'nested'))
    await mkdir(nested.path)
    const count = calls.filter((call) => call.args.includes('--approved')).length
    expect(
      await sync.observe(owner, { ...request, requestId: 3, workspaceRoot: nested }),
    ).toMatchObject({ ok: false, reason: 'invalid-request' })
    expect(calls.filter((call) => call.args.includes('--approved'))).toHaveLength(count)
    // A real linked worktree is its own exact public context; a nested directory is not.
    for (const args of [
      ['init', '-b', 'main'],
      ['add', 'pyproject.toml', '.skills'],
      [
        '-c',
        'user.name=Sync Fixture',
        '-c',
        'user.email=sync@example.invalid',
        'commit',
        '-m',
        'Owned fixture',
      ],
      ['worktree', 'add', '--detach', join(root, 'linked-worktree'), 'HEAD'],
    ]) {
      const result = await host.exec('git', args, { cwd: project })
      expect(result.code, result.stderr).toBe(0)
    }
    const worktree = localPath(join(root, 'linked-worktree'))
    expect((await cli.syncStatus(selection, worktree, signal)).context).toEqual(worktree)
    expect(calls.filter((call) => call.args.includes('--approved'))).toHaveLength(count)
    expect(
      await readFile(
        join(selection.library.root.path, '.skillager/library.json'),
        'utf8',
      ),
    ).toBe(before)
    const replaced = {
      ...selection,
      library: { ...selection.library, id: '12345678-1234-1234-1234-123456789012' },
    }
    await expect(cli.syncStatus(replaced, project, signal)).rejects.toMatchObject({
      reason: 'library-changed',
    })
    expect(
      calls
        .filter((call) => call.args.includes('sync'))
        .every(
          (call) =>
            call.args.includes('--expected-library-root') &&
            call.args.includes('--expected-library-id'),
        ),
    ).toBe(true)
  },
  90_000,
)
