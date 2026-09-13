import { createHash } from 'node:crypto'
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
import { localPath, type HostPath } from '../src/shared/host-path'
import { skillagerFixtureEnvironment } from '../src/main/smoke/skillager-fixture-environment'
import {
  skillagerProjectRows,
  skillagerRouterMember,
  skillagerWorkspaceMetadata,
} from '../src/renderer/src/skillager/skillager-model'
import { withSkillagerRouterMemberships } from '../src/shared/skillager-workspace-metadata'

const executable = process.env.HVIR_SKILLAGER_EXECUTABLE
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hvir-project-skills-')))
  const canonicalExecutable = await realpath(executable!)
  const environment = skillagerFixtureEnvironment(localPath(root), process.env)
  const calls: Array<{
    args: readonly string[]
    cwd?: string
    code: number | null
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
      const result = await super.exec(command, args, {
        ...options,
        unsetEnv: environment.unsetEnv,
        env: { ...environment.env, ...options.env },
      })
      if (command === executable || command === canonicalExecutable)
        calls.push({
          args,
          cwd: options.cwd?.path,
          code: result.code,
          bytes: Buffer.byteLength(result.stdout),
        })
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
  const project = join(root, 'project')
  await mkdir(project)
  await mkdir(join(root, 'home'))
  await writeFile(
    join(project, 'pyproject.toml'),
    '[project]\nname = "fixture"\nversion = "0.0.0"\n',
  )
  const signal = AbortSignal.timeout(90_000)
  const probe = await cli.probe(localPath(executable!), signal)
  const initialized = await cli.initializeLibrary(
    probe,
    localPath(join(root, 'library')),
    false,
    signal,
  )
  if (initialized.kind !== 'ready' || !initialized.status.library)
    throw Error('Expected fixture library')
  const selection = { ...probe, library: initialized.status.library }
  const run = async (args: readonly string[], catalog: HostPath = selection.catalog) => {
    const result = await host.exec(
      executable!,
      ['--catalog-state-dir', catalog.path, ...args],
      { cwd: localPath(project), signal, maxBuffer: 32 * 1024 * 1024 },
    )
    expect(result.code, result.stderr).toBe(0)
    return JSON.parse(result.stdout) as Record<string, unknown>
  }
  const author = async (agent: 'codex' | 'claude', slug: string, lintBlocked = false) => {
    const target = join(
      project,
      agent === 'codex' ? '.agents' : '.claude',
      'skills',
      slug,
    )
    await mkdir(target, { recursive: true })
    await writeFile(
      join(target, 'SKILL.md'),
      `---\nname: ${slug}\ndescription: A project fixture guide\n---\n# Guide\n\n${'Inspect fixture examples.\n'.repeat(24)}`,
    )
    if (lintBlocked)
      await writeFile(
        join(target, 'skillager.yaml'),
        'schema: skillager.skill.v1\nsummary: invalid manifest\naudience:\n  - user\nactivation:\n  default: manual\n',
      )
    return target
  }
  return { root, project, host, cli, selection, signal, calls, run, author }
}
async function files(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile())
        result[path.slice(root.length)] = createHash('sha256')
          .update(await readFile(path))
          .digest('hex')
    }
  }
  await walk(root)
  return result
}

it.runIf(Boolean(executable))(
  'installed CLI observes pending, blocked and lint-blocked project entries before setup without modifying source files',
  async () => {
    const f = await fixture()
    await f.author('codex', 'pending-codex')
    await f.author('claude', 'pending-claude')
    await f.author('codex', 'blocked-codex')
    await f.author('claude', 'lint-blocked-claude', true)
    await f.run(['review', 'block', 'project/blocked-codex', '--project-only', '--json'])
    const beforeProject = await files(f.project),
      beforeLibrary = await files(f.selection.library.root.path)
    const observed = await f.cli.projectMetadata(
      f.selection,
      localPath(f.project),
      'codex',
      f.signal,
    )
    expect(observed.rows.map((row) => [row.id, row.trust])).toEqual(
      expect.arrayContaining([
        ['project/pending-codex', 'discovered'],
        ['project/pending-claude', 'discovered'],
        ['project/blocked-codex', 'blocked'],
        ['project/lint-blocked-claude', 'lint_blocked'],
      ]),
    )
    expect(
      observed.rows.filter((row) => row.projectSkill?.agent === 'claude'),
    ).toHaveLength(2)
    expect(observed.rows.every((row) => row.source.ownership === 'external')).toBe(true)
    expect(observed.status).toMatchObject({
      agent: 'codex',
      canProceed: false,
      working: 'missing',
    })
    expect(JSON.stringify(observed)).not.toMatch(
      /entrypoint|approval_key|findings|Inspect fixture examples/,
    )
    expect(await files(f.project)).toEqual(beforeProject)
    expect(await files(f.selection.library.root.path)).toEqual(beforeLibrary)
    const commands = f.calls.filter(
      (call) =>
        call.args.includes('doctor') ||
        (call.args.includes('review') && !call.args.includes('block')),
    )
    expect(commands).toHaveLength(2)
    expect(
      commands.every(
        (call) => !call.args.includes('--state-dir') && call.cwd === f.project,
      ),
    ).toBe(true)
    expect(commands.find((call) => call.args.includes('doctor'))?.code).toBe(12)
  },
  90_000,
)

it.runIf(Boolean(executable)).each(['codex', 'claude'] as const)(
  'installed public %s setup and hvir readiness share real project state, preserving authored skill bytes',
  async (agent) => {
    const f = await fixture()
    const authored = await f.author(agent, 'project-guide')
    const beforeFiles = await files(authored)
    const before = await f.cli.projectStatus(
      f.selection,
      localPath(f.project),
      agent,
      f.signal,
    )
    expect(before).toMatchObject({ canProceed: false, working: 'missing' })
    await f.run([
      'review',
      'approve',
      'project/project-guide',
      '--project-only',
      '--json',
    ])
    await f.run([
      'setup',
      '--agent',
      agent,
      '--non-interactive',
      '--no-packages',
      '--summary-json',
    ])
    const after = await f.cli.projectStatus(
      f.selection,
      localPath(f.project),
      agent,
      f.signal,
    )
    expect(after).toMatchObject({
      projectRoot: localPath(f.project),
      canProceed: true,
      working: 'present',
    })
    const metadata = await f.cli.projectMetadata(
      f.selection,
      localPath(f.project),
      agent,
      f.signal,
    )
    expect(metadata.status).toMatchObject({ canProceed: true, working: 'present' })
    expect(await files(authored)).toEqual(beforeFiles)
    expect(await readdir(f.project)).not.toContain('.git')
    expect(await readdir(f.project)).not.toContain('.gitignore')
  },
  90_000,
)

it.runIf(Boolean(executable))(
  'keeps agent-qualified managed targets alongside native metadata with a 5,000-entry personal library using bounded public reads',
  async () => {
    const f = await fixture()
    await f.author('claude', 'native-guide')
    const skills = f.selection.library.skillsRoot.path
    for (let index = 0; index < 5000; index++) {
      const at = join(skills, `guide-${index}`)
      await mkdir(at)
      await writeFile(
        join(at, 'SKILL.md'),
        `---\nname: guide-${index}\ndescription: Library fixture guide\n---\n# Guide\n${'Inspect fixture examples.\n'.repeat(24)}`,
      )
    }
    const preview = await f.run(['library', 'accept', 'lib/guide-0', '--json'])
    await f.run((preview.next_command_argv as string[]).slice(1))
    for (const agent of ['codex', 'claude'])
      await f.run([
        'expose',
        'lib/guide-0',
        '--agent',
        agent,
        '--mode',
        agent === 'codex' ? 'native' : 'stub',
        '--json',
      ])
    const before = await files(f.project)
    const start = performance.now()
    const observation = await f.cli.projectMetadata(
      f.selection,
      localPath(f.project),
      'codex',
      f.signal,
    )
    const exposures = await f.cli.exposures(
      f.selection,
      {
        connectionId: 'fixture',
        requestId: 1,
        workspaceRoot: localPath(f.project),
        agent: 'codex',
        browseAgent: 'all',
      },
      f.signal,
    )
    const inventory = await f.cli.inventory(f.selection, f.signal)
    const proven =
      exposures?.filter((copy) => copy.sourceLibraryId === f.selection.library.id) ?? []
    if (process.env.HVIR_SKILLAGER_IDENTITY_CONTRACT === '1')
      expect(proven).toHaveLength(2)
    expect(exposures?.map((copy) => copy.agent).sort()).toEqual(['claude', 'codex'])
    const ids = new Set(proven.map((copy) => copy.skillId))
    const canonical = inventory.filter((row) => ids.has(row.id))
    const durationMs = performance.now() - start
    expect(inventory).toHaveLength(5000)
    expect(canonical).toHaveLength(proven.length ? 1 : 0)
    expect(
      observation.rows.some(
        (row) => row.projectSkill?.path.path === exposures?.[0]?.target.path,
      ),
    ).toBe(false)
    const rows = skillagerProjectRows({
      rows: [...observation.rows, ...canonical],
      exposures,
      checkedAt: Date.now(),
      durationMs,
    })
    expect(rows).toHaveLength(3)
    for (const copy of rows.filter((row) => row.workspace)) {
      expect(copy.source).toMatchObject(
        proven.length
          ? { ownership: 'library', libraryId: f.selection.library.id }
          : { ownership: 'unknown' },
      )
      expect(copy.workspace?.skillId).toBe('lib/guide-0')
    }
    expect(await files(f.project)).toEqual(before)
    expect(durationMs).toBeLessThan(30_000)
    const reads = f.calls.filter(
      (call) =>
        call.args.includes('doctor') ||
        call.args.includes('review') ||
        call.args.includes('refresh') ||
        call.args.includes('--list'),
    )
    console.log(
      JSON.stringify({
        projectMixedCapacity: {
          owned: inventory.length,
          visible: rows.length,
          durationMs: Math.round(durationMs),
          reads: reads.map((call) => ({ code: call.code, bytes: call.bytes })),
        },
      }),
    )
  },
  120_000,
)

it.runIf(Boolean(executable))(
  'installed public project identity refuses a registered nested folder without silently observing or setting up its parent',
  async () => {
    const f = await fixture(),
      nested = join(f.project, 'nested')
    await mkdir(nested)
    const before = await files(f.project)
    await expect(
      f.cli.projectMetadata(f.selection, localPath(nested), 'codex', f.signal),
    ).rejects.toMatchObject({ reason: 'invalid-request' })
    expect(f.calls.filter((call) => call.args.includes('review'))).toHaveLength(0)
    expect(await files(f.project)).toEqual(before)
  },
  90_000,
)

it.runIf(Boolean(executable) && process.env.HVIR_SKILLAGER_IDENTITY_CONTRACT === '1')(
  'preserves actual public copy/member UUIDs across two libraries with identical skill IDs and bytes',
  async () => {
    const f = await fixture()
    const body =
      '---\nname: Identity guide\ndescription: A precise identity fixture\n---\n# Guide\nInspect only fixture examples.\n'
    const authorLibrary = async (root: string, catalog: HostPath) => {
      await mkdir(join(root, 'skills', 'x'))
      await writeFile(join(root, 'skills', 'x', 'SKILL.md'), body)
      const preview = await f.run(['library', 'accept', 'lib/x', '--json'], catalog)
      await f.run((preview.next_command_argv as string[]).slice(1), catalog)
    }
    await authorLibrary(f.selection.library.root.path, f.selection.catalog)
    await f.run(['expose', 'lib/x', '--agent', 'codex', '--mode', 'native', '--json'])
    const group = await f.run([
      'expose',
      '--agent',
      'claude',
      '--scope',
      'project',
      '--dry-run',
      '--json',
      '--request-json',
      JSON.stringify({
        schema: 'skillager.exposure-request.v1',
        action: 'group',
        name: 'Identity fixture',
        library_id: f.selection.library.id,
        members: ['lib/x'],
        replace: [],
      }),
    ])
    await f.run((group.next_command_argv as string[]).slice(1))
    const before = await files(f.project)
    const request = {
      connectionId: 'fixture',
      requestId: 1,
      workspaceRoot: localPath(f.project),
      agent: 'codex' as const,
      browseAgent: 'all' as const,
    }
    const inventoryA = await f.cli.inventory(f.selection, f.signal)
    const exposuresA = await f.cli.exposures(f.selection, request, f.signal)
    expect(exposuresA).toHaveLength(2)
    expect(exposuresA?.find((copy) => !copy.router)?.sourceLibraryId).toBe(
      f.selection.library.id,
    )
    const routerA = exposuresA?.find((copy) => copy.router)
    expect(routerA?.router?.memberSources).toEqual([
      { skillId: 'lib/x', sourceLibraryId: f.selection.library.id },
    ])
    const associatedA = withSkillagerRouterMemberships(inventoryA, exposuresA)
    expect(associatedA[0]!.workspaceRouterCount).toBe(1)
    const canonicalA = new Map(
      inventoryA.map((row) => [JSON.stringify([row.source.libraryId, row.id]), row]),
    )
    expect(skillagerRouterMember(routerA!, 'lib/x', canonicalA).source.ownership).toBe(
      'library',
    )
    const projectedA = skillagerWorkspaceMetadata({
      rows: associatedA,
      exposures: exposuresA,
      checkedAt: 1,
      durationMs: 1,
    })
    expect(projectedA[0]!.workspaceCopies).toHaveLength(1)
    expect(projectedA[0]!.exposure).toBe('project')

    const catalogB = localPath(join(f.root, 'catalog-b'))
    const selectionB = { ...f.selection, catalog: catalogB, library: undefined }
    const initializedB = await f.cli.initializeLibrary(
      selectionB,
      localPath(join(f.root, 'library-b')),
      false,
      f.signal,
    )
    if (initializedB.kind !== 'ready' || !initializedB.status.library)
      throw Error('Expected second fixture library')
    const selectedB = { ...selectionB, library: initializedB.status.library }
    expect(selectedB.library.id).not.toBe(f.selection.library.id)
    await authorLibrary(selectedB.library.root.path, catalogB)
    const inventoryB = await f.cli.inventory(selectedB, f.signal)
    expect(inventoryB[0]!.id).toBe(inventoryA[0]!.id)
    expect(inventoryB[0]!.contentHash).toBe(inventoryA[0]!.contentHash)
    const exposuresB = await f.cli.exposures(selectedB, request, f.signal)
    expect(exposuresB).toHaveLength(2)
    expect(exposuresB?.find((copy) => !copy.router)?.sourceLibraryId).toBe(
      f.selection.library.id,
    )
    const routerB = exposuresB?.find((copy) => copy.router)
    expect(routerB?.router?.memberSources).toEqual(routerA?.router?.memberSources)
    const associatedB = withSkillagerRouterMemberships(inventoryB, exposuresB)
    expect(associatedB[0]!.workspaceRouterCount).toBe(0)
    const resultB = {
      rows: associatedB,
      exposures: exposuresB,
      checkedAt: 2,
      durationMs: 1,
    }
    expect(skillagerWorkspaceMetadata(resultB)[0]!.workspaceCopies).toEqual([])
    expect(skillagerWorkspaceMetadata(resultB)[0]!.exposure).toBe('hidden')
    expect(skillagerProjectRows(resultB)).toHaveLength(2)
    expect(
      skillagerProjectRows(resultB).every((row) => row.source.ownership === 'unknown'),
    ).toBe(true)
    const canonicalB = new Map(
      inventoryB.map((row) => [JSON.stringify([row.source.libraryId, row.id]), row]),
    )
    expect(skillagerRouterMember(routerB!, 'lib/x', canonicalB).source.ownership).toBe(
      'unknown',
    )
    expect(await files(f.project)).toEqual(before)
  },
  90_000,
)
