import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { LocalHost } from '../src/main/project-host/local-host'
import { SshManagedDirectory } from '../src/main/project-host/ssh-managed-directory'
import { inspectionLocation } from '../src/main/project-host/managed-directory-contract'
import { localPath } from '../src/shared/host-path'

it.each(['root', 'ancestor'] as const)(
  'preserves a replaced %s and returns its pre-effect refusal through real local pipes',
  async (replace) => {
    const fixture = await realpath(await mkdtemp(join(tmpdir(), 'hvir-stage-refusal-')))
    const root = localPath(join(fixture, 'workspace'))
    const host = new LocalHost(),
      port = new SshManagedDirectory(host, () => {})
    const bytes = Buffer.alloc(1024 * 1024, 0xfe)
    const tree = {
      files: [
        {
          entry: 'SKILL.md',
          mode: 0o644 as const,
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    }
    const entry = '.agents/skills/.candidate',
      signal = AbortSignal.timeout(5000)
    try {
      await mkdir(join(root.path, '.agents/skills'), { recursive: true })
      const observed = await port.inspect(root, entry, tree, signal)
      if (observed.status === 'different') throw Error('Expected absent fixture')
      const replaced = replace === 'root' ? root.path : join(root.path, '.agents/skills')
      await rename(replaced, replaced + '-retained')
      await mkdir(replaced)
      await writeFile(join(replaced, 'external-marker'), 'Retain replacement')
      await expect(
        port.stage(
          root,
          entry,
          tree,
          new Map([['SKILL.md', bytes]]),
          inspectionLocation(observed),
          signal,
        ),
      ).rejects.toMatchObject({ reason: 'refused' })
      expect((await host.readdir(localPath(replaced))).map((item) => item.name)).toEqual([
        'external-marker',
      ])
      expect(await host.readTextFile(localPath(join(replaced, 'external-marker')))).toBe(
        'Retain replacement',
      )
    } finally {
      await host.dispose()
      await rm(fixture, { recursive: true, force: true })
    }
  },
)
