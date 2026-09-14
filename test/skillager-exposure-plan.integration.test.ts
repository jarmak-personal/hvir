import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
  chmod,
  stat,
  access,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { localPath } from '../src/shared/host-path'
import { SKILLAGER_AGENTS } from '../src/shared/skillager'
import type { SkillagerExposureRequest } from '../src/shared/skillager-exposure'
import type { SkillagerLifecycleRequest } from '../src/shared/skillager-exposure-plan'
import { LocalHost } from '../src/main/project-host/local-host'
import type { ExecOptions } from '../src/main/project-host/project-host'
import { SkillagerCli } from '../src/main/skillager/skillager-cli'
import { skillagerFixtureEnvironment } from '../src/main/smoke/skillager-fixture-environment'

const executable = process.env.HVIR_SKILLAGER_EXECUTABLE
const legacyExecutable = process.env.HVIR_SKILLAGER_APPROVAL_EXECUTABLE
it.runIf(Boolean(executable)).each(SKILLAGER_AGENTS)(
  'uses the published CLI for $label native and router lifecycle',
  async (agent) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hvir-local-lifecycle-')))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const environment = skillagerFixtureEnvironment(localPath(root), process.env)
    class FixtureHost extends LocalHost {
      override defaultShell() {
        return Promise.resolve('/bin/sh')
      }
      override exec(command: string, args: readonly string[], options: ExecOptions = {}) {
        return super.exec(command, args, {
          ...options,
          unsetEnv: environment.unsetEnv,
          env: { ...environment.env, ...options.env },
        })
      }
    }
    const host = new FixtureHost(),
      cli = new SkillagerCli(host, localPath(join(root, 'scratch')))
    onTestFinished(() => host.dispose())
    onTestFinished(() => cli.dispose())
    const project = localPath(join(root, 'project')),
      library = join(root, 'library')
    const native = join(
      project.path,
      agent.id === 'codex' ? '.agents/skills/original' : '.claude/skills/original',
    )
    await mkdir(native, { recursive: true })
    await mkdir(join(root, 'home'))
    await writeFile(join(project.path, 'pyproject.toml'), '[project]\nname = "fixture"\n')
    const body =
      '---\nname: original\ndescription: Use precise project instructions.\n---\n\nFollow the project instructions.\n'
    await writeFile(join(native, 'SKILL.md'), body)
    await writeFile(join(native, 'support.txt'), 'Preserve this supporting material.\n')
    const run = async (args: string[]) => {
      const result = await host.exec(executable!, args, {
        cwd: project,
        maxBuffer: 4 * 1024 * 1024,
      })
      expect(result.code, result.stderr || result.stdout).toBe(0)
      return result.stdout
    }
    const second = join(
      project.path,
      agent.id === 'codex' ? '.agents/skills/second' : '.claude/skills/second',
    )
    await mkdir(second)
    await writeFile(join(second, 'SKILL.md'), body.replaceAll('original', 'second'))
    await writeFile(join(second, 'support.txt'), 'Second supporting file.\n')
    await chmod(second, 0o750)
    await run(['library', 'init', '--path', library, '--no-git', '--json'])
    await run([
      'review',
      'approve',
      '--source',
      'project',
      '--project-only',
      '--bulk-approve',
      '--json',
    ])
    const signal = AbortSignal.timeout(180_000),
      selection = await cli.probe(localPath(executable!), signal)
    const report = await cli.syncStatus(selection, project, signal)
    const lineage = report.lineages.find((item) =>
      item.origins.some((origin) => origin.path.path === native),
    )!
    expect(lineage.preservation).toBe('verified')
    const origin = lineage.origins.find((origin) => origin.path.path === native)!
    const base = {
      connectionId: 'fixture',
      requestId: 1,
      workspaceRoot: project,
      agent: agent.id,
      destination: { projectId: 'project', workspaceId: 'worktree', root: project },
    }
    const request: SkillagerLifecycleRequest = {
      ...base,
      action: 'plan',
      plan: {
        schema: 'skillager.exposure-request.v1',
        action: 'adopt-native',
        origin_id: origin.id,
        source: {
          library_id: selection.library!.id,
          skill_id: lineage.canonical.skillId,
        },
        mode: 'stub',
      },
      origins: [
        {
          originId: origin.id,
          lineageId: lineage.id,
          sourceIdentity: lineage.sourceIdentity,
          skillId: lineage.canonical.skillId,
          path: origin.path,
        },
      ],
      exposures: [],
    }
    if (legacyExecutable) {
      const legacy = await cli.probe(localPath(legacyExecutable), signal)
      expect(legacy.version).toBe('skillager 0.9.1')
      await expect(cli.previewLocalAction(legacy, request, signal)).rejects.toMatchObject(
        { reason: 'unsupported' },
      )
      expect(await readFile(join(native, 'SKILL.md'), 'utf8')).toBe(body)
    }
    const defaultPreview = await cli.previewExposure(
      selection,
      { ...base, action: 'add', skillId: lineage.canonical.skillId, mode: 'stub' },
      signal,
    )
    await cli.applyExposure(selection, defaultPreview, signal)
    expect(defaultPreview.detail.target.path).not.toBe(native)
    const defaultBefore = await readFile(
      join(defaultPreview.detail.target.path, 'skillager.materialized.yaml'),
      'utf8',
    )
    const otherProject = localPath(join(root, 'other-project'))
    await mkdir(otherProject.path)
    await writeFile(
      join(otherProject.path, 'pyproject.toml'),
      '[project]\nname = "other"\n',
    )
    const otherPreview = await cli.previewExposure(
      selection,
      {
        ...base,
        action: 'add',
        skillId: lineage.canonical.skillId,
        mode: 'native',
        destination: { projectId: 'other', workspaceId: 'other', root: otherProject },
      },
      signal,
    )
    await cli.applyExposure(selection, otherPreview, signal)
    const otherBefore = await readFile(
      join(otherPreview.detail.target.path, 'skillager.materialized.yaml'),
      'utf8',
    )
    const adopted = await cli.previewLocalAction(selection, request, signal)
    expect(adopted.detail.kind).toBe('plan')
    const result = await cli.applyLocalAction(selection, adopted, signal, () => undefined)
    expect(result).toMatchObject({ kind: 'plan', status: 'applied' })
    expect(await readFile(join(lineage.canonical.path.path, 'SKILL.md'), 'utf8')).toBe(
      body,
    )
    const copies = (await cli.exposures(selection, base, signal))!
    const copy = copies.find((item) => item.target.path === native)!
    expect(copy.mode).toBe('stub')
    const full = await cli.previewExposure(
      selection,
      {
        ...base,
        action: 'change',
        skillId: lineage.canonical.skillId,
        mode: 'native',
        exposure: copy,
      },
      signal,
    )
    expect(full.detail.target.path).toBe(native)
    await cli.applyExposure(selection, full, signal)
    expect(await readFile(join(native, 'support.txt'), 'utf8')).toBe(
      'Preserve this supporting material.\n',
    )
    expect(
      await readFile(
        join(defaultPreview.detail.target.path, 'skillager.materialized.yaml'),
        'utf8',
      ),
    ).toBe(defaultBefore)
    const secondLineage = report.lineages.find((item) =>
      item.origins.some((origin) => origin.path.path === second),
    )!
    const secondOrigin = secondLineage.origins.find(
      (origin) => origin.path.path === second,
    )!
    const removeNative: SkillagerLifecycleRequest = {
      ...base,
      action: 'plan',
      plan: {
        schema: 'skillager.exposure-request.v1',
        action: 'remove-native',
        origin_id: secondOrigin.id,
        source: {
          library_id: selection.library!.id,
          skill_id: secondLineage.canonical.skillId,
        },
      },
      origins: [
        {
          originId: secondOrigin.id,
          lineageId: secondLineage.id,
          sourceIdentity: secondLineage.sourceIdentity,
          skillId: secondLineage.canonical.skillId,
          path: secondOrigin.path,
        },
      ],
      exposures: [],
    }
    await writeFile(join(second, '.DS_Store'), 'Unpreserved material must remain.')
    await expect(
      cli.previewLocalAction(selection, removeNative, signal),
    ).rejects.toMatchObject({ reason: 'review-refused' })
    expect(await readFile(join(second, '.DS_Store'), 'utf8')).toBe(
      'Unpreserved material must remain.',
    )
    await rm(join(second, '.DS_Store'))
    const nativeRemoval = await cli.previewLocalAction(selection, removeNative, signal)
    if (nativeRemoval.detail.kind !== 'plan')
      throw new Error('Expected native removal plan')
    expect(
      nativeRemoval.detail.targets.find((target) => target.path.path === second),
    ).toMatchObject({
      action: 'remove',
      before: { mode: 0o750 },
      after: null,
    })
    expect(
      nativeRemoval.detail.targets.find((target) => target.path.path === second)?.effects,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'support.txt', action: 'remove' }),
      ]),
    )
    await chmod(second, 0o700)
    await expect(
      cli.applyLocalAction(selection, nativeRemoval, signal, () => undefined),
    ).rejects.toMatchObject({ reason: 'review-refused' })
    expect((await stat(second)).mode & 0o777).toBe(0o700)
    expect(await readFile(join(second, 'support.txt'), 'utf8')).toBe(
      'Second supporting file.\n',
    )
    await chmod(second, 0o750)
    const freshRemoval = await cli.previewLocalAction(selection, removeNative, signal)
    await cli.applyLocalAction(selection, freshRemoval, signal, () => undefined)
    await expect(access(second)).rejects.toThrow()
    expect(
      await readFile(join(secondLineage.canonical.path.path, 'support.txt'), 'utf8'),
    ).toBe('Second supporting file.\n')
    const currentCopy = (await cli.exposures(selection, base, signal))!.find(
      (item) => item.target.path === native,
    )!
    const groupRequest: SkillagerLifecycleRequest = {
      ...base,
      action: 'plan',
      origins: [],
      exposures: [currentCopy],
      plan: {
        schema: 'skillager.exposure-request.v1',
        action: 'group',
        name: 'Project guidance',
        library_id: selection.library!.id,
        members: [lineage.canonical.skillId, secondLineage.canonical.skillId],
        replace: [{ exposure_id: currentCopy.id }],
      },
    }
    const group = await cli.previewLocalAction(selection, groupRequest, signal)
    expect(
      await cli.applyLocalAction(selection, group, signal, () => undefined),
    ).toMatchObject({ status: 'applied' })
    const router = (await cli.exposures(selection, base, signal))!.find(
      (item) => item.mode === 'router',
    )!
    expect(router.router?.memberSources).toEqual(
      expect.arrayContaining([
        { skillId: lineage.canonical.skillId, sourceLibraryId: selection.library!.id },
        {
          skillId: secondLineage.canonical.skillId,
          sourceLibraryId: selection.library!.id,
        },
      ]),
    )
    await expect(access(native)).rejects.toThrow()
    const changeMembers: SkillagerLifecycleRequest = {
      ...base,
      action: 'plan',
      origins: [],
      exposures: [router],
      plan: {
        schema: 'skillager.exposure-request.v1',
        action: 'set-members',
        router_id: router.id,
        library_id: selection.library!.id,
        members: [secondLineage.canonical.skillId],
        replace: [],
        departures: [{ skill_id: lineage.canonical.skillId, mode: 'stub' }],
      },
    }
    await cli.applyLocalAction(
      selection,
      await cli.previewLocalAction(selection, changeMembers, signal),
      signal,
      () => undefined,
    )
    const nextCopies = (await cli.exposures(selection, base, signal))!
    const restored = nextCopies.find(
      (item) => item.skillId === lineage.canonical.skillId,
    )!
    expect(restored.mode).toBe('stub')
    const standaloneBefore = await readFile(
      join(restored.target.path, 'skillager.materialized.yaml'),
      'utf8',
    )
    const remainingRouter = nextCopies.find((item) => item.mode === 'router')!
    const emptyRouter: SkillagerLifecycleRequest = {
      ...base,
      action: 'plan',
      origins: [],
      exposures: [remainingRouter],
      plan: {
        schema: 'skillager.exposure-request.v1',
        action: 'set-members',
        router_id: remainingRouter.id,
        library_id: selection.library!.id,
        members: [],
        replace: [],
        departures: [{ skill_id: secondLineage.canonical.skillId, mode: 'remove' }],
      },
    }
    await cli.applyLocalAction(
      selection,
      await cli.previewLocalAction(selection, emptyRouter, signal),
      signal,
      () => undefined,
    )
    expect(
      await readFile(join(restored.target.path, 'skillager.materialized.yaml'), 'utf8'),
    ).toBe(standaloneBefore)
    expect(
      (await cli.exposures(selection, base, signal))!.some(
        (item) => item.skillId === secondLineage.canonical.skillId,
      ),
    ).toBe(false)
    const regroup: SkillagerLifecycleRequest = {
      ...base,
      action: 'plan',
      origins: [],
      exposures: [],
      plan: {
        schema: 'skillager.exposure-request.v1',
        action: 'group',
        name: 'Restorable group',
        library_id: selection.library!.id,
        members: [lineage.canonical.skillId],
        replace: [],
      },
    }
    await cli.applyLocalAction(
      selection,
      await cli.previewLocalAction(selection, regroup, signal),
      signal,
      () => undefined,
    )
    const toUngroup = (await cli.exposures(selection, base, signal))!.find(
      (item) => item.mode === 'router',
    )!
    const ungroup: SkillagerLifecycleRequest = {
      ...base,
      action: 'plan',
      origins: [],
      exposures: [toUngroup],
      plan: {
        schema: 'skillager.exposure-request.v1',
        action: 'ungroup',
        router_id: toUngroup.id,
        mode: 'stub',
      },
    }
    await cli.applyLocalAction(
      selection,
      await cli.previewLocalAction(selection, ungroup, signal),
      signal,
      () => undefined,
    )
    expect(
      await readFile(join(restored.target.path, 'skillager.materialized.yaml'), 'utf8'),
    ).toBe(standaloneBefore)
    const finalGroup: SkillagerLifecycleRequest = {
      ...regroup,
      plan: {
        ...regroup.plan,
        action: 'group',
        name: 'Final group',
        library_id: selection.library!.id,
        members: [lineage.canonical.skillId],
        replace: [],
      },
    }
    await cli.applyLocalAction(
      selection,
      await cli.previewLocalAction(selection, finalGroup, signal),
      signal,
      () => undefined,
    )
    const finalRouter = (await cli.exposures(selection, base, signal))!.find(
      (item) => item.mode === 'router',
    )!
    const removal = await cli.previewLocalAction(
      selection,
      { ...base, action: 'remove-router', exposure: finalRouter },
      signal,
    )
    expect(
      await cli.applyLocalAction(selection, removal, signal, () => undefined),
    ).toMatchObject({ kind: 'remove-router', status: 'removed' })
    expect(
      await readFile(
        join(defaultPreview.detail.target.path, 'skillager.materialized.yaml'),
        'utf8',
      ),
    ).toBe(defaultBefore)
    expect(
      await readFile(
        join(otherPreview.detail.target.path, 'skillager.materialized.yaml'),
        'utf8',
      ),
    ).toBe(otherBefore)
    expect(
      await readFile(join(otherPreview.detail.target.path, 'support.txt'), 'utf8'),
    ).toBe('Preserve this supporting material.\n')
    const staleGroup: SkillagerLifecycleRequest = {
      ...regroup,
      plan: {
        schema: 'skillager.exposure-request.v1',
        action: 'group',
        name: 'Stale remove fixture',
        library_id: selection.library!.id,
        members: [lineage.canonical.skillId],
        replace: [],
      },
    }
    await cli.applyLocalAction(
      selection,
      await cli.previewLocalAction(selection, staleGroup, signal),
      signal,
      () => undefined,
    )
    const staleRouter = (await cli.exposures(selection, base, signal))!.find(
      (item) => item.mode === 'router',
    )!
    const staleRemoval = await cli.previewLocalAction(
      selection,
      { ...base, action: 'remove-router', exposure: staleRouter },
      signal,
    )
    const routerBody = await readFile(join(staleRouter.target.path, 'SKILL.md'), 'utf8')
    const routerSidecar = await readFile(
      join(staleRouter.target.path, 'skillager.materialized.yaml'),
      'utf8',
    )
    await chmod(staleRouter.target.path, 0o700)
    // The complete fixed stale diagnostic identifies the pre-detach refusal; no retry is issued.
    await expect(
      cli.applyLocalAction(selection, staleRemoval, signal, () => undefined),
    ).rejects.toMatchObject({ reason: 'stale-review' })
    expect((await stat(staleRouter.target.path)).mode & 0o777).toBe(0o700)
    expect(await readFile(join(staleRouter.target.path, 'SKILL.md'), 'utf8')).toBe(
      routerBody,
    )
    expect(
      await readFile(
        join(staleRouter.target.path, 'skillager.materialized.yaml'),
        'utf8',
      ),
    ).toBe(routerSidecar)
    expect(await readFile(join(lineage.canonical.path.path, 'SKILL.md'), 'utf8')).toBe(
      body,
    )
    expect(await readFile(join(project.path, '.skillager/tags.json'), 'utf8')).toContain(
      lineage.canonical.skillId,
    )
    const selectedDirect = (await cli.exposures(selection, base, signal))!.find(
      (item) => item.target.path === defaultPreview.detail.target.path,
    )!
    if (selectedDirect.mode !== 'native' && selectedDirect.mode !== 'stub')
      throw new Error('Expected the retained direct copy')
    const removeDirect: SkillagerExposureRequest = {
      ...base,
      action: 'remove' as const,
      skillId: selectedDirect.skillId!,
      mode: selectedDirect.mode,
      exposure: selectedDirect,
    }
    const directRemoval = await cli.previewExposure(selection, removeDirect, signal)
    const directBody = await readFile(
      join(selectedDirect.target.path, 'SKILL.md'),
      'utf8',
    )
    const directSidecar = await readFile(
      join(selectedDirect.target.path, 'skillager.materialized.yaml'),
      'utf8',
    )
    const directMode = (await stat(selectedDirect.target.path)).mode & 0o777
    await chmod(selectedDirect.target.path, 0o700)
    await expect(
      cli.applyExposure(selection, directRemoval, signal),
    ).rejects.toMatchObject({ reason: 'stale-review' })
    expect((await stat(selectedDirect.target.path)).mode & 0o777).toBe(0o700)
    expect(await readFile(join(selectedDirect.target.path, 'SKILL.md'), 'utf8')).toBe(
      directBody,
    )
    expect(
      await readFile(
        join(selectedDirect.target.path, 'skillager.materialized.yaml'),
        'utf8',
      ),
    ).toBe(directSidecar)
    // Explicit fixture repair and a newly reviewed action; the stale confirmation is never retried.
    await chmod(selectedDirect.target.path, directMode)
    await cli.applyExposure(
      selection,
      await cli.previewExposure(selection, removeDirect, signal),
      signal,
    )
    await expect(access(selectedDirect.target.path)).rejects.toThrow()
    expect(
      await readFile(
        join(otherPreview.detail.target.path, 'skillager.materialized.yaml'),
        'utf8',
      ),
    ).toBe(otherBefore)
  },
  180_000,
)
