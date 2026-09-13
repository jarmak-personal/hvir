import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
  chmod,
  symlink,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { localPath } from '../src/shared/host-path'
import { LocalHost } from '../src/main/project-host/local-host'
import type { ExecOptions } from '../src/main/project-host/project-host'
import { SkillagerCli } from '../src/main/skillager/skillager-cli'
import { skillagerFixtureEnvironment } from '../src/main/smoke/skillager-fixture-environment'

const release = process.env.HVIR_SKILLAGER_RELEASE
it.runIf(Boolean(release)).each([true, false])(
  'verifies full review trees and exact acceptance using the public CLI (no Git: %s)',
  async (noGit) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hvir-skillager-review-')))
    const library = join(root, 'library'),
      catalog = join(root, 'catalog'),
      workspace = join(root, 'workspace'),
      scratch = join(root, 'scratch')
    const executable = join(release!, '.venv/bin/skillager')
    const { env, unsetEnv } = skillagerFixtureEnvironment(localPath(root), process.env)
    let afterCanonicalPreview: (() => Promise<void>) | undefined
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
          afterCanonicalPreview &&
          args[args.indexOf('--catalog-state-dir') + 1] === catalog &&
          args.includes('accept') &&
          !args.includes('--yes')
        ) {
          const insert = afterCanonicalPreview
          afterCanonicalPreview = undefined
          await insert()
        }
        return result
      }
    }
    const host = new FixtureHost(),
      cli = new SkillagerCli(host, localPath(scratch)),
      signal = AbortSignal.timeout(60_000)
    const run = async (args: readonly string[], cwd = workspace) => {
      const result = await host.exec(
        executable,
        ['--catalog-state-dir', catalog, '--state-dir', catalog, ...args],
        { cwd: localPath(cwd), signal, maxBuffer: 4 * 1024 * 1024 },
      )
      expect(result.code, result.stderr).toBe(0)
      return JSON.parse(result.stdout) as Record<string, unknown>
    }
    try {
      await Promise.all(
        [workspace, scratch, join(root, 'home')].map((path) => mkdir(path)),
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
      const skill = join(library, 'skills/fixture')
      await writeFile(
        join(skill, 'SKILL.md'),
        '---\nname: fixture\ndescription: Review an isolated fixture.\n---\n# Fixture\n\nFirst reviewed version.\n',
      )
      await mkdir(join(skill, 'references'))
      await writeFile(join(skill, 'references/guide.md'), '# Supporting guide\n')
      await writeFile(join(skill, 'helper.sh'), '#!/bin/sh\nprintf "fixture\\n"\n')
      await chmod(join(skill, 'helper.sh'), 0o755)
      await writeFile(join(skill, 'asset.bin'), Buffer.from([0xff, 0, 1]))
      const selection = await cli.probe(localPath(executable), signal)
      const first = await cli.review(selection, 'lib/fixture', signal)
      expect(first.detail.history.available).toBe(!noGit)
      expect(first.detail.history.versions).toEqual([])
      expect(first.detail.files).toEqual(
        expect.arrayContaining([{ entry: 'helper.sh', executable: true, size: 29 }]),
      )
      expect(first.detail.canAccept).toBe(true)
      expect(JSON.stringify(first.detail)).not.toContain('confirmationToken')
      expect(Buffer.from(first.bytes.get('references/guide.md')!).toString()).toContain(
        'Supporting guide',
      )
      const contexts = await readdir(scratch)
      expect(await readdir(join(scratch, contexts[0]!))).toEqual([])
      await chmod(join(skill, 'helper.sh'), 0o644)
      await expect(cli.accept(selection, first, signal)).rejects.toMatchObject({
        reason: 'stale-review',
      })
      await chmod(join(skill, 'helper.sh'), 0o755)
      await writeFile(join(skill, 'references/guide.md'), '# Changed after review\n')
      await expect(cli.accept(selection, first, signal)).rejects.toMatchObject({
        reason: 'stale-review',
      })
      expect(Buffer.from(first.bytes.get('references/guide.md')!).toString()).toContain(
        'Supporting guide',
      )
      await first.dispose()
      expect(first.bytes.size).toBe(0)
      const second = await cli.review(selection, 'lib/fixture', signal)
      const accepted = await cli.accept(selection, second, signal)
      expect(accepted).toEqual({ status: 'accepted', hash: second.detail.hash })
      await second.dispose()
      await run([
        'expose',
        'lib/fixture',
        '--agent',
        'codex',
        '--mode',
        'native',
        '--json',
      ])
      const native = join(workspace, '.agents/skills/lib-fixture/SKILL.md')
      const before = await readFile(native)
      await writeFile(
        join(skill, 'SKILL.md'),
        '---\nname: fixture\ndescription: Review an isolated fixture.\n---\n# Fixture\n\nNew acceptedneedle content.\n',
      )
      const third = await cli.review(selection, 'lib/fixture', signal)
      if (!noGit) {
        const diff = await cli.diff(selection, third, undefined, signal)
        expect(diff.toHash).toBe(third.detail.hash)
        expect(diff.text).toContain('acceptedneedle')
      }
      await cli.accept(selection, third, signal)
      expect(await readFile(native)).toEqual(before)
      const request = {
        connectionId: 'test',
        requestId: 1,
        workspaceRoot: localPath(workspace),
        agent: 'codex' as const,
        query: 'acceptedneedle',
        scope: 'library' as const,
      }
      expect(await cli.search(selection, request, signal)).toHaveLength(1)
      await third.dispose()
      const approved = await cli.review(selection, 'lib/fixture', signal)
      expect(approved.detail.canAccept).toBe(false)
      await approved.dispose()
      for (const entry of ['review.tmp', 'review.swp', '__pycache__/review.pyc']) {
        afterCanonicalPreview = async () => {
          if (entry.includes('/')) await mkdir(join(skill, '__pycache__'))
          await writeFile(
            join(skill, entry),
            'Excluded bytes inserted after canonical preview',
          )
        }
        await expect(cli.review(selection, 'lib/fixture', signal)).rejects.toMatchObject({
          reason: 'review-refused',
        })
        expect(await readdir(join(scratch, contexts[0]!))).toEqual([])
        await rm(join(skill, entry))
        if (entry.includes('/')) await rm(join(skill, '__pycache__'), { recursive: true })
      }
      await symlink(join(root, 'outside'), join(skill, 'escape'))
      await expect(cli.review(selection, 'lib/fixture', signal)).rejects.toBeDefined()
    } finally {
      await cli.dispose()
      await host.dispose()
      await rm(root, { recursive: true, force: true })
    }
  },
  120_000,
)
