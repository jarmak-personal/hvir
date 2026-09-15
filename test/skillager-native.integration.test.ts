import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { LocalHost } from '../src/main/project-host/local-host'
import type { ExecOptions } from '../src/main/project-host/project-host'
import { localPath } from '../src/shared/host-path'
import { SkillagerCli } from '../src/main/skillager/skillager-cli'
import { skillagerFixtureEnvironment } from '../src/main/smoke/skillager-fixture-environment'

const release = process.env.HVIR_SKILLAGER_RELEASE
it.runIf(Boolean(release))(
  'binds released native export to the entire retained D4 tree, including Unicode identity and no-Git source',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hvir-native-')))
    const catalog = join(root, 'catalog'),
      library = join(root, 'library'),
      workspace = join(root, 'workspace'),
      scratch = join(root, 'scratch')
    const executable = join(release!, '.venv/bin/skillager')
    const { env, unsetEnv } = skillagerFixtureEnvironment(localPath(root), process.env)
    let afterProjection: ((target: string) => Promise<void>) | undefined
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
          unsetEnv,
          env: { ...env, ...options.env },
        })
        if (
          afterProjection &&
          args.includes('expose') &&
          !args.includes('--list') &&
          result.code === 0
        ) {
          const hook = afterProjection
          afterProjection = undefined
          await hook((JSON.parse(result.stdout) as { target: string }[])[0]!.target)
        }
        return result
      }
    }
    const host = new FixtureHost(),
      cli = new SkillagerCli(host, localPath(scratch)),
      signal = AbortSignal.timeout(120_000)
    const run = async (args: readonly string[]) => {
      const result = await host.exec(
        executable,
        ['--catalog-state-dir', catalog, '--state-dir', catalog, ...args],
        { cwd: localPath(workspace), signal, maxBuffer: 4 * 1024 * 1024 },
      )
      expect(result.code, result.stderr).toBe(0)
      return JSON.parse(result.stdout) as unknown
    }
    try {
      await Promise.all(
        [workspace, scratch, join(root, 'home')].map((path) => mkdir(path)),
      )
      await run(['library', 'init', '--path', library, '--no-git', '--json'])
      await run(['library', 'new', 'café', '--json'])
      const skill = join(library, 'skills/café')
      await writeFile(
        join(skill, 'SKILL.md'),
        '---\nname: café\ndescription: Read and explain bundled fixture references.\n---\n# Café\n\nRead the supporting data.\n',
      )
      await mkdir(join(skill, 'references'))
      await writeFile(join(skill, 'references/data.bin'), Buffer.from([0, 255, 2]))
      await writeFile(join(skill, 'helper.sh'), '#!/bin/sh\nprintf "fixture\\n"\n')
      await chmod(join(skill, 'helper.sh'), 0o755)
      const selection = await cli.probe(localPath(executable), signal)
      const review = await cli.review(selection, 'lib/café', signal)
      await cli.accept(selection, review, signal)
      await review.dispose()
      for (const agent of ['codex', 'claude'] as const) {
        const snapshot = await cli.nativeSnapshot(selection, 'lib/café', agent, signal)
        expect(snapshot.exposureId).toBe('lib-café')
        expect(snapshot.targetEntry).toBe(
          `${agent === 'codex' ? '.agents' : '.claude'}/skills/lib-café`,
        )
        expect([...snapshot.bytes.keys()].sort()).toEqual([
          'SKILL.md',
          'helper.sh',
          'references/data.bin',
        ])
        expect(snapshot.tree.files.find((f) => f.entry === 'helper.sh')?.mode).toBe(0o755)
        expect([...snapshot.bytes.get('references/data.bin')!]).toEqual([0, 255, 2])
        const context = (await readdir(scratch))[0]!
        expect(await readdir(join(scratch, context))).toEqual([])
        await snapshot.dispose()
        expect(snapshot.bytes.size).toBe(0)
      }
      for (const kind of [
        'extra',
        'missing',
        'bytes',
        'mode',
        'empty-directory',
        'symlink',
      ] as const) {
        afterProjection = async (target) => {
          if (kind === 'extra') await writeFile(join(target, 'unexpected.txt'), 'extra')
          if (kind === 'missing') await rm(join(target, 'helper.sh'))
          if (kind === 'bytes')
            await writeFile(join(target, 'references/data.bin'), Buffer.from([1, 255, 2]))
          if (kind === 'mode') await chmod(join(target, 'helper.sh'), 0o644)
          if (kind === 'empty-directory')
            await mkdir(join(target, 'unexpected-directory'))
          if (kind === 'symlink') {
            await rm(join(target, 'helper.sh'))
            await symlink(join(skill, 'helper.sh'), join(target, 'helper.sh'))
          }
        }
        await expect(
          cli.nativeSnapshot(selection, 'lib/café', 'codex', signal),
        ).rejects.toBeDefined()
      }
      // Released public pin skips library-owned sources; do not claim a real pinned fixture.
      expect(
        JSON.stringify(await run(['review', 'pin', 'lib/café', '--json'])),
      ).toContain('commit-before-acceptance')
      const stillAccepted = await cli.nativeSnapshot(
        selection,
        'lib/café',
        'claude',
        signal,
      )
      expect(stillAccepted.pinned).toBe(false)
      await stillAccepted.dispose()
      await writeFile(
        join(skill, 'transient.tmp'),
        'Excluded by public native projection',
      )
      let projectedExcluded = false
      afterProjection = () => {
        projectedExcluded = true
        return Promise.resolve()
      }
      await expect(
        cli.nativeSnapshot(selection, 'lib/café', 'codex', signal),
      ).rejects.toBeDefined()
      expect(projectedExcluded).toBe(false)
      afterProjection = undefined
      for (const context of await readdir(scratch))
        expect(await readdir(join(scratch, context))).toEqual([])
      await rm(join(skill, 'transient.tmp'))
      const source = await cli.nativeSnapshot(selection, 'lib/café', 'codex', signal)
      await writeFile(join(skill, 'references/data.bin'), Buffer.from([1, 2, 3]))
      await expect(
        cli.validateNativeSource(selection, source, false, signal),
      ).rejects.toBeDefined()
      expect([...source.bytes.get('references/data.bin')!]).toEqual([0, 255, 2])
      await source.dispose()
      const changed = await cli.review(selection, 'lib/café', signal)
      expect(changed.detail.refusal, 'changed fixture').toBeUndefined()
      await cli.accept(selection, changed, signal)
      await changed.dispose()
      await writeFile(join(skill, '.hvir-skillager.json'), '{}\n')
      const reserved = await cli.review(selection, 'lib/café', signal)
      expect(reserved.detail.refusal, 'reserved fixture').toBeUndefined()
      await cli.accept(selection, reserved, signal)
      await reserved.dispose()
      await expect(
        cli.nativeSnapshot(selection, 'lib/café', 'codex', signal),
      ).rejects.toThrow('reserved delivery record')
      await rm(join(skill, '.hvir-skillager.json'))
      await writeFile(
        join(skill, 'skillager.yaml'),
        'schema: skillager.skill.v1\naudience:\n  - user\nactivation:\n  default: manual\ncompatibility:\n  exclusive_to: claude\n  assumptions:\n    env:\n      - HVIR_FIXTURE_MISSING_ENV\ntargets:\n  python_packages:\n    - name: hvir-fixture-package\n      versions: ">=1"\n',
      )
      const declared = await cli.review(selection, 'lib/café', signal)
      expect(declared.detail.refusal, 'declarations fixture').toBeUndefined()
      await cli.accept(selection, declared, signal)
      await declared.dispose()
      await expect(
        cli.nativeSnapshot(selection, 'lib/café', 'codex', signal),
      ).rejects.toThrow('selected agent')
      const compatible = await cli.nativeSnapshot(selection, 'lib/café', 'claude', signal)
      expect(compatible.declarations.join(' ')).toContain('HVIR_FIXTURE_MISSING_ENV')
      expect(compatible.declarations.join(' ')).toContain('hvir-fixture-package')
      await compatible.dispose()
    } finally {
      await cli.dispose()
      await host.dispose()
      await rm(root, { recursive: true, force: true })
    }
  },
  150_000,
)
