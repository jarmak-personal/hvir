import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { localPath } from '../src/shared/host-path'
import type { SkillagerExposureRequest } from '../src/shared/skillager-exposure'
import { LocalHost } from '../src/main/project-host/local-host'
import type { ExecOptions } from '../src/main/project-host/project-host'
import { SkillagerCli } from '../src/main/skillager/skillager-cli'
import { SkillagerReviewOwner } from '../src/main/skillager/skillager-review-owner'
import { SkillagerExposureOwner } from '../src/main/skillager/skillager-exposure-owner'
import { skillagerFixtureEnvironment } from '../src/main/smoke/skillager-fixture-environment'
import { createRendererResourceFixture } from './fixtures/renderer-resource-fixture'

const source = process.env.HVIR_SKILLAGER_EXPOSURE_SOURCE,
  python = process.env.HVIR_SKILLAGER_PYTHON
const supported = process.env.HVIR_SKILLAGER_EXPOSURE_CONTRACT !== 'legacy'
it.runIf(Boolean(source && python)).each([
  { agent: 'codex' as const, mode: 'native' as const, noGit: false, missingOld: false },
  { agent: 'claude' as const, mode: 'stub' as const, noGit: false, missingOld: false },
  { agent: 'codex' as const, mode: 'native' as const, noGit: true, missingOld: false },
  { agent: 'codex' as const, mode: 'native' as const, noGit: false, missingOld: true },
])(
  'reviews and updates $agent $mode with noGit=$noGit missingOld=$missingOld from the exact old source through isolated public CLI processes',
  async ({ agent, mode, noGit, missingOld }) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hvir-update-cli-')))
    const workspace = join(root, 'workspace'),
      other = join(root, 'other'),
      library = join(root, 'library'),
      catalog = join(root, 'catalog'),
      executable = join(root, 'skillager'),
      scratch = join(root, 'scratch')
    const { env, unsetEnv } = skillagerFixtureEnvironment(localPath(root), process.env)
    class FixtureHost extends LocalHost {
      override defaultShell() {
        return Promise.resolve('/bin/sh')
      }
      override exec(command: string, args: readonly string[], options: ExecOptions = {}) {
        return super.exec(command, args, {
          ...options,
          unsetEnv,
          env: { ...env, ...options.env },
        })
      }
    }
    const host = new FixtureHost(),
      cli = new SkillagerCli(host, localPath(scratch)),
      signal = AbortSignal.timeout(180_000),
      resources = createRendererResourceFixture(),
      owner = resources.activateOwner()
    const reviews = new SkillagerReviewOwner(
      cli,
      resources.scopes,
      {
        create: () => {
          throw new Error('No HTML in fixture')
        },
        release: () => undefined,
      },
      cli,
    )
    const exposures = new SkillagerExposureOwner(cli, resources.scopes)
    const run = async (
      args: readonly string[],
      cwd = workspace,
    ): Promise<Record<string, unknown>> => {
      const result = await host.exec(
        executable,
        ['--catalog-state-dir', catalog, ...args],
        { cwd: localPath(cwd), signal, maxBuffer: 4 * 1024 * 1024 },
      )
      expect(result.code, result.stderr).toBe(0)
      return JSON.parse(result.stdout) as Record<string, unknown>
    }
    try {
      await Promise.all(
        [workspace, other, scratch, join(root, 'home')].map((path) => mkdir(path)),
      )
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
      await writeFile(
        executable,
        `#!/bin/sh\nPYTHONPATH=${quote(join(source!, 'src'))} exec ${quote(python!)} -m skillager "$@"\n`,
        { mode: 0o700 },
      )
      await run([
        'library',
        'init',
        '--path',
        library,
        ...(noGit ? ['--no-git'] : []),
        '--json',
      ])
      await run(['library', 'new', 'fixture', '--json'])
      const entry = join(library, 'skills/fixture/SKILL.md')
      const body = (version: string) =>
        `---\nname: fixture\ndescription: Exercise accepted workspace source updates.\n---\n# Fixture\n\n${version}\n`
      const accept = async (version: string) => {
        await writeFile(entry, body(version))
        const preview = await run(['library', 'accept', 'lib/fixture', '--json'])
        const accepted = await run((preview.next_command_argv as string[]).slice(1))
        return (accepted.skill as { working_hash: string }).working_hash
      }
      const oldHash = await accept('Version A')
      for (const cwd of [workspace, other])
        await run(
          ['expose', 'lib/fixture', '--agent', agent, '--mode', mode, '--json'],
          cwd,
        )
      const selection = await cli.probe(localPath(executable), signal)
      const base = {
        connectionId: 'fixture',
        requestId: 1,
        workspaceRoot: localPath(workspace),
        agent,
      }
      const oldCopy = (await cli.exposures(
        selection,
        { ...base, workspaceRoot: localPath(other) },
        signal,
      ))![0]!
      const otherBody = await readFile(join(oldCopy.target.path, 'SKILL.md'))
      const incoming = await accept('Version B accepted')
      const exposure = (await cli.exposures(selection, base, signal))![0]!
      expect(exposure.status).toBe('source_update')
      expect(exposure.expectedSourceHash).toBe(incoming)
      const request: SkillagerExposureRequest = {
        ...base,
        action: 'update',
        mode,
        skillId: 'lib/fixture',
        exposure,
        destination: {
          projectId: 'fixture',
          workspaceId: 'workspace',
          root: base.workspaceRoot,
        },
      }
      const grant = { selection, assertCurrent: () => undefined }
      if (!supported) {
        await expect(
          reviews.review(
            owner,
            { ...base, skillId: request.skillId, update: request },
            grant,
          ),
        ).rejects.toMatchObject({ reason: 'unsupported' })
        expect(await readFile(join(exposure.target.path, 'SKILL.md'))).toEqual(otherBody)
        return
      }
      if (missingOld) {
        for (const args of [
          ['checkout', '--orphan', 'replacement-history'],
          ['commit', '-am', 'Keep only the accepted incoming tree'],
        ]) {
          const result = await host.exec('git', args, {
            cwd: localPath(library),
            signal,
            maxBuffer: 65536,
          })
          expect(result.code).toBe(0)
        }
      }
      if (noGit || missingOld) {
        await expect(
          reviews.review(
            owner,
            { ...base, skillId: request.skillId, update: request },
            grant,
          ),
        ).rejects.toMatchObject({ reason: 'unavailable' })
        expect(await readFile(join(exposure.target.path, 'SKILL.md'))).toEqual(otherBody)
        const ordinary = await reviews.review(
          owner,
          { ...base, requestId: 2, skillId: request.skillId },
          grant,
        )
        expect(ordinary.hash).toBe(incoming)
        expect(ordinary.update).toBeUndefined()
        return
      }
      const review = await reviews.review(
        owner,
        { ...base, skillId: request.skillId, update: request },
        grant,
      )
      expect(review.update?.diff).toMatchObject({ fromHash: oldHash, toHash: incoming })
      expect(review.hash).toBe(incoming)
      expect(review.canAccept).toBe(false)
      expect(await readFile(join(exposure.target.path, 'SKILL.md'))).toEqual(otherBody)
      const bound = { ...request, reviewId: review.reviewId }
      const preview = await exposures.preview(owner, bound, {
        ...grant,
        ...reviews.updateGrant(owner, bound),
      })
      expect(preview.request.mode).toBe(mode)
      expect((await exposures.apply(owner, preview.previewId)).status).toBe('exposed')
      const refreshed = (await cli.exposures(selection, base, signal))![0]!
      expect(refreshed.status).toBe('current')
      expect(refreshed.mode).toBe(mode)
      expect(await readFile(join(oldCopy.target.path, 'SKILL.md'))).toEqual(otherBody)
      await exposures.release(owner, preview.previewId)
      await reviews.release(owner, review.reviewId)

      // A local edit is authoritative drift even though library status still reports update_available.
      await accept('Version C accepted')
      await writeFile(join(exposure.target.path, 'SKILL.md'), 'Preserve modified copy.\n')
      expect((await cli.exposures(selection, base, signal))![0]!.status).toBe(
        'local_edit',
      )
      await expect(
        reviews.review(
          owner,
          { ...base, requestId: 2, skillId: request.skillId, update: request },
          grant,
        ),
      ).rejects.toThrow()
      expect(await readFile(join(exposure.target.path, 'SKILL.md'), 'utf8')).toBe(
        'Preserve modified copy.\n',
      )
    } finally {
      await exposures.revoke()
      await reviews.revoke()
      await cli.dispose()
      await host.dispose()
      await rm(root, { recursive: true, force: true })
    }
  },
  180_000,
)
