import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { LocalHost } from '../src/main/project-host/local-host'
import { localPath } from '../src/shared/host-path'
import { managedDirectoryMechanicsCases } from './managed-directory-mechanics-cases'

it.runIf(process.platform === 'linux')(
  'executes the fixed directory mechanics and external races on Linux',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hvir-managed-mechanics-')))
    const host = new LocalHost()
    try {
      expect(await managedDirectoryMechanicsCases(host, localPath(root))).toHaveLength(18)
    } finally {
      await host.dispose()
      await rm(root, { recursive: true, force: true })
    }
  },
  90_000,
)
