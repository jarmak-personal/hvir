import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { LocalHost } from '../src/main/project-host/local-host'
import type { ExecOptions } from '../src/main/project-host/project-host'
import { SkillagerCli } from '../src/main/skillager/skillager-cli'
import { localPath, asHostId, hostPath } from '../src/shared/host-path'
import { skillagerFixtureEnvironment } from '../src/main/smoke/skillager-fixture-environment'
import type { SkillagerSearchRequest } from '../src/shared/skillager'
import {
  skillagerMetadataKey,
  skillagerWorkspaceMetadata,
} from '../src/renderer/src/skillager/skillager-model'
import { exposureActions } from '../src/renderer/src/skillager/skillager-exposure-model'

const executable = process.env.HVIR_SKILLAGER_EXECUTABLE
it.runIf(Boolean(executable && process.env.HVIR_SKILLAGER_SEARCH_CONTRACT))(
  'preserves real grouped/copy/native/installed semantics through LocalHost and the hvir adapter',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hvir-search-contract-')))
    const environment = skillagerFixtureEnvironment(localPath(root), process.env)
    const selectedExecutable = await realpath(executable!)
    const calls: Array<{
      args: readonly string[]
      cwd?: string
      ms: number
      bytes: number
    }> = []
    class FixtureHost extends LocalHost {
      override defaultShell() {
        return Promise.resolve('/bin/sh')
      }
      override async exec(
        command: string,
        args: readonly string[],
        options: ExecOptions = {},
      ) {
        const started = performance.now()
        const result = await super.exec(command, args, {
          ...options,
          unsetEnv: environment.unsetEnv,
          env: { ...environment.env, ...options.env },
        })
        if (command === selectedExecutable)
          calls.push({
            args,
            cwd: options.cwd?.path,
            ms: performance.now() - started,
            bytes: Buffer.byteLength(result.stdout),
          })
        return result
      }
    }
    const host = new FixtureHost(),
      scratch = join(root, 'scratch')
    const cli = new SkillagerCli(host, localPath(scratch))
    onTestFinished(async () => {
      await cli.dispose()
      await host.dispose()
      await rm(root, { recursive: true, force: true })
    })
    const project = join(root, 'project'),
      destination = join(root, 'destination')
    for (const path of [project, destination, join(root, 'home')]) await mkdir(path)
    for (const path of [project, destination])
      await writeFile(
        join(path, 'pyproject.toml'),
        '[project]\nname="fixture"\nversion="0.0.0"\n',
      )
    const signal = AbortSignal.timeout(90_000)
    const probe = await cli.probe(localPath(executable!), signal)
    expect(probe.searchView).toBe('skillager.search.v1')
    expect(
      calls.filter(
        (call) => call.args.includes('search') && !call.args.includes('--help'),
      ),
    ).toHaveLength(0)
    const initialized = await cli.initializeLibrary(
      probe,
      localPath(join(root, 'library')),
      false,
      signal,
    )
    if (initialized.kind !== 'ready' || !initialized.status.library)
      throw Error('Expected library')
    const selection = { ...probe, library: initialized.status.library }
    async function run(args: readonly string[], cwd = project) {
      const result = await host.exec(
        selectedExecutable,
        ['--catalog-state-dir', selection.catalog.path, ...args],
        { cwd: localPath(cwd), signal, maxBuffer: 4 * 1024 * 1024 },
      )
      expect(result.code, result.stderr).toBe(0)
      return JSON.parse(result.stdout) as Record<string, unknown>
    }
    const originals: string[] = []
    for (const agent of ['codex', 'claude'] as const) {
      const path = join(
        project,
        agent === 'codex' ? '.agents' : '.claude',
        'skills',
        `merge-${agent}`,
      )
      await mkdir(path, { recursive: true })
      await writeFile(
        join(path, 'SKILL.md'),
        `---\nname: Merge ${agent}\ndescription: Explain merging reviewed changes.\n---\n\nUse originalneedle for the merge check.\n`,
      )
      originals.push(join(path, 'SKILL.md'))
      await run(['review', 'approve', `project/merge-${agent}`, '--json'])
    }
    const before = await Promise.all(originals.map((path) => readFile(path, 'utf8')))
    const request: SkillagerSearchRequest = {
      connectionId: 'fixture',
      requestId: 1,
      workspaceRoot: localPath(project),
      agent: 'codex',
      browseAgent: 'all',
      query: 'merge',
      scope: 'workspace',
      view: 'skills',
      includeInstalled: false,
    }
    const search = async (override: Partial<SkillagerSearchRequest> = {}) => {
      const at = calls.length,
        value = await cli.search(selection, { ...request, ...override }, signal)
      const submitted = calls
        .slice(at)
        .filter((call) => call.args.includes('search') && !call.args.includes('--help'))
      expect(submitted).toHaveLength(1)
      expect(submitted[0]!.ms).toBeLessThan(30_000)
      expect(submitted[0]!.bytes).toBeLessThanOrEqual(4 * 1024 * 1024)
      return value
    }
    expect((await search()).rows).toEqual([])
    expect((await search({ browseAgent: 'claude' })).rows).toEqual([])
    const grouped = await search({ includeInstalled: true })
    expect(grouped.rows).toHaveLength(2)
    expect(grouped.rows.every((row) => row.search?.occurrence.kind === 'library')).toBe(
      true,
    )
    const copies = await search({ includeInstalled: true, view: 'copies' })
    expect(copies.rows).toHaveLength(4)
    expect(new Set(copies.rows.map(skillagerMetadataKey)).size).toBe(4)
    const native = copies.rows.filter((row) => row.projectSkill)
    expect(native.map((row) => row.projectSkill!.agent).sort()).toEqual([
      'claude',
      'codex',
    ])
    expect(
      native.every((row) =>
        exposureActions(row).some(
          (action) => action.action === 'files' && !action.disabled,
        ),
      ),
    ).toBe(true)
    const canonical = grouped.rows[0]!
    const exposure = await run(
      ['expose', canonical.id, '--agent', 'claude', '--mode', 'stub', '--json'],
      destination,
    )
    expect(exposure).toBeTruthy()
    const inDestination = {
      workspaceRoot: localPath(destination),
      scope: 'library' as const,
    }
    expect((await search(inDestination)).rows).toHaveLength(1)
    const concrete = await search({
      ...inDestination,
      includeInstalled: true,
      view: 'copies',
    })
    const stub = concrete.rows.find((row) => row.search?.occurrence.kind === 'stub')!
    expect(stub.search?.occurrence.path.path).not.toContain('/library/')
    expect(stub.search?.match.occurrence.path.path).toContain('/library/')
    expect(stub.search?.occurrence.agent).toBe('claude')
    const observed = await cli.exposures(
      selection,
      { ...request, ...inDestination },
      signal,
    )
    const projected = skillagerWorkspaceMetadata({
      ...concrete,
      exposures: observed,
      checkedAt: Date.now(),
      durationMs: 1,
    })
    expect(
      projected.find((row) => row.search?.occurrence.kind === 'stub')?.workspace?.target,
    ).toEqual(stub.search?.occurrence.path)
    const remote = hostPath(asHostId('ssh:fixture'), '/never-executed-remotely')
    const remoteResult = await cli.search(
      selection,
      { ...request, workspaceRoot: remote, scope: 'library' },
      signal,
      {
        exposures: [
          {
            id: 'copy',
            agent: 'claude',
            target: hostPath(remote.hostId, `${remote.path}/.claude/skills/copy`),
            skillId: canonical.id,
            sourceLibraryId: selection.library.id,
            mode: 'native',
            status: 'local_edit',
          },
        ],
      },
    )
    expect(remoteResult.rows).toHaveLength(1)
    expect(remoteResult.search.coverage).toBe('hvir-deliveries')
    expect(
      calls.every(
        (call) =>
          !call.cwd?.includes(remote.path) &&
          !call.args.some((arg) => arg.includes(remote.path)),
      ),
    ).toBe(true)
    expect(
      (await readdir(join(scratch, (await readdir(scratch))[0]!))).filter((name) =>
        name.startsWith('search-installed-'),
      ),
    ).toEqual([])
    await run(['expose', canonical.id, '--agent', 'codex', '--mode', 'native', '--json'])
    const canonicalFile = canonical.search!.occurrence.entrypoint.path
    await writeFile(
      canonicalFile,
      `${await readFile(canonicalFile, 'utf8')}\nPending canonical change.\n`,
    )
    const fallback = await search({ includeInstalled: true, view: 'copies' })
    const installedFallback = fallback.rows.find(
      (row) => row.search?.occurrence.kind === 'full',
    )!
    expect(installedFallback.id).toMatch(/^project\//)
    expect(installedFallback.source.ownership).toBe('external')
    expect(installedFallback.search?.canonical?.skillId).toBe(canonical.id)
    expect(installedFallback.projectSkill).toBeUndefined()
    const pendingTarget = skillagerWorkspaceMetadata({
      ...fallback,
      checkedAt: Date.now(),
      durationMs: 1,
      exposures: await cli.exposures(selection, request, signal),
    }).find((row) => row.search?.occurrence.kind === 'full')!
    expect(pendingTarget.workspace?.skillId).toBe(canonical.id)
    expect(
      exposureActions(pendingTarget).find((action) => action.action === 'remove')
        ?.disabled,
    ).toBe(false)
    expect(
      exposureActions(pendingTarget)
        .filter((action) =>
          ['full', 'stub', 'review-update', 'group'].includes(action.action),
        )
        .every((action) => action.disabled),
    ).toBe(true)
    expect(await Promise.all(originals.map((path) => readFile(path, 'utf8')))).toEqual(
      before,
    )
    await cli.dispose()
    expect(await readdir(scratch)).toEqual([])
  },
  100_000,
)

const legacyExecutable = process.env.HVIR_SKILLAGER_LEGACY_EXECUTABLE
it.runIf(Boolean(legacyExecutable))(
  'probes the actual legacy CLI and searches only after explicit fallback with the selected agent',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hvir-search-legacy-')))
    const environment = skillagerFixtureEnvironment(localPath(root), process.env)
    const selectedExecutable = await realpath(legacyExecutable!)
    const calls: Array<readonly string[]> = []
    class FixtureHost extends LocalHost {
      override defaultShell() {
        return Promise.resolve('/bin/sh')
      }
      override exec(command: string, args: readonly string[], options: ExecOptions = {}) {
        if (command === selectedExecutable) calls.push(args)
        return super.exec(command, args, {
          ...options,
          unsetEnv: environment.unsetEnv,
          env: { ...environment.env, ...options.env },
        })
      }
    }
    const host = new FixtureHost(),
      cli = new SkillagerCli(host, localPath(join(root, 'scratch')))
    onTestFinished(async () => {
      await cli.dispose()
      await host.dispose()
      await rm(root, { recursive: true, force: true })
    })
    const project = localPath(join(root, 'project'))
    await mkdir(project.path)
    await mkdir(join(root, 'home'))
    await writeFile(
      join(project.path, 'pyproject.toml'),
      '[project]\nname="fixture"\nversion="0.0.0"\n',
    )
    const signal = AbortSignal.timeout(30_000),
      probe = await cli.probe(localPath(legacyExecutable!), signal)
    expect(probe.searchView).toBeUndefined()
    const initialized = await cli.initializeLibrary(
      probe,
      localPath(join(root, 'library')),
      false,
      signal,
    )
    if (initialized.kind !== 'ready' || !initialized.status.library)
      throw Error('Expected library')
    const selection = { ...probe, library: initialized.status.library }
    const native = join(project.path, '.claude/skills/merge')
    await mkdir(native, { recursive: true })
    const body =
      '---\nname: Merge guide\ndescription: Explain merging approved changes.\n---\n\nUse the merge guide.\n'
    await writeFile(join(native, 'SKILL.md'), body)
    const review = await host.exec(
      selectedExecutable,
      [
        '--catalog-state-dir',
        selection.catalog.path,
        'review',
        'approve',
        'project/merge',
        '--json',
      ],
      { cwd: project, signal },
    )
    expect(review.code).toBe(0)
    const request: SkillagerSearchRequest = {
      connectionId: 'fixture',
      requestId: 1,
      workspaceRoot: project,
      agent: 'codex',
      browseAgent: 'claude',
      scope: 'workspace',
      query: 'merge',
    }
    const submitted = () =>
      calls.filter((args) => args.includes('search') && !args.includes('--help'))
    await expect(cli.search(selection, request, signal)).rejects.toMatchObject({
      reason: 'search-unsupported',
    })
    expect(submitted()).toHaveLength(0)
    const fallback = await cli.search(
      selection,
      { ...request, view: 'legacy', includeInstalled: true },
      signal,
    )
    expect(submitted()).toHaveLength(1)
    expect(submitted()[0]!.slice(-2)).toEqual(['--', 'merge'])
    expect(submitted()[0]).not.toContain('--view')
    expect(submitted()[0]![submitted()[0]!.indexOf('--agent') + 1]).toBe('claude')
    expect(fallback.search).toMatchObject({
      view: 'legacy',
      includeInstalled: true,
      browseAgent: 'claude',
    })
    expect(
      fallback.rows.some(
        (row) =>
          row.projectSkill?.agent === 'claude' && row.projectSkill.path.path === native,
      ),
    ).toBe(true)
    expect(await readFile(join(native, 'SKILL.md'), 'utf8')).toBe(body)
  },
  45_000,
)
