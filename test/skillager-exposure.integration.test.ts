import { SKILLAGER_AGENTS } from '../src/shared/skillager'
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { localPath } from '../src/shared/host-path'
import type { SkillagerExposureRequest } from '../src/shared/skillager-exposure'
import { LocalHost } from '../src/main/project-host/local-host'
import type { ExecOptions } from '../src/main/project-host/project-host'
import { SkillagerCli } from '../src/main/skillager/skillager-cli'
import { skillagerFixtureEnvironment } from '../src/main/smoke/skillager-fixture-environment'

const FIXTURE_AGENT_ROOTS = { codex: '.agents/skills', claude: '.claude/skills' } as const
const source = process.env.HVIR_SKILLAGER_EXPOSURE_SOURCE,
  python = process.env.HVIR_SKILLAGER_PYTHON
const supported = process.env.HVIR_SKILLAGER_EXPOSURE_CONTRACT !== 'legacy'
it.runIf(Boolean(source && python)).each(SKILLAGER_AGENTS)(
  'proves $label exact effects and refusals with an isolated public CLI source',
  async (agent) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hvir-exposure-cli-')))
    const workspace = join(root, 'workspace'),
      other = join(root, 'other'),
      library = join(root, 'library'),
      catalog = join(root, 'catalog')
    const executable = join(root, 'skillager'),
      scratch = join(root, 'scratch')
    const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
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
      signal = AbortSignal.timeout(180_000)
    const run = async (
      args: readonly string[],
      cwd = workspace,
    ): Promise<{ next_command_argv: string[] }> => {
      const result = await host.exec(
        executable,
        ['--catalog-state-dir', catalog, ...args],
        { cwd: localPath(cwd), signal, maxBuffer: 4 * 1024 * 1024 },
      )
      expect(result.code, result.stderr).toBe(0)
      return JSON.parse(result.stdout) as { next_command_argv: string[] }
    }
    try {
      await Promise.all(
        [workspace, other, scratch, join(root, 'home')].map((path) => mkdir(path)),
      )
      await writeFile(
        executable,
        `#!/bin/sh\nPYTHONPATH=${quote(join(source!, 'src'))} exec ${quote(python!)} -m skillager "$@"\n`,
        { mode: 0o700 },
      )
      await run(['library', 'init', '--path', library, '--no-git', '--json'])
      await run(['library', 'new', 'fixture', '--json'])
      const skill = join(library, 'skills/fixture'),
        entry = join(skill, 'SKILL.md')
      const body = (version: string): string =>
        `---\nname: fixture\ndescription: Exercise workspace exposure contracts.\n---\n# Fixture\n\n${version}\n`
      await writeFile(entry, body('Version A'))
      await mkdir(join(skill, 'references'))
      await writeFile(join(skill, 'references/guide.md'), '# Supporting file\n')
      await writeFile(join(skill, 'helper.sh'), '#!/bin/sh\ntrue\n', { mode: 0o755 })
      const accept = async (skillId = 'lib/fixture'): Promise<void> => {
        const preview = await run(['library', 'accept', skillId, '--json'])
        await run(preview.next_command_argv.slice(1))
      }
      await accept()
      const selection = await cli.probe(localPath(executable), signal)
      const request: SkillagerExposureRequest = {
        connectionId: 'fixture',
        requestId: 1,
        workspaceRoot: localPath(workspace),
        destination: {
          projectId: 'registered',
          workspaceId: 'other',
          root: localPath(other),
        },
        agent: agent.id,
        action: 'add',
        skillId: 'lib/fixture',
        mode: 'native',
      }
      if (!supported) {
        await expect(
          cli.previewExposure(selection, request, signal),
        ).rejects.toMatchObject({ reason: 'unsupported' })
        await run(
          ['expose', 'lib/fixture', '--agent', agent.id, '--mode', 'native', '--json'],
          other,
        )
        const exposure = (await cli.exposures(
          selection,
          { ...request, workspaceRoot: localPath(other) },
          signal,
        ))![0]!
        await expect(
          cli.previewExposure(
            selection,
            { ...request, action: 'remove', exposure },
            signal,
          ),
        ).rejects.toMatchObject({ reason: 'unsupported' })
        expect(await readFile(join(exposure.target.path, 'SKILL.md'), 'utf8')).toContain(
          'Version A',
        )
        return
      }
      const first = await cli.previewExposure(selection, request, signal)
      expect(first.detail.target.path.startsWith(other + '/')).toBe(true)
      expect(first.detail.effects.map((effect) => effect.path)).toEqual(
        expect.arrayContaining([
          'SKILL.md',
          'references',
          'references/guide.md',
          'helper.sh',
          'skillager.materialized.yaml',
        ]),
      )
      expect(
        first.detail.effects.find((effect) => effect.path === 'helper.sh')?.after?.mode,
      ).toBe(0o755)
      expect((await cli.applyExposure(selection, first, signal)).status).toBe('exposed')
      const target = first.detail.target.path
      expect(await readFile(join(target, 'references/guide.md'), 'utf8')).toBe(
        '# Supporting file\n',
      )
      const exposures = await cli.exposures(
        selection,
        { ...request, workspaceRoot: localPath(other) },
        signal,
      )
      expect(exposures).toHaveLength(1)
      const exposure = exposures![0]!
      await run([
        'expose',
        'lib/fixture',
        '--agent',
        agent.id,
        '--mode',
        'native',
        '--json',
      ])
      const otherCopy = join(
          workspace,
          FIXTURE_AGENT_ROOTS[agent.id] + '/lib-fixture/SKILL.md',
        ),
        preserved = await readFile(otherCopy)
      await writeFile(entry, body('Version B accepted after original exposure'))
      await accept()
      const change = {
        ...request,
        action: 'change' as const,
        mode: 'stub' as const,
        exposure,
      }
      const stub = await cli.previewExposure(selection, change, signal)
      expect(stub.detail.sourceHash).not.toBe(first.detail.sourceHash)
      expect(
        stub.detail.effects.find((effect) => effect.path === 'references/guide.md')
          ?.action,
      ).toBe('remove')
      expect((await cli.applyExposure(selection, stub, signal)).status).toBe('exposed')
      expect(await readdir(target)).not.toContain('references')
      const restored = await cli.previewExposure(
        selection,
        { ...change, mode: 'native' },
        signal,
      )
      await cli.applyExposure(selection, restored, signal)
      expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toContain('Version B')
      expect(
        await cli.exposures(
          selection,
          { ...request, workspaceRoot: localPath(other) },
          signal,
        ),
      ).toHaveLength(1)
      const stale = await cli.previewExposure(selection, change, signal)
      await writeFile(entry, body('Version C accepted after preview'))
      await accept()
      await expect(cli.applyExposure(selection, stale, signal)).rejects.toMatchObject({
        reason: 'stale-review',
      })
      expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toContain('Version B')
      const targetStale = await cli.previewExposure(selection, change, signal)
      await chmod(target, 0o700)
      await expect(
        cli.applyExposure(selection, targetStale, signal),
      ).rejects.toMatchObject({ reason: 'stale-review' })
      await chmod(target, 0o755)
      const removeRequest = { ...request, action: 'remove' as const, exposure }
      const removal = await cli.previewExposure(selection, removeRequest, signal)
      await chmod(target, 0o700)
      await expect(cli.applyExposure(selection, removal, signal)).rejects.toMatchObject({
        reason: 'stale-review',
      })
      await chmod(target, 0o755)
      await writeFile(
        entry,
        body('Pending source does not prohibit removing unchanged old target'),
      )
      const pendingRemoval = await cli.previewExposure(selection, removeRequest, signal)
      expect(
        pendingRemoval.detail.effects.every((effect) => effect.action === 'remove'),
      ).toBe(true)
      expect(pendingRemoval.detail.afterMode).toBeNull()
      expect((await cli.applyExposure(selection, pendingRemoval, signal)).status).toBe(
        'removed',
      )
      await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(otherCopy)).toEqual(preserved)
      expect(await readFile(entry, 'utf8')).toContain('Pending source')
      await expect(cli.previewExposure(selection, request, signal)).rejects.toMatchObject(
        { reason: 'review-refused' },
      )
      await accept()
      const absent = await cli.previewExposure(selection, request, signal)
      await mkdir(target, { recursive: true })
      await writeFile(join(target, 'SKILL.md'), 'Unmanaged user copy')
      await expect(cli.applyExposure(selection, absent, signal)).rejects.toMatchObject({
        reason: 'review-refused',
      })
      await expect(cli.previewExposure(selection, request, signal)).rejects.toMatchObject(
        { reason: 'review-refused' },
      )
      expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toBe('Unmanaged user copy')
      await rm(target, { recursive: true })
      await cli.applyExposure(
        selection,
        await cli.previewExposure(selection, request, signal),
        signal,
      )
      const modified = join(target, 'references/guide.md'),
        originalGuide = await readFile(modified)
      await writeFile(modified, 'User edit')
      await expect(cli.previewExposure(selection, change, signal)).rejects.toMatchObject({
        reason: 'review-refused',
      })
      await expect(
        cli.previewExposure(selection, removeRequest, signal),
      ).rejects.toMatchObject({ reason: 'review-refused' })
      expect(await readFile(modified, 'utf8')).toBe('User edit')
      await writeFile(modified, originalGuide)
      const disappeared = await cli.previewExposure(selection, removeRequest, signal)
      await rename(target, target + '-retained')
      await expect(
        cli.applyExposure(selection, disappeared, signal),
      ).rejects.toMatchObject({ reason: 'review-refused' })
      await rename(target + '-retained', target)
      const sidecar = join(target, 'skillager.materialized.yaml'),
        sidecarBytes = await readFile(sidecar)
      const protectedHash = (await cli.previewExposure(selection, change, signal)).detail
        .sourceHash!
      await writeFile(
        sidecar,
        Buffer.concat([
          sidecarBytes,
          Buffer.from('\nexposure_blocked_hashes:\n  - ' + protectedHash + '\n'),
        ]),
      )
      await expect(cli.previewExposure(selection, change, signal)).rejects.toMatchObject({
        reason: 'review-refused',
      })
      await writeFile(sidecar, sidecarBytes)
      await run(['review', 'pin', 'lib/fixture', '--json'])
      const pinned = await cli.previewExposure(selection, change, signal)
      await cli.applyExposure(selection, pinned, signal)
      await writeFile(entry, body('Unaccepted change after pin'))
      await expect(cli.previewExposure(selection, request, signal)).rejects.toMatchObject(
        { reason: 'review-refused' },
      )
      await run(['review', 'block', 'lib/fixture', '--json'])
      await expect(cli.previewExposure(selection, request, signal)).rejects.toMatchObject(
        { reason: 'review-refused' },
      )
      expect(await readFile(otherCopy)).toEqual(preserved)
      await run(['library', 'new', 'incompatible', '--json'])
      const incompatibleRoot = join(library, 'skills/incompatible')
      await writeFile(join(incompatibleRoot, 'SKILL.md'), body('Incompatible fixture'))
      await writeFile(
        join(incompatibleRoot, 'skillager.yaml'),
        'schema: skillager.skill.v1\naudience: [user]\nactivation:\n  default: manual\ncompatibility:\n  exclusive_to: ' +
          SKILLAGER_AGENTS.find((item) => item.id !== agent.id)!.id +
          '\n',
      )
      await accept('lib/incompatible')
      await expect(
        cli.previewExposure(
          selection,
          { ...request, skillId: 'lib/incompatible' },
          signal,
        ),
      ).rejects.toMatchObject({ reason: 'review-refused' })
      await run(['library', 'new', 'context', '--json'])
      await writeFile(join(library, 'skills/context/SKILL.md'), body('Context fixture'))
      await accept('lib/context')
      await mkdir(join(workspace, '.git'))
      const child = join(workspace, 'nested')
      await mkdir(child)
      await run([
        'expose',
        'lib/context',
        '--agent',
        agent.id,
        '--mode',
        'native',
        '--scope',
        'project',
        '--json',
      ])
      const nestedRequest = {
        ...request,
        skillId: 'lib/context',
        destination: { ...request.destination, root: localPath(child) },
      }
      const nested = await cli.previewExposure(selection, nestedRequest, signal)
      await cli.applyExposure(selection, nested, signal)
      const parentCopy = join(
          workspace,
          FIXTURE_AGENT_ROOTS[agent.id],
          'lib-context/SKILL.md',
        ),
        parentBytes = await readFile(parentCopy)
      await expect(
        cli.previewExposure(
          selection,
          {
            ...nestedRequest,
            action: 'remove',
            exposure: {
              id: 'lib-context',
              skillId: 'lib/context',
              target: nested.detail.target,
              mode: 'native',
              status: 'current',
            },
          },
          signal,
        ),
      ).rejects.toMatchObject({ reason: 'unavailable' })
      expect(await readFile(parentCopy)).toEqual(parentBytes)
      expect(await readFile(join(nested.detail.target.path, 'SKILL.md'))).toEqual(
        parentBytes,
      )
    } finally {
      await cli.dispose()
      await host.dispose()
      await rm(root, { recursive: true, force: true })
    }
  },
  180_000,
)
