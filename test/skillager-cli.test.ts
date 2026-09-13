import { describe, expect, it, vi } from 'vitest'
import { SkillagerCli } from '../src/main/skillager/skillager-cli'
import { SkillagerError } from '../src/main/skillager/skillager-port'
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
    stat: vi.fn(() => Promise.reject(new Error('Unexpected review stat'))),
    readdir: vi.fn(() => Promise.reject(new Error('Unexpected review directory read'))),
    createDirectoryExclusive: vi.fn(() =>
      Promise.reject(new Error('Unexpected review directory creation')),
    ),
    exec: vi.fn(
      (
        command: string,
        args: readonly string[],
        options?: ExecOptions,
      ): Promise<ExecResult> => {
        calls.push({ command, args, cwd: options?.cwd?.path })
        const stdout =
          command === '/bin/sh'
            ? `\x1ehvir-skillager-probe\x1f${overrides.missing ? '' : '/tools/skillager'}\0/catalog\0PATH=/login/bin\0`
            : args.includes('--version')
              ? `skillager ${overrides.unsupported ? '0.8.1' : '0.9.0'}`
              : args.length === 2 && args[0] === 'search' && args[1] === '--help'
                ? '--scope --full-json --limit'
                : args.includes('list')
                  ? JSON.stringify({
                      collections: overrides.library === false ? {} : { lib: library },
                    })
                  : args.includes('refresh')
                    ? JSON.stringify({
                        schema: 'skillager.collection-index.v1',
                        name: 'lib',
                        library_id: library.library_id,
                        path: library.path,
                        errors: [],
                        skills: [],
                      })
                    : args.includes('search')
                      ? '[]'
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
  it.each(['all', 'claude'] as const)(
    'submits one ranked search using %s preference without compatibility filtering',
    async (browseAgent) => {
      const { cli, calls } = fixture()
      try {
        const signal = new AbortController().signal
        const selection = await cli.probe(undefined, signal)
        await cli.search(
          selection,
          {
            connectionId: 'connection',
            requestId: 1,
            workspaceRoot: localPath('/project'),
            agent: 'codex',
            browseAgent,
            query: 'needle',
            scope: 'workspace',
          },
          signal,
        )
        const searches = calls.filter(
          (call) => call.args.includes('search') && !call.args.includes('--help'),
        )
        expect(searches).toHaveLength(1)
        const args = searches[0]!.args
        expect(args.includes('--agent')).toBe(browseAgent !== 'all')
        if (browseAgent !== 'all')
          expect(args[args.indexOf('--agent') + 1]).toBe(browseAgent)
        expect(args).not.toContain('--compatible-only')
        expect(args.slice(-2)).toEqual(['--', 'needle'])
        expect(args[args.indexOf('--limit') + 1]).toBe('50')
      } finally {
        await cli.dispose()
      }
    },
  )
  it('observes all project agents in one public exposure list without changing concrete setup agent', async () => {
    const { cli, host } = fixture(),
      original = host.exec.getMockImplementation()!
    host.exec.mockImplementation((command, args, options) =>
      args.includes('expose')
        ? Promise.resolve({
            code: 0,
            signal: null,
            stdout: JSON.stringify({ schema: 'skillager.exposures.v1', exposures: [] }),
            stderr: '',
          })
        : original(command, args, options),
    )
    try {
      const signal = new AbortController().signal,
        selection = await cli.probe(undefined, signal)
      await cli.exposures(
        selection,
        {
          connectionId: 'connection',
          requestId: 1,
          workspaceRoot: localPath('/project'),
          agent: 'codex',
          browseAgent: 'all',
        },
        signal,
      )
      const calls = host.exec.mock.calls.filter(([, args]) => args.includes('expose'))
      expect(calls).toHaveLength(1)
      expect(calls[0]![1]).toEqual(
        expect.arrayContaining([
          '--list',
          '--all-agents',
          '--scope',
          'project',
          '--json',
        ]),
      )
      expect(calls[0]![1]).not.toContain('--agent')
    } finally {
      await cli.dispose()
    }
  })
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
  it('passes leading-dash queries after all CLI options as one literal argument', async () => {
    const { cli, calls } = fixture()
    try {
      const signal = new AbortController().signal
      const selection = await cli.probe(undefined, signal)
      await cli.search(
        selection,
        {
          connectionId: 'connected',
          requestId: 1,
          workspaceRoot: localPath('/workspace'),
          agent: 'codex',
          scope: 'library',
          query: '--help',
        },
        signal,
      )
      const args = calls.find((call) => call.args.includes('--full-json'))!.args
      expect(args.slice(-2)).toEqual(['--', '--help'])
      expect(args.indexOf('--limit')).toBeLessThan(args.indexOf('--'))
    } finally {
      await cli.dispose()
    }
  })
  it.each([
    'timeout',
    'output-limit',
    'cancelled',
    'command-failed',
    'malformed-result',
  ] as const)('preserves %s when temporary-state cleanup also fails', async (reason) => {
    const { cli, host } = fixture()
    const run = host.exec.getMockImplementation()!
    const signal = new AbortController().signal
    const selection = await cli.probe(undefined, signal)
    host.exec.mockImplementation((command, args, options) => {
      if (command === 'rm')
        return Promise.resolve({
          code: 1,
          signal: null,
          stdout: '',
          stderr: 'PRIVATE CLEANUP',
        })
      if (args.includes('refresh'))
        return reason === 'malformed-result'
          ? Promise.resolve({ code: 0, signal: null, stdout: 'invalid json', stderr: '' })
          : Promise.reject(new SkillagerError(reason, `Primary ${reason}.`))
      return run(command, args, options)
    })
    try {
      const pending = cli.inventory(selection, signal)
      await expect(pending).rejects.toMatchObject({ reason })
      await expect(pending).rejects.toThrow('Temporary state cleanup also failed.')
    } finally {
      host.exec.mockImplementation(run)
      await cli.dispose()
    }
  })
  it('reports cleanup failure after an otherwise successful inventory', async () => {
    const { cli, host } = fixture()
    const run = host.exec.getMockImplementation()!
    const signal = new AbortController().signal
    const selection = await cli.probe(undefined, signal)
    host.exec.mockImplementation((command, args, options) =>
      command === 'rm'
        ? Promise.resolve({
            code: 1,
            signal: null,
            stdout: '',
            stderr: 'PRIVATE CLEANUP',
          })
        : run(command, args, options),
    )
    try {
      await expect(cli.inventory(selection, signal)).rejects.toMatchObject({
        reason: 'command-failed',
        message: 'Could not remove the temporary Skillager context.',
      })
    } finally {
      host.exec.mockImplementation(run)
      await cli.dispose()
    }
  })
})
