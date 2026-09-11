import { describe, expect, it, vi } from 'vitest'
import type { ExecResult } from '../src/shared'
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
