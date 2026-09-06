import { describe, expect, it, vi } from 'vitest'
import { localPath } from '../src/shared'
import type { ProjectHost } from '../src/main/project-host'
import { SmokeCleanup } from '../src/main/smoke/cleanup'
import { createViewerFixtures } from '../src/main/smoke/viewer-fixtures'

describe('viewer smoke fixture requirements', () => {
  it.each([
    ['positionDocument', '.hvir-smoke-position.md'],
    ['largeJson', '.hvir-smoke-large.json'],
    ['largeText', '.hvir-smoke-large.txt'],
    ['oversizedDiff', '.hvir-smoke-oversized-diff.txt'],
  ] as const)(
    'constructs only the requested %s fixture plus common live reload',
    async (requirement, file) => {
      const root = localPath('/smoke-project')
      const host = {
        writeFile: vi.fn<ProjectHost['writeFile']>().mockResolvedValue(undefined),
        exec: vi
          .fn<ProjectHost['exec']>()
          .mockResolvedValue({ code: 0, signal: null, stdout: '', stderr: '' }),
      }
      const cleanup = new SmokeCleanup()
      await createViewerFixtures(host, root, cleanup, {
        positionDocument: false,
        largeJson: false,
        largeText: false,
        oversizedDiff: false,
        [requirement]: true,
      })
      expect(host.writeFile.mock.calls.map(([path]) => path)).toEqual([
        localPath('/smoke-project/.hvir-smoke-live.txt'),
        localPath(`/smoke-project/${file}`),
      ])
      await cleanup.run()
      expect(host.exec.mock.calls).toContainEqual([
        'rm',
        ['-f', '--', `/smoke-project/${file}`],
      ])
      expect(host.exec).toHaveBeenCalledTimes(5)
      await cleanup.run()
      expect(host.exec).toHaveBeenCalledTimes(5)
    },
  )
})
