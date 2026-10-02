import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { EXTENSION_LIMITS } from '../src/shared/extensions/contract'
import { localPath } from '../src/shared/host-path'
import { extensionInstallationFixture as fixture } from './fixtures/extension-installation'
import { validateCapturedExtension } from '../src/main/extensions/package-store'
import { extensionZip } from './fixtures/extension-archive'
import { exampleManifest } from './fixtures/extension-package'

describe('stored package collection at the native filesystem boundary', () => {
  it.each(['insert', 'change', 'directory'] as const)(
    'preserves a known %s introduced after the initial capture check',
    async (mutation) => {
      const data = await fixture()
      let changed = false
      const open = fs.open.bind(fs)
      try {
        await data.packageAt('reference')
        const source = localPath(join(data.directory, 'reference'))
        const captured = await data.host.extensionStorage.captureDirectory(
          source,
          EXTENSION_LIMITS,
        )
        const intercepted = vi
          .spyOn(fs, 'open')
          .mockImplementation(async (path, flags, mode) => {
            const handle = await open(path, flags, mode)
            if (path === data.directory && !changed) {
              changed = true
              if (mutation === 'insert')
                await fs.writeFile(join(source.path, 'foreign'), 'unowned')
              if (mutation === 'change')
                await fs.writeFile(join(source.path, 'index.html'), 'modified')
              if (mutation === 'directory') await fs.mkdir(join(source.path, 'unowned'))
            }
            return handle
          })
        try {
          await expect(
            data.host.extensionStorage.collectDirectory(
              source,
              captured,
              EXTENSION_LIMITS.files,
            ),
          ).rejects.toThrow()
          if (mutation === 'insert')
            expect(await fs.readFile(join(source.path, 'foreign'), 'utf8')).toBe(
              'unowned',
            )
          if (mutation === 'change')
            expect(await fs.readFile(join(source.path, 'index.html'), 'utf8')).toBe(
              'modified',
            )
          if (mutation === 'directory')
            expect((await fs.stat(join(source.path, 'unowned'))).isDirectory()).toBe(true)
        } finally {
          intercepted.mockRestore()
        }
      } finally {
        await data.dispose()
      }
    },
  )
  it('stops cleanup effects when the activation writer is lost during an awaited collection read', async () => {
    const data = await fixture(),
      owner = data.make()
    const open = fs.open.bind(fs)
    let lost = false
    let collecting = false
    const collect = data.host.extensionStorage.collectDirectory.bind(
      data.host.extensionStorage,
    )
    const observeCollection = vi
      .spyOn(data.host.extensionStorage, 'collectDirectory')
      .mockImplementation((...args) => {
        collecting = true
        return collect(...args)
      })
    try {
      await data.packageAt('reference')
      await owner.start(data.lock)
      await owner.enable('reference', owner.snapshot().installations[0]!.revision!)
      for (let index = 0; index < 2; index++) {
        await fs.writeFile(
          join(data.directory, 'reference', 'index.html'),
          `before-${index}`,
        )
        await owner.reload('reference', owner.snapshot().installations[0]!.revision!)
      }
      const before = await fs.readdir(data.packages)
      const intercepted = vi
        .spyOn(fs, 'open')
        .mockImplementation(async (path, flags, mode) => {
          const handle = await open(path, flags, mode)
          if (path === data.packages && collecting && !lost) {
            lost = true
            await fs.rename(data.lock.path, `${data.lock.path}.old`)
            await fs.writeFile(data.lock.path, '')
            await expect(owner.assertWritable()).rejects.toThrow('revoked')
          }
          return handle
        })
      try {
        await fs.writeFile(join(data.directory, 'reference', 'index.html'), 'after')
        await expect(
          owner.reload('reference', owner.snapshot().installations[0]!.revision!),
        ).rejects.toThrow()
        expect(lost).toBe(true)
        expect(await fs.readdir(data.packages)).toEqual(before)
        expect(owner.active.size).toBe(0)
      } finally {
        intercepted.mockRestore()
      }
    } finally {
      observeCollection.mockRestore()
      await owner.dispose()
      await data.dispose()
    }
  })
  it('loads the same bounded nested ZIP after retain and rejects common ambiguous parents for both sources', async () => {
    const data = await fixture(),
      owner = data.make()
    try {
      const files = new Map([
        ['hvir-extension.json', Buffer.from(JSON.stringify(exampleManifest()))],
        ['index.html', Buffer.from('index')],
        ['detail.html', Buffer.from('detail')],
      ])
      for (let index = 0; index < 126; index++)
        files.set(`dir${index}/file`, Buffer.from('x'))
      await fs.writeFile(join(data.directory, 'nested.zip'), await extensionZip(files))
      await owner.start(data.lock)
      const selected = owner.snapshot().installations[0]!
      await owner.enable(selected.source, selected.revision!)
      expect((await owner.packages.load(selected.revision!)).files.size).toBe(files.size)
      await owner.remove(selected.source, selected.sourceIdentity, true)
      expect(await fs.readdir(data.packages)).toEqual([])
      for (const pair of [
        ['a/one', 'A/two'],
        ['a', 'A/child'],
      ]) {
        const ambiguous = new Map([...files].filter(([name]) => !name.includes('/')))
        for (const name of pair) ambiguous.set(name, Buffer.from('x'))
        expect(() =>
          validateCapturedExtension({ sourceIdentity: '1:1', files: ambiguous }),
        ).toThrow('conflict')
        await fs.writeFile(
          join(data.directory, 'ambiguous.zip'),
          await extensionZip(ambiguous),
        )
        await expect(
          owner.packages.captureSource(localPath(join(data.directory, 'ambiguous.zip'))),
        ).rejects.toThrow('conflict')
      }
    } finally {
      await owner.dispose()
      await data.dispose()
    }
  })
})

describe('source capture identity at the opened descriptor', () => {
  it.each(['before-open', 'after-open'] as const)(
    'refuses an identically named ZIP replaced %s',
    async (phase) => {
      const data = await fixture(),
        owner = data.make()
      const open = fs.open.bind(fs)
      let replaced = false
      try {
        const path = join(data.directory, 'reference.zip')
        const archive = await extensionZip(
          new Map([
            ['hvir-extension.json', Buffer.from(JSON.stringify(exampleManifest()))],
            ['index.html', Buffer.from('same bytes')],
            ['detail.html', Buffer.from('detail')],
          ]),
        )
        await fs.writeFile(path, archive)
        const replace = async () => {
          replaced = true
          await fs.rename(path, `${path}.prior`)
          await fs.writeFile(path, archive)
        }
        const intercepted = vi
          .spyOn(fs, 'open')
          .mockImplementation(async (target, flags, mode) => {
            if (target === path && !replaced && phase === 'before-open') await replace()
            const handle = await open(target, flags, mode)
            if (target === path && !replaced && phase === 'after-open') await replace()
            return handle
          })
        try {
          await expect(owner.packages.captureSource(localPath(path))).rejects.toThrow(
            /changed|replaced/u,
          )
          expect(replaced).toBe(true)
        } finally {
          intercepted.mockRestore()
        }
      } finally {
        await owner.dispose()
        await data.dispose()
      }
    },
  )
})
