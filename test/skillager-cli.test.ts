import { describe, expect, it, vi } from 'vitest'
import { SkillagerCli } from '../src/main/skillager/skillager-cli'
import { asHostId, hostPath, localPath } from '../src/shared/host-path'
import type { ExecOptions } from '../src/main/project-host/project-host'
import type { ExecResult } from '../src/shared'

function fixture(
  overrides: { missing?: boolean; unsupported?: boolean; library?: boolean } = {},
) {
  const calls: Array<{ command: string; args: readonly string[]; cwd?: string }> = []
  const library = {
    kind: 'library',
    library_id: '4f0467b4-bf3e-4c85-a11e-aac0f6071398',
    library_root: '/library',
    path: '/library/skills',
  }
  const host = {
    hostId: localPath('/').hostId,
    defaultShell: () => Promise.resolve('/bin/sh'),
    realpath: (path: ReturnType<typeof localPath>) => Promise.resolve(path),
    exec: vi.fn(
      (
        command: string,
        args: readonly string[],
        options?: ExecOptions,
      ): Promise<ExecResult> => {
        calls.push({ command, args, cwd: options?.cwd?.path })
        const stdout =
          command === '/bin/sh'
            ? `\x1ehvir-skillager-probe\x1f${overrides.missing ? '' : '/tools/skillager\n'}/catalog\n`
            : args.includes('--version')
              ? `skillager ${overrides.unsupported ? '0.8.1' : '0.9.0'}`
              : args.includes('--help')
                ? '--scope --full-json --limit'
                : args.includes('list')
                  ? JSON.stringify({
                      collections: overrides.library === false ? {} : { lib: library },
                    })
                  : ''
        return Promise.resolve({ code: 0, signal: null, stdout, stderr: '' })
      },
    ),
  }
  return {
    cli: new SkillagerCli(host, localPath('/private-context-parent')),
    host,
    calls,
  }
}

describe('Skillager local executable and explicit authority probe', () => {
  it('uses a private local context and only version/help/registration before connection', async () => {
    const { cli, calls } = fixture()
    try {
      const selection = await cli.probe(
        localPath('/tools/skillager'),
        new AbortController().signal,
      )
      expect(selection.executable).toEqual(localPath('/tools/skillager'))
      expect(selection.library?.id).toBe('4f0467b4-bf3e-4c85-a11e-aac0f6071398')
      expect(
        calls
          .filter((call) => call.command === '/tools/skillager')
          .map((call) => call.args),
      ).toEqual([
        ['--version'],
        ['search', '--help'],
        ['--catalog-state-dir', '/catalog', 'collection', 'list', '--json'],
      ])
      expect(calls.find((call) => call.command === 'mkdir')?.args).toContain('700')
      expect(
        calls
          .filter((call) => call.cwd)
          .every((call) => call.cwd?.startsWith('/private-context-parent/skillager-')),
      ).toBe(true)
    } finally {
      await cli.dispose()
    }
    expect(calls.at(-1)?.command).toBe('rm')
  })
  it.each([
    [{ missing: true }, undefined, 'missing'],
    [{ missing: true }, localPath('/missing'), 'invalid-executable'],
    [{ unsupported: true }, undefined, 'unsupported'],
    [{}, hostPath(asHostId('ssh'), '/skillager'), 'invalid-executable'],
  ] as const)(
    'keeps missing, selected path, compatibility and remote selection failures distinct',
    async (options, selected, reason) => {
      const { cli, calls } = fixture(options)
      try {
        await expect(
          cli.probe(selected, new AbortController().signal),
        ).rejects.toMatchObject({ reason })
      } finally {
        await cli.dispose()
      }
      expect(calls.some((call) => call.args.includes('refresh'))).toBe(false)
    },
  )
  it('reports an uninitialized library without creating or connecting it', async () => {
    const { cli, calls } = fixture({ library: false })
    try {
      expect(
        (await cli.probe(undefined, new AbortController().signal)).library,
      ).toBeUndefined()
    } finally {
      await cli.dispose()
    }
    expect(calls.some((call) => call.args.includes('init'))).toBe(false)
  })
})
