import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { localPath } from '../src/shared/host-path'
import { readInstallationState } from '../src/main/extensions/installation-state'
import { extensionInstallationFixture as fixture } from './fixtures/extension-installation'
import { extensionZip } from './fixtures/extension-archive'
import { exampleManifest } from './fixtures/extension-package'

describe('recoverable package removal at the filesystem and trash boundary', () => {
  it('refuses unavailable trash before moving the selected package', async () => {
    const data = await fixture(),
      owner = data.make()
    const original = data.host.fileDeletion
    try {
      await data.packageAt('reference')
      await owner.start(data.lock)
      const selected = owner.snapshot().installations[0]!
      Object.defineProperty(data.host, 'fileDeletion', {
        value: { capability: 'unavailable' },
        configurable: true,
      })
      await expect(
        owner.remove(selected.source, selected.sourceIdentity, false),
      ).rejects.toThrow('remains in the extensions folder')
      expect(await fs.readdir(data.directory)).toEqual(['reference'])
      expect(
        await fs.readFile(join(data.directory, 'reference', 'index.html'), 'utf8'),
      ).toBe('original')
    } finally {
      Object.defineProperty(data.host, 'fileDeletion', {
        value: original,
        configurable: true,
      })
      await owner.dispose()
      await data.dispose()
    }
  })
  it('restores the exact selected entry after failed trash without restoring enabled access', async () => {
    const data = await fixture(),
      owner = data.make()
    if (data.host.fileDeletion.capability !== 'recoverable')
      throw new Error('fixture trash unavailable')
    const fail = vi
      .spyOn(data.host.fileDeletion, 'trashEntry')
      .mockRejectedValueOnce(new Error('trash refused'))
    try {
      await data.packageAt('reference')
      await owner.start(data.lock)
      await owner.enable('reference', owner.snapshot().installations[0]!.revision!)
      const selected = owner.snapshot().installations[0]!
      await expect(
        owner.remove(selected.source, selected.sourceIdentity, false),
      ).rejects.toThrow(`restored to ${join(data.directory, 'reference')}`)
      expect(
        await data.host.extensionStorage.entryIdentity(
          localPath(join(data.directory, 'reference')),
        ),
      ).toBe(selected.sourceIdentity)
      expect(await fs.readdir(data.directory)).toEqual(['reference'])
      expect(owner.active.size).toBe(0)
    } finally {
      fail.mockRestore()
      await owner.dispose()
      await data.dispose()
    }
  })
  it('preserves a foreign source and exact visible staged package when restoration conflicts', async () => {
    const data = await fixture(),
      owner = data.make()
    if (data.host.fileDeletion.capability !== 'recoverable')
      throw new Error('fixture trash unavailable')
    const fail = vi
      .spyOn(data.host.fileDeletion, 'trashEntry')
      .mockImplementationOnce(async () => {
        await fs.mkdir(join(data.directory, 'reference'))
        await fs.writeFile(join(data.directory, 'reference', 'foreign'), 'preserve')
        throw new Error('trash refused')
      })
    try {
      await data.packageAt('reference')
      await owner.start(data.lock)
      const selected = owner.snapshot().installations[0]!
      let message = ''
      try {
        await owner.remove(selected.source, selected.sourceIdentity, false)
      } catch (reason) {
        message = String(reason)
      }
      const saved = readInstallationState(
        JSON.parse(await fs.readFile(join(data.root, 'state.json'), 'utf8')),
      )
      const staging = saved.removals[0]!.staging
      expect(staging.startsWith('.')).toBe(false)
      expect(message).toContain(join(data.directory, staging))
      expect(message).toContain(join(data.directory, 'reference'))
      expect(await fs.readFile(join(data.directory, staging, 'index.html'), 'utf8')).toBe(
        'original',
      )
      expect(
        await fs.readFile(join(data.directory, 'reference', 'foreign'), 'utf8'),
      ).toBe('preserve')
      expect(
        await data.host.extensionStorage.entryIdentity(
          localPath(join(data.directory, staging)),
        ),
      ).toBe(selected.sourceIdentity)
    } finally {
      fail.mockRestore()
      await owner.dispose()
      await data.dispose()
    }
  })
  it.each(['directory', 'zip'] as const)(
    'recovers a %s from Trash under a visible discoverable name and requires Enable',
    async (kind) => {
      const data = await fixture(),
        owner = data.make()
      try {
        if (kind === 'directory') await data.packageAt('reference')
        else
          await fs.writeFile(
            join(data.directory, 'reference.zip'),
            await extensionZip(
              new Map([
                ['hvir-extension.json', Buffer.from(JSON.stringify(exampleManifest()))],
                ['index.html', Buffer.from('original')],
                ['detail.html', Buffer.from('detail')],
              ]),
            ),
          )
        await owner.start(data.lock)
        const selected = owner.snapshot().installations[0]!
        await owner.enable(selected.source, selected.revision!)
        await owner.remove(selected.source, selected.sourceIdentity, false)
        const recovered = basename(data.trashed[0]!)
        expect(recovered.startsWith('.')).toBe(false)
        if (kind === 'zip') expect(recovered.endsWith('.zip')).toBe(true)
        await fs.rename(join(data.root, 'trash-1'), join(data.directory, recovered))
        await owner.discover()
        const candidate = owner
          .snapshot()
          .installations.find((entry) => entry.source === recovered)!
        expect(candidate.error).toBeUndefined()
        expect(candidate.kind).toBe(kind)
        expect(candidate.revision).toBe(selected.revision)
        expect(candidate.enabled).toBe(false)
        expect(owner.active.size).toBe(0)
      } finally {
        await owner.dispose()
        await data.dispose()
      }
    },
  )
})
