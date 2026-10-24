import { describe, expect, it, vi } from 'vitest'
import { localPath } from '../src/shared'
import type { ProjectHost } from '../src/main/project-host'
import { SmokeCleanup } from '../src/main/smoke/cleanup'
import { createViewerFixtures } from '../src/main/smoke/viewer-fixtures'

describe('viewer smoke fixture requirements', () => {
  it.each([
    [
      'positionDocument',
      [
        '.hvir-smoke-dense-find.txt',
        '.hvir-smoke-dense-highlight.js',
        '.hvir-smoke-position.md',
      ],
    ],
    ['largeJson', ['.hvir-smoke-large.json']],
    ['largeText', ['.hvir-smoke-large.txt']],
    ['oversizedDiff', ['.hvir-smoke-oversized-diff.txt']],
  ] as const)(
    'constructs only the requested %s fixture plus common live reload',
    async (requirement, files) => {
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
        ...files.map((file) => localPath(`/smoke-project/${file}`)),
      ])
      await cleanup.run()
      for (const file of files) {
        expect(host.exec.mock.calls).toContainEqual([
          'rm',
          ['-f', '--', `/smoke-project/${file}`],
        ])
      }
      if (requirement === 'positionDocument') {
        const writes = new Map(
          host.writeFile.mock.calls.map(([path, content]) => [path.path, content]),
        )
        expect(writes.get('/smoke-project/.hvir-smoke-dense-find.txt')?.length).toBe(
          4 * 1024 * 1024,
        )
        expect(writes.get('/smoke-project/.hvir-smoke-dense-highlight.js')?.length).toBe(
          201800,
        )
      }
      expect(host.exec).toHaveBeenCalledTimes(5 + files.length - 1)
      await cleanup.run()
      expect(host.exec).toHaveBeenCalledTimes(5 + files.length - 1)
    },
  )
})
