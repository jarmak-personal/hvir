import { describe, expect, it, vi } from 'vitest'
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
import type { ExecResult } from '../src/shared'
import type { ExecOptions } from '../src/main/project-host/project-host'
import { localPath } from '../src/shared/host-path'
import { LocalHost } from '../src/main/project-host/local-host'
import { SkillagerProcess } from '../src/main/skillager/skillager-process'
import { SkillagerReviewCommands } from '../src/main/skillager/skillager-review-commands'
import type { SkillagerReviewSnapshot } from '../src/main/skillager/skillager-review-port'

const hash = 'a'.repeat(64)
const selection = {
  executable: localPath('/skillager'),
  catalog: localPath('/catalog'),
  version: 'skillager 0.9.0',
  environment: {},
  library: {
    id: 'library',
    root: localPath('/library'),
    skillsRoot: localPath('/library/skills'),
  },
}
const snapshot: SkillagerReviewSnapshot = {
  detail: {
    skillId: 'lib/example',
    root: localPath('/library/skills/example'),
    hash,
    canAccept: true,
    files: [],
    findings: [],
    scanRisk: 'low',
    lintStatus: 'ok',
    history: { available: false, versions: [] },
  },
  bytes: new Map(),
  confirmationToken: 'private-token',
  dispose: () => Promise.resolve(),
}

describe('Skillager acceptance at its process boundary', () => {
  it('refuses the private preview nonzero result and removes scratch without publishing content', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hvir-review-refusal-')))
    const context = join(root, 'context'),
      library = join(root, 'library'),
      skill = join(library, 'skills/example')
    const host = new LocalHost()
    const selected = {
      ...selection,
      catalog: localPath(join(root, 'catalog')),
      library: {
        id: 'library',
        root: localPath(library),
        skillsRoot: localPath(join(library, 'skills')),
      },
    }
    const identity = {
      id: 'lib/example',
      path: skill,
      working_hash: hash,
      trust: 'discovered',
    }
    const calls: Array<readonly string[]> = []
    const runner = new SkillagerProcess({
      exec: async (
        command: string,
        args: readonly string[],
        options?: ExecOptions,
      ): Promise<ExecResult> => {
        if (command !== selected.executable.path) return host.exec(command, args, options)
        calls.push(args)
        const json = (value: unknown): ExecResult => ({
          code: 0,
          signal: null,
          stdout: JSON.stringify(value),
          stderr: '',
        })
        if (args.includes('init')) {
          const privateLibrary = args[args.indexOf('--path') + 1]!
          await mkdir(join(privateLibrary, 'skills'), { recursive: true })
          // A separate actor adds an excluded entry after the canonical preview.
          await writeFile(join(skill, 'review.tmp'), 'Must never reach a review result')
          return json({
            schema: 'skillager.library-init.v1',
            status: 'initialized',
            created: true,
            git_repository_created: false,
            commit: null,
            indexed: 0,
            errors: [],
            git: { mode: 'disabled' },
            history: { available: false },
            library: {
              namespace: 'lib',
              registration: 'valid',
              root: privateLibrary,
              skills_path: join(privateLibrary, 'skills'),
            },
          })
        }
        if (args.includes('history'))
          return json({
            schema: 'skillager.library-history.v1',
            available: false,
            versions: [],
            skill: identity,
          })
        if (
          args.includes('accept') &&
          args[args.indexOf('--catalog-state-dir') + 1] !== selected.catalog.path
        )
          return {
            code: 2,
            signal: null,
            stdout: '',
            stderr: 'library acceptance: entries outside the canonical content tree',
          }
        if (args.includes('accept'))
          return json({
            schema: 'skillager.library-accept.v1',
            status: 'preview',
            skill: identity,
            lint: { status: 'ok', findings: [] },
            scan: { risk: 'low', findings: [] },
            git: { mode: 'disabled', conflicts: [], operation: null },
            requires_override: false,
            next_command_argv: [
              'skillager',
              'library',
              'accept',
              'lib/example',
              '--json',
              '--yes',
              '--confirmation-token',
              'canonical-token',
            ],
          })
        throw new Error('Unexpected CLI operation')
      },
    })
    const commands = new SkillagerReviewCommands(host, runner, localPath(context), () =>
      Promise.resolve(),
    )
    const publish = vi.fn()
    try {
      await Promise.all([mkdir(context), mkdir(skill, { recursive: true })])
      await writeFile(join(skill, 'SKILL.md'), '# Reviewed content')
      await expect(
        commands
          .review(selected, 'lib/example', new AbortController().signal)
          .then(async (snapshot) => {
            publish(snapshot.detail)
            await snapshot.dispose()
          }),
      ).rejects.toMatchObject({ reason: 'review-refused' })
      expect(publish).not.toHaveBeenCalled()
      expect(await readdir(context)).toEqual([])
      expect(await readFile(join(skill, 'SKILL.md'), 'utf8')).toBe('# Reviewed content')
      expect(calls.filter((args) => args.includes('accept'))).toHaveLength(2)
      expect(calls.some((args) => args.includes('--yes'))).toBe(false)
    } finally {
      await runner.dispose()
      await host.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
  it.each([
    ['preview is stale', 'stale-review'],
    ['requires --override-lint', 'review-refused'],
    ['unresolved conflicts', 'review-refused'],
    ['has staged changes', 'review-refused'],
    ['PRIVATE unexpected interruption', 'uncertain'],
  ])('classifies %s without exposing diagnostics or retrying', async (stderr, reason) => {
    const host = new LocalHost()
    const exec = vi.fn(() =>
      Promise.resolve({ code: 1, signal: null, stdout: '', stderr }),
    )
    const process = new SkillagerProcess({ exec })
    const commands = new SkillagerReviewCommands(
      host,
      process,
      localPath('/context'),
      () => Promise.resolve(),
    )
    try {
      await expect(
        commands.accept(selection, snapshot, new AbortController().signal),
      ).rejects.toMatchObject({ reason })
      expect(exec).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(exec.mock.calls)).toContain('private-token')
    } finally {
      await process.dispose()
      await host.dispose()
    }
  })
  it.each(['unparseable', 'wrong-version', 'transport-loss'])(
    'considers %s completion uncertain and never repeats the mutation',
    async (variant) => {
      const host = new LocalHost()
      const exec = vi.fn((): Promise<ExecResult> =>
        variant === 'transport-loss'
          ? Promise.reject(new Error('PRIVATE transport failure'))
          : Promise.resolve({
              code: 0,
              signal: null,
              stderr: '',
              stdout:
                variant === 'unparseable'
                  ? 'PRIVATE invalid result'
                  : JSON.stringify({
                      schema: 'skillager.library-accept.v1',
                      status: 'accepted',
                      skill: {
                        id: 'lib/example',
                        path: snapshot.detail.root.path,
                        working_hash: hash,
                      },
                      approval: { state: 'reviewed', content_hash: 'b'.repeat(64) },
                    }),
            }),
      )
      const process = new SkillagerProcess({ exec })
      const commands = new SkillagerReviewCommands(
        host,
        process,
        localPath('/context'),
        () => Promise.resolve(),
      )
      try {
        const result = await commands
          .accept(selection, snapshot, new AbortController().signal)
          .catch((error: unknown) => error)
        expect(result).toMatchObject({ reason: 'uncertain' })
        expect(String(result)).not.toContain('PRIVATE')
        expect(exec).toHaveBeenCalledTimes(1)
      } finally {
        await process.dispose()
        await host.dispose()
      }
    },
  )
})
