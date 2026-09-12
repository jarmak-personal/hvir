import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { LocalHost } from '../src/main/project-host/local-host'
import { localPath, type HostPath } from '../src/shared/host-path'
import type { ExecOptions } from '../src/main/project-host/project-host'
import type { ExecResult } from '../src/shared'
import { SkillagerNativeCommands } from '../src/main/skillager/skillager-native-commands'
import {
  SkillagerProcess,
  SKILLAGER_PROBE_LIMITS,
} from '../src/main/skillager/skillager-process'
import { selection, exposureResponse } from './fixtures/skillager-exposure-fixture'

it.each([false, true])(
  'cleans native scratch outside saturated process admission and preserves the original error (cleanup failure=%s)',
  async (cleanupFails) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hvir-native-cleanup-')))
    const original = Error('Source capture changed')
    const finish: Array<() => void> = [],
      held: Promise<string>[] = []
    const success = { code: 0, signal: null, stdout: '', stderr: '' } satisfies ExecResult
    let cleanupCalls = 0
    class FixtureHost extends LocalHost {
      override async exec(
        command: string,
        args: readonly string[],
        options?: ExecOptions,
      ) {
        if (command === 'rm') {
          cleanupCalls++
          if (cleanupFails) throw Error('Cleanup transport failed')
        }
        return super.exec(command, args, options)
      }
      override async createDirectoryExclusive(_path: HostPath): Promise<void> {
        held.push(
          ...[1, 2].map(() => process.run('hold', [], {}, SKILLAGER_PROBE_LIMITS)),
        )
        await Promise.resolve()
        throw original
      }
    }
    const host = new FixtureHost()
    const process = new SkillagerProcess({
      exec: (command, args, options) => {
        if (command === 'hold')
          return new Promise<ExecResult>((resolve) => finish.push(() => resolve(success)))
        if (command === selection.executable.path)
          return Promise.resolve({
            ...success,
            stdout: JSON.stringify({ skill: exposureResponse().row.preview.source }),
          })
        return host.exec(command, args, options)
      },
    })
    const dispose = vi.fn(() =>
      Promise.reject(Error('Verified snapshot disposal failed')),
    )
    const native = new SkillagerNativeCommands(
      host,
      process,
      localPath(root),
      {
        review: () =>
          Promise.resolve({
            detail: {
              skillId: 'lib/demo',
              root: localPath('/library/skills/demo'),
              hash: 'a'.repeat(64),
              canAccept: false,
              files: [],
              findings: [],
              scanRisk: 'low',
              lintStatus: 'ok',
              history: { available: false, versions: [] },
            },
            bytes: new Map(),
            confirmationToken: 'test',
            dispose,
          }),
      },
      async () => {},
      () => Promise.resolve([]),
    )
    try {
      await expect(
        native.nativeSnapshot(selection, 'lib/demo', 'codex', AbortSignal.timeout(5000)),
      ).rejects.toBe(original)
      expect(dispose).toHaveBeenCalledOnce()
      expect(cleanupCalls).toBe(1)
      expect((await readdir(root)).length).toBe(cleanupFails ? 1 : 0)
    } finally {
      finish.forEach((release) => release())
      await Promise.allSettled(held)
      await process.dispose()
      await host.dispose()
      await rm(root, { recursive: true, force: true })
    }
  },
)
