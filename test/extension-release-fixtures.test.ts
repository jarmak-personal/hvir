import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { extensionInstallationFixture } from './fixtures/extension-installation'
import { captureExtensionSource } from '../src/main/extensions/package-store'
import { validateExtensionManifest } from '../src/shared/extensions/manifest'
import { localPath } from '../src/shared/host-path'
import { extensionPackageArchive } from '../scripts/extension-package-archive.mts'
import { buildSkillagerExtensionArchive } from '../scripts/prepare-skillager-extension.mts'

const root = 'test/fixtures/extensions/0.3.0'
it('encodes the same DOS metadata and package bytes across host time zones', async () => {
  const run = promisify(execFile)
  const program = `import {extensionPackageArchive} from './scripts/extension-package-archive.mts';
    const bytes = await extensionPackageArchive(new Map([['hvir-extension.json', Buffer.from('{}')]]));
    process.stdout.write(bytes.toString('base64'));`
  const results = await Promise.all(
    ['UTC', 'America/New_York', 'Asia/Tokyo'].map((TZ) =>
      run(process.execPath, ['--input-type=module', '--eval', program], {
        env: { ...process.env, TZ },
        timeout: 10000,
        maxBuffer: 4096,
      }),
    ),
  )
  expect(new Set(results.map((result) => result.stdout)).size).toBe(1)
})
it('keeps complete independently frozen released bytes valid as directory and ZIP inputs', async () => {
  const inventory = JSON.parse(
    await fs.readFile(join(root, 'inventory.json'), 'utf8'),
  ) as {
    release: string
    contract: string
    files: Record<string, { bytes: number; sha256: string }>
  }
  const data = await extensionInstallationFixture()
  try {
    const actual: string[] = []
    for (const name of ['clock', 'reference']) {
      const directory = join(root, name)
      const revision = await captureExtensionSource(
        data.host,
        localPath(join(process.cwd(), directory)),
      )
      expect(revision.manifest.version).toBe(inventory.release)
      expect(revision.manifest.contract).toBe(inventory.contract)
      for (const [file, bytes] of revision.files) {
        const key = `${name}/${file}`
        actual.push(key)
        expect(inventory.files[key]).toEqual({
          bytes: bytes.byteLength,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        })
      }
      const archive = join(data.directory, `${name}.zip`)
      await fs.writeFile(archive, await extensionPackageArchive(revision.files))
      const captured = await captureExtensionSource(data.host, localPath(archive))
      expect(captured.hash).toBe(revision.hash)
      expect(captured.kind).toBe('zip')
      expect(
        validateExtensionManifest({ ...revision.manifest, contract: '1.99' }).manifest
          .contract,
      ).toBe('1.99')
      expect(() =>
        validateExtensionManifest({
          ...revision.manifest,
          contract: '1.99',
          requiredCapabilities: [
            ...revision.manifest.requiredCapabilities,
            'future.required-safety',
          ],
        }),
      ).toThrow('future.required-safety')
    }
    expect(actual.sort()).toEqual(Object.keys(inventory.files).sort())
  } finally {
    await data.dispose()
  }
})

it('builds deterministic ready-to-install Skillager ZIP bytes through the ordinary validator', async () => {
  const data = await extensionInstallationFixture()
  try {
    const first = join(data.directory, 'first.zip'),
      second = join(data.directory, 'second.zip')
    await buildSkillagerExtensionArchive(first)
    await buildSkillagerExtensionArchive(second)
    expect(await fs.readFile(first)).toEqual(await fs.readFile(second))
    const revision = await captureExtensionSource(data.host, localPath(first))
    expect(revision.manifest).toMatchObject({
      id: 'skillager',
      version: '0.3.0',
      contract: '1.0',
    })
    expect(revision.manifest.connectors).toHaveLength(2)
    expect([...revision.files.keys()].sort()).toEqual([
      'README.md',
      'detail.html',
      'guest-ui.js',
      'hvir-extension.json',
      'library.html',
      'management.html',
      'operations.js',
      'presentation.css',
      'primitives.css',
      'project.html',
      'skillager.css',
      'skillager.js',
      'tokens.css',
      'updater.html',
      'updater.js',
    ])
    expect(Buffer.from(revision.files.get('management.html')!).toString()).toContain(
      'operations.js',
    )
    expect(Buffer.from(revision.files.get('library.html')!).toString()).toContain(
      'skillager.js',
    )
  } finally {
    await data.dispose()
  }
})
