import { describe, expect, it, vi } from 'vitest'
import { SkillagerLibrarySyncCommands } from '../src/main/skillager/skillager-library-sync-commands'
import { SkillagerProcess } from '../src/main/skillager/skillager-process'
import { SkillagerError } from '../src/main/skillager/skillager-port'
import type { ExecOptions } from '../src/main/project-host/project-host'
import { asHostId, hostPath, localPath } from '../src/shared/host-path'
import {
  syncSelection,
  syncStatusRaw,
  syncCompletionRaw,
  syncContext,
} from './fixtures/skillager-sync-fixture'
function fixture() {
  const exec = vi.fn(
    (_command: string, args: readonly string[], _options?: ExecOptions) =>
      Promise.resolve({
        code: 0,
        signal: null,
        stdout: JSON.stringify(
          args.includes('--approved') ? syncCompletionRaw() : syncStatusRaw(),
        ),
        stderr: '',
      }),
  )
  const validate = vi.fn(() => Promise.resolve()),
    submitted = vi.fn()
  const runner = new SkillagerProcess({ exec })
  return {
    exec,
    validate,
    submitted,
    runner,
    commands: new SkillagerLibrarySyncCommands(
      runner,
      localPath('/personal/context'),
      validate,
    ),
    signal: new AbortController().signal,
  }
}
describe('selected public sync commands', () => {
  it('binds exact UUID/root/catalog/local cwd and existing finite process output', async () => {
    const f = fixture()
    await f.commands.status(syncSelection, syncContext, f.signal)
    await f.commands.apply(syncSelection, syncContext, f.signal, f.submitted)
    expect(f.submitted).toHaveBeenCalledOnce()
    expect(f.exec.mock.calls.map(([, args]) => args)).toEqual(
      ['--status', '--approved'].map((action) => [
        '--catalog-state-dir',
        '/catalog',
        'library',
        'sync',
        action,
        '--expected-library-id',
        syncSelection.library.id,
        '--expected-library-root',
        '/library',
        '--json',
      ]),
    )
    for (const [command, , options] of f.exec.mock.calls) {
      expect(command).toBe('/tools/skillager')
      expect(options).toMatchObject({
        cwd: syncContext,
        env: syncSelection.environment,
        maxStdoutBytes: 32 * 1024 * 1024,
        maxStderrBytes: 65536,
      })
    }
  })
  it('SSH contributes no local path or source context', async () => {
    const f = fixture(),
      raw = syncStatusRaw()
    raw.context.project_root = '/personal/context'
    f.exec.mockResolvedValueOnce({
      code: 0,
      signal: null,
      stdout: JSON.stringify(raw),
      stderr: '',
    })
    await f.commands.status(
      syncSelection,
      hostPath(asHostId('ssh'), '/remote/project'),
      f.signal,
    )
    expect(f.exec.mock.calls[0]![1]).toContain('--state-dir')
    expect(f.exec.mock.calls[0]![2]?.cwd).toEqual(localPath('/personal/context'))
    expect(JSON.stringify(f.exec.mock.calls)).not.toContain('/remote/project')
  })
  it('refuses a nested project context before apply and reports wrong post-apply context as uncertain', async () => {
    const f = fixture()
    await expect(
      f.commands.status(syncSelection, localPath('/workspace/nested'), f.signal),
    ).rejects.toMatchObject({ reason: 'invalid-request' })
    expect(f.submitted).not.toHaveBeenCalled()
    await expect(
      f.commands.apply(
        syncSelection,
        localPath('/workspace/nested'),
        f.signal,
        f.submitted,
      ),
    ).rejects.toMatchObject({ reason: 'uncertain' })
  })
  it.each(['malformed', 'lost', 'timeout', 'output-limit'])(
    'does not retry %s output after submission',
    async (kind) => {
      const f = fixture()
      if (kind === 'malformed')
        f.exec.mockResolvedValueOnce({
          code: 0,
          signal: null,
          stdout: '{}',
          stderr: 'PRIVATE',
        })
      else
        f.exec.mockRejectedValueOnce(
          new SkillagerError(
            kind === 'lost' ? 'command-failed' : (kind as 'timeout' | 'output-limit'),
            'PRIVATE',
          ),
        )
      const attempt = f.commands.apply(syncSelection, syncContext, f.signal, f.submitted)
      await expect(attempt).rejects.toMatchObject({ reason: 'uncertain' })
      await expect(attempt).rejects.not.toThrow('PRIVATE')
      expect(f.exec).toHaveBeenCalledOnce()
    },
  )
  it('validation refusal precedes submission and shared busy admission does not pretend effects', async () => {
    const f = fixture()
    f.validate.mockRejectedValueOnce(new SkillagerError('library-changed', 'Changed'))
    await expect(
      f.commands.apply(syncSelection, syncContext, f.signal, f.submitted),
    ).rejects.toMatchObject({ reason: 'library-changed' })
    expect(f.exec).not.toHaveBeenCalled()
    expect(f.submitted).not.toHaveBeenCalled()
    f.exec.mockRejectedValueOnce(new SkillagerError('busy', 'Busy'))
    await expect(
      f.commands.apply(syncSelection, syncContext, f.signal, f.submitted),
    ).rejects.toMatchObject({ reason: 'busy' })
  })
})
