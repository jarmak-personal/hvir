import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { readInstallationState } from '../src/main/extensions/installation-state'
import { EXTENSION_LIMITS } from '../src/shared/extensions/contract'
import { extensionInstallationFixture as fixture } from './fixtures/extension-installation'
import { extensionZip } from './fixtures/extension-archive'
import { exampleManifest } from './fixtures/extension-package'

async function zipAt(directory: string, name = 'package.zip', text = 'ZIP') {
  await fs.writeFile(
    join(directory, name),
    await extensionZip(
      new Map([
        ['hvir-extension.json', Buffer.from(JSON.stringify(exampleManifest()))],
        ['index.html', Buffer.from(text)],
        ['detail.html', Buffer.from('detail')],
      ]),
    ),
  )
}

describe('explicit package revision and removal lifetime', () => {
  it('reloads edited directories without rebuilding, revokes the old generation and retains installation identity', async () => {
    const data = await fixture(),
      owner = data.make()
    try {
      await data.packageAt('reference')
      await owner.start(data.lock)
      await owner.enable('reference', owner.snapshot().installations[0]!.revision!)
      const previous = [...owner.active.values()][0]!
      await fs.writeFile(join(data.directory, 'reference', 'index.html'), 'edited')
      await owner.reload('reference', previous.revision.hash)
      const current = [...owner.active.values()][0]!
      expect(current.installationId).toBe(previous.installationId)
      expect(current.generation).not.toBe(previous.generation)
      expect(data.revoke).toHaveBeenCalledWith(previous.installationId)
      expect(Buffer.from(current.revision.files.get('index.html')!).toString()).toBe(
        'edited',
      )
      await fs.writeFile(
        join(data.directory, 'reference', 'hvir-extension.json'),
        JSON.stringify(
          exampleManifest({
            access: [
              {
                id: 'broader',
                description: 'Invalid writable scope',
                context: 'application',
                mode: 'write',
              },
            ],
          }),
        ),
      )
      await expect(owner.reload('reference', current.revision.hash)).rejects.toThrow(
        'Invalid declared source or managed delivery scope',
      )
      expect([...owner.active.values()][0]).toBe(current)
      expect(data.revoke).toHaveBeenCalledTimes(1)
    } finally {
      await owner.dispose()
      await data.dispose()
    }
  })
  it('shares ZIP/directory validation and stored load contract, refuses duplicate identity without preferring source kind', async () => {
    const data = await fixture(),
      owner = data.make()
    try {
      await zipAt(data.directory)
      await owner.start(data.lock)
      const zip = owner.snapshot().installations[0]!
      expect(zip.kind).toBe('zip')
      await owner.enable(zip.source, zip.revision!)
      const current = [...owner.active.values()][0]!
      expect((await owner.packages.load(current.revision.hash)).hash).toBe(
        current.revision.hash,
      )
      await data.packageAt('directory')
      await owner.discover()
      expect(owner.active.size).toBe(0)
      expect(
        owner
          .snapshot()
          .installations.filter((entry) => entry.error?.includes('Duplicate')),
      ).toHaveLength(2)
    } finally {
      await owner.dispose()
      await data.dispose()
    }
  })
  it('retains identity when a removed directory reappears as a ZIP at another path, and Forget releases its state and revisions', async () => {
    const data = await fixture(),
      owner = data.make()
    try {
      await data.packageAt('reference')
      await owner.start(data.lock)
      await owner.enable('reference', owner.snapshot().installations[0]!.revision!)
      const original = [...owner.active.values()][0]!
      const selected = owner.snapshot().installations[0]!
      await owner.remove('reference', selected.sourceIdentity, false)
      expect(owner.active.size).toBe(0)
      expect(data.trashed).toHaveLength(1)
      await zipAt(data.directory, 'reinstall.zip')
      await owner.discover()
      const reappeared = owner
        .snapshot()
        .installations.find((entry) => entry.source === 'reinstall.zip')!
      expect(reappeared.installationId).toBe(original.installationId)
      expect(reappeared.enabled).toBe(false)
      await owner.remove(reappeared.source, reappeared.sourceIdentity, true)
      const saved = readInstallationState(
        JSON.parse(await fs.readFile(join(data.root, 'state.json'), 'utf8')),
      )
      expect(saved.installations).toEqual([])
      expect(saved.removals).toEqual([])
      expect(await fs.readdir(data.packages)).toEqual([])
      expect(await fs.readFile(join(data.root, 'trash-1', 'index.html'), 'utf8')).toBe(
        'original',
      )
    } finally {
      await owner.dispose()
      await data.dispose()
    }
  })
  it('supports development edits and removes only the selected link, including an unaccepted link with a missing target', async () => {
    const data = await fixture(),
      owner = data.make()
    try {
      const author = join(data.root, 'author')
      await data.packageAt('author-source')
      await fs.rename(join(data.directory, 'author-source'), author)
      await fs.symlink(author, join(data.directory, 'development'))
      await fs.symlink(join(data.root, 'missing-author'), join(data.directory, 'missing'))
      await owner.start(data.lock)
      let selected = owner
        .snapshot()
        .installations.find((entry) => entry.source === 'development')!
      expect(selected.kind).toBe('development')
      await owner.enable(selected.source, selected.revision!)
      await fs.writeFile(join(author, 'index.html'), 'author edit')
      await owner.reload(selected.source, selected.revision!)
      expect(
        Buffer.from(
          [...owner.active.values()][0]!.revision.files.get('index.html')!,
        ).toString(),
      ).toBe('author edit')
      selected = owner
        .snapshot()
        .installations.find((entry) => entry.source === 'development')!
      await owner.remove(selected.source, selected.sourceIdentity, true)
      expect(await fs.readFile(join(author, 'index.html'), 'utf8')).toBe('author edit')
      const missing = owner
        .snapshot()
        .installations.find((entry) => entry.source === 'missing')!
      expect(missing.error).toBeTruthy()
      await owner.remove(missing.source, missing.sourceIdentity, false)
      await expect(fs.lstat(join(data.directory, 'missing'))).rejects.toMatchObject({
        code: 'ENOENT',
      })
      expect(data.trashed).toHaveLength(0)
    } finally {
      await owner.dispose()
      await data.dispose()
    }
  })
  it('trashes an invalid unaccepted ZIP without requiring repaired content or touching unrelated files', async () => {
    const data = await fixture(),
      owner = data.make()
    try {
      await fs.writeFile(join(data.directory, 'incomplete.zip'), 'not a ZIP')
      await fs.writeFile(join(data.root, 'user-data'), 'preserve')
      await owner.start(data.lock)
      const entry = owner.snapshot().installations[0]!
      expect(entry.error).toBeTruthy()
      await owner.remove(entry.source, entry.sourceIdentity, true)
      expect(data.trashed).toHaveLength(1)
      expect(await fs.readFile(join(data.root, 'user-data'), 'utf8')).toBe('preserve')
      expect(
        readInstallationState(
          JSON.parse(await fs.readFile(join(data.root, 'state.json'), 'utf8')),
        ).installations,
      ).toEqual([])
    } finally {
      await owner.dispose()
      await data.dispose()
    }
  })
  it('retains truthful removal intent after failed trash, survives restart and retries without reactivation', async () => {
    const data = await fixture(),
      owner = data.make(),
      successor = data.make()
    const trash = data.host.fileDeletion
    if (trash.capability !== 'recoverable') throw new Error('fixture trash unavailable')
    const failure = vi
      .spyOn(trash, 'trashEntry')
      .mockRejectedValueOnce(new Error('trash refused'))
    try {
      await data.packageAt('reference')
      await owner.start(data.lock)
      await owner.enable('reference', owner.snapshot().installations[0]!.revision!)
      const selected = owner.snapshot().installations[0]!
      await expect(
        owner.remove(selected.source, selected.sourceIdentity, false),
      ).rejects.toThrow('trash refused')
      expect(owner.active.size).toBe(0)
      await owner.dispose()
      await successor.start(data.lock)
      expect(successor.snapshot().installations[0]!.removalPending).toBe(true)
      expect(successor.active.size).toBe(0)
      await successor.remove('reference', undefined, true)
      expect(data.trashed).toHaveLength(1)
      expect(successor.snapshot().installations).toEqual([])
    } finally {
      failure.mockRestore()
      await owner.dispose()
      await successor.dispose()
      await data.dispose()
    }
  })
  it('refuses entry replacement between selection and staging and preserves the replacement and author data', async () => {
    const data = await fixture(),
      owner = data.make()
    const rename = data.host.fileTransfer.renameNoReplace.bind(data.host.fileTransfer)
    let raced = false
    const intercepted = vi
      .spyOn(data.host.fileTransfer, 'renameNoReplace')
      .mockImplementation(async (source, destination, options) => {
        if (!raced && destination.path.includes('remove-')) {
          raced = true
          await fs.rename(source.path, join(data.root, 'original-link'))
          await fs.symlink(join(data.root, 'unrelated'), source.path)
        }
        return rename(source, destination, options)
      })
    try {
      await fs.mkdir(join(data.root, 'unrelated'))
      await fs.writeFile(join(data.root, 'unrelated', 'keep'), 'domain data')
      await fs.symlink(join(data.root, 'absent'), join(data.directory, 'development'))
      await owner.start(data.lock)
      const selected = owner.snapshot().installations[0]!
      await expect(
        owner.remove(selected.source, selected.sourceIdentity, false),
      ).rejects.toThrow('changed during removal')
      expect((await fs.lstat(join(data.directory, 'development'))).isSymbolicLink()).toBe(
        true,
      )
      expect(await fs.readFile(join(data.root, 'unrelated', 'keep'), 'utf8')).toBe(
        'domain data',
      )
      expect(data.trashed).toHaveLength(0)
    } finally {
      intercepted.mockRestore()
      await owner.dispose()
      await data.dispose()
    }
  })
  it('does not restore rejected startup sources after bytes revert at another restart', async () => {
    const data = await fixture(),
      owner = data.make(),
      rejected = data.make(),
      successor = data.make()
    try {
      await data.packageAt('reference')
      await owner.start(data.lock)
      await owner.enable('reference', owner.snapshot().installations[0]!.revision!)
      await owner.dispose()
      await fs.writeFile(join(data.directory, 'reference', 'index.html'), 'external')
      await rejected.start(data.lock)
      expect(rejected.active.size).toBe(0)
      await rejected.dispose()
      await fs.writeFile(join(data.directory, 'reference', 'index.html'), 'original')
      await successor.start(data.lock)
      expect(successor.active.size).toBe(0)
    } finally {
      await owner.dispose()
      await rejected.dispose()
      await successor.dispose()
      await data.dispose()
    }
  })
  it('serializes user acceptance after held startup collection rather than collecting its preparation', async () => {
    const data = await fixture(),
      owner = data.make()
    const enumerate = data.host.extensionStorage.installationNames.bind(
      data.host.extensionStorage,
    )
    let finish!: () => void
    let heldOnce = false
    const held = vi
      .spyOn(data.host.extensionStorage, 'installationNames')
      .mockImplementation(async (path, limit) => {
        if (path.path === data.packages && !heldOnce) {
          heldOnce = true
          await new Promise<void>((resolve) => {
            finish = resolve
          })
        }
        return enumerate(path, limit)
      })
    try {
      await data.packageAt('reference')
      const starting = owner.start(data.lock)
      await vi.waitFor(() => expect(finish).toBeDefined())
      const accepting = owner.enable(
        'reference',
        owner.snapshot().installations[0]!.revision!,
      )
      await Promise.resolve()
      expect(owner.active.size).toBe(0)
      finish()
      await starting
      await accepting
      expect(owner.active.size).toBe(1)
      expect(
        (await fs.readdir(data.packages)).filter((name) => !name.startsWith('.')),
      ).toHaveLength(1)
    } finally {
      finish?.()
      held.mockRestore()
      await owner.dispose()
      await data.dispose()
    }
  })
  it('retains bounded recent history and preserves accepted revision pins while refusing a second writer', async () => {
    const data = await fixture(),
      owner = data.make(),
      conflict = data.make()
    try {
      await data.packageAt('reference')
      await owner.start(data.lock)
      await owner.enable('reference', owner.snapshot().installations[0]!.revision!)
      for (let index = 0; index < 6; index++) {
        await fs.writeFile(
          join(data.directory, 'reference', 'index.html'),
          `revision-${index}`,
        )
        await owner.reload('reference', owner.snapshot().installations[0]!.revision!)
      }
      const active = [...owner.active.values()][0]!
      expect(await fs.readdir(data.packages)).toHaveLength(
        EXTENSION_LIMITS.revisionsPerInstallation,
      )
      expect((await owner.packages.load(active.revision.hash)).hash).toBe(
        active.revision.hash,
      )
      await conflict.start(data.lock)
      await expect(
        conflict.remove(
          'reference',
          owner.snapshot().installations[0]!.sourceIdentity,
          true,
        ),
      ).rejects.toThrow('Another hvir instance')
      expect(owner.active.size).toBe(1)
    } finally {
      await owner.dispose()
      await conflict.dispose()
      await data.dispose()
    }
  })
})

describe('interrupted preparation and global capacity', () => {
  it('cleans a bounded interrupted capture including its empty directories under the next writer', async () => {
    const data = await fixture(),
      owner = data.make()
    try {
      const partial = join(data.packages, '.capture-12345678-1234-1234-1234-123456789abc')
      await fs.mkdir(join(partial, 'empty'), { recursive: true })
      await fs.writeFile(join(partial, 'partial.html'), 'not executable before admission')
      await owner.start(data.lock)
      expect(owner.snapshot().explanation).toBeUndefined()
      expect(await fs.readdir(data.packages)).toEqual([])
      expect(owner.active.size).toBe(0)
    } finally {
      await owner.dispose()
      await data.dispose()
    }
  })
  it('refuses protected global byte capacity without revoking the valid active installation', async () => {
    const data = await fixture(),
      owner = data.make()
    try {
      for (let index = 0; index < 8; index++) {
        await data.packageAt(`package-${index}`, { id: `example.package-${index}` })
        await fs.writeFile(
          join(data.directory, `package-${index}`, 'asset-half'),
          Buffer.alloc(1024 * 1024),
        )
        for (let asset = 0; asset < 7; asset++)
          await fs.writeFile(
            join(data.directory, `package-${index}`, `asset-${asset}`),
            Buffer.alloc(EXTENSION_LIMITS.fileBytes),
          )
      }
      await owner.start(data.lock)
      for (const entry of owner.snapshot().installations)
        await owner.enable(entry.source, entry.revision!)
      const original = [...owner.active.values()][0]!
      await fs.writeFile(join(data.directory, 'package-0', 'index.html'), 'new bytes')
      await expect(owner.reload('package-0', original.revision.hash)).rejects.toThrow(
        'capacity',
      )
      expect(owner.active.get(original.installationId)).toBe(original)
      expect(await fs.readdir(data.packages)).toHaveLength(8)
    } finally {
      await owner.dispose()
      await data.dispose()
    }
  })
})

describe('retention cleanup failure recovery', () => {
  it('preserves partial obsolete cleanup, identifies exact repair and keeps unrelated accepted activation usable', async () => {
    const data = await fixture(),
      owner = data.make(),
      successor = data.make()
    const collect = data.host.extensionStorage.collectDirectory.bind(
      data.host.extensionStorage,
    )
    let broken: string | undefined
    const fault = vi
      .spyOn(data.host.extensionStorage, 'collectDirectory')
      .mockImplementation(async (path, expected, maxEntries, signal) => {
        if (!broken) {
          broken = path.path.split('/').at(-1)!
          await fs.unlink(join(path.path, 'hvir-extension.json'))
          throw new Error('cleanup interrupted after unlink')
        }
        return collect(path, expected, maxEntries, signal)
      })
    try {
      await data.packageAt('reference')
      await owner.start(data.lock)
      await owner.enable('reference', owner.snapshot().installations[0]!.revision!)
      for (let index = 0; index < 2; index++) {
        await fs.writeFile(
          join(data.directory, 'reference', 'index.html'),
          `accepted-${index}`,
        )
        await owner.reload('reference', owner.snapshot().installations[0]!.revision!)
      }
      const active = [...owner.active.values()][0]!
      await fs.writeFile(join(data.directory, 'reference', 'index.html'), 'next')
      await expect(owner.reload('reference', active.revision.hash)).rejects.toThrow(
        'cleanup interrupted',
      )
      expect(owner.active.get(active.installationId)).toBe(active)
      expect(
        await fs.readFile(join(data.packages, broken!, 'index.html'), 'utf8'),
      ).toBeTruthy()
      fault.mockRestore()
      await owner.dispose()
      // Restore the accepted source so startup can restore the valid protected revision.
      await fs.writeFile(join(data.directory, 'reference', 'index.html'), 'accepted-1')
      await successor.start(data.lock)
      expect(successor.active.size).toBe(1)
      expect(successor.snapshot().explanation).toContain(
        `Unused stored revision ${broken}`,
      )
      expect(successor.snapshot().explanation).toContain(
        'move only extension-state/packages/',
      )
      await data.packageAt('unrelated', { id: 'example.unrelated' })
      await successor.discover()
      const candidate = successor
        .snapshot()
        .installations.find((entry) => entry.source === 'unrelated')!
      await expect(
        successor.enable(candidate.source, candidate.revision!),
      ).rejects.toThrow(broken!)
      expect(successor.active.size).toBe(1)
      await fs.rename(
        join(data.packages, broken!),
        join(data.root, 'retained-inspection'),
      )
      await successor.enable(candidate.source, candidate.revision!)
      expect(successor.active.size).toBe(2)
    } finally {
      fault.mockRestore()
      await owner.dispose()
      await successor.dispose()
      await data.dispose()
    }
  })
  it('keeps ordinary discovery visible beside owned pending-removal staging at full package capacity', async () => {
    const data = await fixture(),
      owner = data.make()
    if (data.host.fileDeletion.capability !== 'recoverable')
      throw new Error('fixture trash unavailable')
    const fail = vi
      .spyOn(data.host.fileDeletion, 'trashEntry')
      .mockRejectedValueOnce(new Error('held trash'))
    const rename = data.host.fileTransfer.renameNoReplace.bind(data.host.fileTransfer)
    const holdRestore = vi
      .spyOn(data.host.fileTransfer, 'renameNoReplace')
      .mockImplementation((source, destination, options) => {
        if (source.path.includes('/remove-'))
          return Promise.reject(new Error('restore held'))
        return rename(source, destination, options)
      })
    try {
      for (let index = 0; index < 32; index++)
        await data.packageAt(`package-${index}`, { id: `example.package-${index}` })
      await owner.start(data.lock)
      const selected = owner
        .snapshot()
        .installations.find((entry) => entry.source === 'package-0')!
      await expect(
        owner.remove(selected.source, selected.sourceIdentity, false),
      ).rejects.toThrow('held trash')
      await data.packageAt('new-package', { id: 'example.new-package' })
      await owner.discover()
      const state = owner.snapshot()
      expect(
        state.installations.filter((entry) => !!entry.revision && !entry.error),
      ).toHaveLength(32)
      expect(
        state.installations.find((entry) => entry.source === 'package-0')?.removalPending,
      ).toBe(true)
    } finally {
      holdRestore.mockRestore()
      fail.mockRestore()
      await owner.dispose()
      await data.dispose()
    }
  })
})
