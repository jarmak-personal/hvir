import { describe, expect, it, vi } from 'vitest'
import * as yauzl from 'yauzl'
import { captureExtensionArchive } from '../src/main/extensions/package-archive'
import { EXTENSION_LIMITS } from '../src/shared/extensions/contract'
import { extensionZip, alterZipCentral } from './fixtures/extension-archive'

describe('bounded ZIP package data adapter', () => {
  it('decodes assets and refuses corrupted CRCs, incomplete drops and compressed capacity overflow', async () => {
    const files = new Map([['index.html', Buffer.from('<h1>hello</h1>')]])
    const zip = await extensionZip(files)
    expect(await captureExtensionArchive(zip)).toEqual(files)
    await expect(
      captureExtensionArchive(
        alterZipCentral(zip, (header) => header.writeUInt32LE(0, 16)),
      ),
    ).rejects.toThrow('checksum')
    await expect(
      captureExtensionArchive(zip.subarray(0, zip.length - 10)),
    ).rejects.toThrow()
    await expect(
      captureExtensionArchive(Buffer.alloc(EXTENSION_LIMITS.archiveBytes + 1)),
    ).rejects.toThrow('compressed')
  })
  it.each(['../bad.html', '/badxx.html', 'a\\bad.html', 'bad:%html'])(
    'refuses hostile destination %s before any filesystem extraction',
    async (path) => {
      const zip = await extensionZip(new Map([['safe-x.html', Buffer.from('x')]]))
      const hostile = alterZipCentral(zip, (header) =>
        Buffer.from(path.padEnd(11, 'x')).copy(header, 46, 0, 11),
      )
      await expect(captureExtensionArchive(hostile)).rejects.toThrow()
    },
  )
  it('refuses links, duplicate portable names and file/directory conflicts', async () => {
    const zip = await extensionZip(new Map([['index.html', Buffer.from('x')]]))
    await expect(
      captureExtensionArchive(
        alterZipCentral(zip, (header) =>
          header.writeUInt32LE((0o120777 << 16) >>> 0, 38),
        ),
      ),
    ).rejects.toThrow('without links')
    await expect(
      captureExtensionArchive(
        await extensionZip(
          new Map([
            ['Index.html', Buffer.from('x')],
            ['index.html', Buffer.from('y')],
          ]),
        ),
      ),
    ).rejects.toThrow('conflict')
    await expect(
      captureExtensionArchive(
        await extensionZip(
          new Map([
            ['index.html', Buffer.from('x')],
            ['index.html/file', Buffer.from('y')],
          ]),
        ),
      ),
    ).rejects.toThrow('conflict')
  })
  it('bounds expanded bytes, depth and complete materialized entries including implicit directories', async () => {
    await expect(
      captureExtensionArchive(
        await extensionZip(
          new Map([['large', Buffer.alloc(EXTENSION_LIMITS.fileBytes + 1)]]),
        ),
      ),
    ).rejects.toThrow('expanded')
    await expect(
      captureExtensionArchive(
        await extensionZip(new Map([[Array(14).fill('a').join('/'), Buffer.from('x')]])),
      ),
    ).rejects.toThrow('deep')
    const files = new Map(
      Array.from(
        { length: 129 },
        (_value, index) => [`dir${index}/file`, Buffer.from('x')] as const,
      ),
    )
    await expect(captureExtensionArchive(await extensionZip(files))).rejects.toThrow(
      'materialized',
    )
    const bytes = new Map(
      Array.from(
        { length: 9 },
        (_value, index) =>
          [`file${index}`, Buffer.alloc(EXTENSION_LIMITS.fileBytes)] as const,
      ),
    )
    await expect(captureExtensionArchive(await extensionZip(bytes))).rejects.toThrow(
      'expanded',
    )
  })
  it('rejects authority revocation while waiting for an entry, not just during an asset stream', async () => {
    const zip = await extensionZip(new Map([['index.html', Buffer.from('x')]]))
    const read = vi
      .spyOn(yauzl.ZipFile.prototype, 'readEntry')
      .mockImplementation(() => undefined)
    const authority = new AbortController()
    try {
      const pending = captureExtensionArchive(zip, authority.signal)
      const refused = expect(pending).rejects.toThrow('revoked')
      await vi.waitFor(() => expect(read).toHaveBeenCalled())
      authority.abort(new Error('revoked'))
      await refused
    } finally {
      read.mockRestore()
    }
  })
})

describe('shared portable captured topology', () => {
  it.each([
    {
      pairs: [
        ['a/one', 'x'],
        ['A/two', 'y'],
      ],
    },
    {
      pairs: [
        ['a', 'x'],
        ['A/child', 'y'],
      ],
    },
  ])(
    'refuses ambiguous materialized parent topology in ZIP $pairs',
    async ({ pairs }) => {
      await expect(
        captureExtensionArchive(
          await extensionZip(
            new Map(pairs.map(([name, value]) => [name!, Buffer.from(value!)])),
          ),
        ),
      ).rejects.toThrow('conflict')
    },
  )
})
