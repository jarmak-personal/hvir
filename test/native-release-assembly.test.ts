import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { assembleNativeRelease } from '../scripts/assemble-native-release.mjs'

const roots: string[] = []
const sourceSha = 'a'.repeat(40)

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })))
})

describe('native release assembly', () => {
  it('binds the exact source, installer, artifacts, checksums, and notices', async () => {
    const fixture = await createFixture()
    const result = await assembleNativeRelease(fixture.options)
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8')) as {
      version: string
      tag: string
      sourceCommit: string
      artifacts: Array<{
        platform: string
        architecture: string
        name: string
        sha256: string
      }>
      installer: { name: string; sha256: string }
      notices: { name: string; sha256: string }
    }

    expect(manifest).toMatchObject({
      version: '1.2.3',
      tag: 'v1.2.3',
      sourceCommit: sourceSha,
      artifacts: [
        {
          platform: 'linux',
          architecture: 'x64',
          name: 'hvir-1.2.3-linux-x64.deb',
        },
        {
          platform: 'linux',
          architecture: 'arm64',
          name: 'hvir-1.2.3-linux-arm64.deb',
        },
        {
          platform: 'macos',
          architecture: 'arm64',
          name: 'hvir-1.2.3-darwin-arm64.pkg',
        },
      ],
      installer: { name: 'install.sh' },
      notices: { name: 'THIRD_PARTY_NOTICES.md' },
    })
    expect(await readdir(fixture.assetDirectory)).toEqual([
      'SHA256SUMS',
      'THIRD_PARTY_NOTICES.md',
      'hvir-1.2.3-darwin-arm64.pkg',
      'hvir-1.2.3-linux-arm64.deb',
      'hvir-1.2.3-linux-x64.deb',
      'install.sh',
      'release-manifest.json',
    ])

    const installer = await readFile(result.installerPath, 'utf8')
    for (const artifact of manifest.artifacts) {
      expect(installer).toContain(artifact.name)
      expect(installer).toContain(artifact.sha256)
    }
    const checksumLines = (await readFile(result.checksumsPath, 'utf8'))
      .trim()
      .split('\n')
    expect(checksumLines).toHaveLength(6)
    for (const line of checksumLines) {
      const separator = line.indexOf('  ')
      expect(separator).toBeGreaterThan(0)
      const digest = line.slice(0, separator)
      const name = line.slice(separator + 2)
      expect(digest).toBe(await sha256(join(fixture.assetDirectory, name)))
    }
    expect(manifest.installer.sha256).toBe(
      await sha256(join(fixture.assetDirectory, manifest.installer.name)),
    )
    expect(manifest.notices.sha256).toBe(
      await sha256(join(fixture.assetDirectory, manifest.notices.name)),
    )
  })

  it('fails closed for incomplete, unexpected, or ambiguous release inputs', async () => {
    const missing = await createFixture()
    await rm(join(missing.assetDirectory, 'hvir-1.2.3-linux-arm64.deb'))
    await expect(assembleNativeRelease(missing.options)).rejects.toThrow(
      /Missing release input/,
    )

    const unexpected = await createFixture()
    await writeFile(join(unexpected.assetDirectory, 'partial.zip'), 'partial')
    await expect(assembleNativeRelease(unexpected.options)).rejects.toThrow(
      /Unexpected release inputs/,
    )

    const invalidSource = await createFixture()
    await expect(
      assembleNativeRelease({ ...invalidSource.options, sourceSha: 'main' }),
    ).rejects.toThrow(/full lowercase commit SHA/)
  })
})

async function createFixture() {
  const assetDirectory = await mkdtemp(join(tmpdir(), 'hvir-release-assembly-'))
  roots.push(assetDirectory)
  await Promise.all([
    writeFile(join(assetDirectory, 'hvir-1.2.3-linux-x64.deb'), 'linux-x64'),
    writeFile(join(assetDirectory, 'hvir-1.2.3-linux-arm64.deb'), 'linux-arm64'),
    writeFile(join(assetDirectory, 'hvir-1.2.3-darwin-arm64.pkg'), 'darwin-arm64'),
  ])
  return {
    assetDirectory,
    options: {
      version: '1.2.3',
      sourceSha,
      repository: 'jarmak-personal/hvir',
      macosTeamId: 'ABCDE12345',
      assetDirectory,
    },
  }
}

async function sha256(path: string) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}
