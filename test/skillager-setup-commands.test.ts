import { describe, expect, it, vi } from 'vitest'
import { SkillagerSetupCommands } from '../src/main/skillager/skillager-setup-commands'
import { SkillagerProcess } from '../src/main/skillager/skillager-process'
import type { ExecOptions } from '../src/main/project-host/project-host'
import type { ExecResult } from '../src/shared/fs-types'
import { localPath } from '../src/shared/host-path'
import {
  setupInitialization,
  setupStatus,
  setupSelection,
  setupLibrary,
} from './fixtures/skillager-setup-fixture'

function fixture(gitHistory = true) {
  const exec = vi.fn(
    (
      _command: string,
      args: readonly string[],
      _options?: ExecOptions,
    ): Promise<ExecResult> =>
      Promise.resolve({
        code: 0,
        signal: null,
        stdout: JSON.stringify(
          args.includes('init')
            ? setupInitialization(gitHistory)
            : setupStatus(gitHistory),
        ),
        stderr: '',
      }),
  )
  const validate = vi.fn(() => Promise.resolve())
  const commands = new SkillagerSetupCommands(
    new SkillagerProcess({ exec }),
    localPath('/private/context'),
    validate,
  )
  return { commands, exec, validate }
}

describe('library initialization command boundary', () => {
  it.each([true, false])(
    'uses only selected CLI/catalog/private context and explicit Git=%s',
    async (gitHistory) => {
      const f = fixture(gitHistory),
        signal = new AbortController().signal
      expect(
        await f.commands.initialize(
          setupSelection,
          localPath(setupLibrary.root),
          gitHistory,
          signal,
        ),
      ).toMatchObject({ kind: 'ready', status: { gitHistory } })
      const prefix = [
        '--catalog-state-dir',
        '/catalog',
        '--state-dir',
        '/private/context',
      ]
      expect(f.exec.mock.calls.map(([, args]) => args)).toEqual([
        [
          ...prefix,
          'library',
          'init',
          '--path',
          '/personal/library',
          '--json',
          ...(gitHistory ? [] : ['--no-git']),
        ],
        [...prefix, 'library', 'status', '--json'],
      ])
      for (const [command, , options] of f.exec.mock.calls) {
        expect(command).toBe('/tools/skillager')
        expect(options).toMatchObject({
          cwd: localPath('/private/context'),
          env: setupSelection.environment,
          maxStderrBytes: 65536,
        })
      }
      expect(f.validate).toHaveBeenCalledWith(
        expect.objectContaining({
          library: {
            id: setupLibrary.library_id,
            root: localPath(setupLibrary.root),
            skillsRoot: localPath(setupLibrary.skills_path),
          },
        }),
        signal,
      )
    },
  )
  it('requires a fresh matching registration and status after a successful init', async () => {
    const f = fixture()
    f.exec.mockResolvedValueOnce({
      code: 0,
      signal: null,
      stdout: JSON.stringify(setupInitialization()),
      stderr: '',
    })
    f.exec.mockResolvedValueOnce({
      code: 0,
      signal: null,
      stdout: JSON.stringify({
        ...setupStatus(),
        library: { ...setupLibrary, library_id: '12345678-1234-1234-1234-123456789abc' },
      }),
      stderr: '',
    })
    await expect(
      f.commands.initialize(
        setupSelection,
        localPath(setupLibrary.root),
        true,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ reason: 'library-changed' })
  })
  it.each([
    { code: 0, stdout: 'not-json', reason: 'malformed-result' },
    { code: 2, stdout: '', reason: 'uncertain' },
  ])(
    'never treats process output alone as verified success: %s',
    async ({ code, stdout, reason }) => {
      const f = fixture()
      f.exec.mockResolvedValueOnce({
        code,
        signal: null,
        stdout,
        stderr: 'PRIVATE diagnostic/body',
      })
      const attempt = f.commands.initialize(
        setupSelection,
        localPath(setupLibrary.root),
        true,
        new AbortController().signal,
      )
      await expect(attempt).rejects.toMatchObject({ reason })
      await expect(attempt).rejects.not.toThrow('PRIVATE')
      expect(f.exec).toHaveBeenCalledOnce()
    },
  )
  it('reports the proven missing-Git preflight refusal without silently rerunning no-Git', async () => {
    const f = fixture()
    f.exec.mockResolvedValueOnce({
      code: 2,
      signal: null,
      stdout: '',
      stderr:
        'skillager: error: git executable is unavailable; install Git or run `skillager library init --no-git`\n',
    })
    const refused = await f.commands.initialize(
      setupSelection,
      localPath(setupLibrary.root),
      true,
      new AbortController().signal,
    )
    expect(refused.kind).toBe('refused')
    if (refused.kind !== 'refused') throw Error('Expected a preflight refusal')
    expect(refused.message).toContain('explicitly turn off Keep Git history')
    expect(f.exec).toHaveBeenCalledOnce()
  })
  it('does not launch a mutation after prior cancellation', async () => {
    const f = fixture(),
      controller = new AbortController()
    controller.abort()
    expect(
      await f.commands.initialize(
        setupSelection,
        localPath(setupLibrary.root),
        true,
        controller.signal,
      ),
    ).toMatchObject({ kind: 'refused' })
    expect(f.exec).not.toHaveBeenCalled()
  })
})
