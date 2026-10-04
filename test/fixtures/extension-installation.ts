import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { localPath } from '../../src/shared/host-path'
import { LocalHost } from '../../src/main/project-host/local-host'
import { ExtensionPackageStore } from '../../src/main/extensions/package-store'
import { ExtensionActivationOwner } from '../../src/main/extensions/activation'
import { exampleManifest } from './extension-package'

export async function extensionInstallationFixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'hvir-activation-'))
  const directory = join(root, 'extensions')
  const packages = join(root, 'packages')
  await fs.mkdir(directory)
  await fs.mkdir(packages)
  const trashed: string[] = []
  const host = new LocalHost({
    trashItem: async (path) => {
      trashed.push(path.path)
      await fs.rename(path.path, join(root, `trash-${trashed.length}`))
    },
  })
  const revoke = vi.fn()
  const make = (
    forgotten?: (id: string) => void,
    deliveryForgotten?: ConstructorParameters<typeof ExtensionActivationOwner>[8],
  ) =>
    new ExtensionActivationOwner(
      host,
      localPath(directory),
      localPath(join(root, 'state.json')),
      new ExtensionPackageStore(host, localPath(packages)),
      revoke,
      vi.fn(),
      forgotten,
      undefined,
      deliveryForgotten,
    )
  const packageAt = async (name: string, overrides: Record<string, unknown> = {}) => {
    const path = join(directory, name)
    await fs.mkdir(path)
    await fs.writeFile(
      join(path, 'hvir-extension.json'),
      JSON.stringify(exampleManifest(overrides)),
    )
    await fs.writeFile(join(path, 'index.html'), 'original')
    await fs.writeFile(join(path, 'detail.html'), 'detail')
  }
  return {
    root,
    trashed,
    packages,
    directory,
    make,
    packageAt,
    revoke,
    host,
    lock: localPath(join(root, 'writer.lock')),
    dispose: () => fs.rm(root, { recursive: true, force: true }),
  }
}
