import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  digest,
  pin,
  pinPath,
  verifyArtifact,
  type NativeArtifact,
} from '../scripts/native-terminal/artifacts.mts'

let root: string
let manifest: NativeArtifact
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hvir-native-artifact-test-'))
  const files = []
  for (const name of [
    'libghostty.dylib',
    'loader-probe',
    'hvir_ghostty_embed.h',
    'ghostty.h',
  ]) {
    await writeFile(join(root, name), `artifact ${name}`)
    files.push({
      path: name,
      sha256: await digest(join(root, name)),
      bytes: (await readFile(join(root, name))).length,
    })
  }
  manifest = {
    schema: 1,
    source: 'a'.repeat(40),
    pinSha256: await digest(pinPath),
    target: 'macos-arm64',
    applicationVersion: pin.source.applicationVersion,
    vtVersion: pin.source.vtVersion,
    embedAbi: pin.source.embedAbi,
    build: { development: false },
    files,
  }
  await save(manifest)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
async function save(value: unknown) {
  await writeFile(join(root, 'manifest.json'), JSON.stringify(value))
}

describe('native artifact admission before loader execution', () => {
  it('admits complete matching bytes without loading any code', async () => {
    expect((await verifyArtifact(root, 'macos-arm64')).source).toBe(manifest.source)
  })
  it.each([
    'target',
    'applicationVersion',
    'vtVersion',
    'embedAbi',
    'pinSha256',
  ] as const)('rejects mismatched %s', async (field) => {
    await save({ ...manifest, [field]: 'wrong' })
    await expect(verifyArtifact(root, 'macos-arm64')).rejects.toThrow('identity mismatch')
  })
  it('rejects changed artifact bytes', async () => {
    await writeFile(join(root, 'libghostty.dylib'), 'corrupt library')
    await expect(verifyArtifact(root, 'macos-arm64')).rejects.toThrow('corrupt file')
  })
  it('rejects a missing loader before invoking it', async () => {
    await save({
      ...manifest,
      files: manifest.files.filter((f) => f.path !== 'loader-probe'),
    })
    await expect(verifyArtifact(root, 'macos-arm64')).rejects.toThrow()
  })
  it.each(['../library', '/library', 'notices/../library', 'notices\\..\\library'])(
    'rejects escaped record %s',
    async (path) => {
      await save({
        ...manifest,
        files: [{ ...manifest.files[0], path }, ...manifest.files.slice(1)],
      })
      await expect(verifyArtifact(root, 'macos-arm64')).rejects.toThrow(
        'invalid file record',
      )
    },
  )
  it('rejects duplicate file authority', async () => {
    await save({ ...manifest, files: [...manifest.files, manifest.files[0]] })
    await expect(verifyArtifact(root, 'macos-arm64')).rejects.toThrow(
      'invalid file record',
    )
  })
  it('rejects symlinked library bytes even if their digest matches', async () => {
    await writeFile(
      join(root, 'other-library'),
      await readFile(join(root, 'libghostty.dylib')),
    )
    await rm(join(root, 'libghostty.dylib'))
    await symlink(join(root, 'other-library'), join(root, 'libghostty.dylib'))
    await expect(verifyArtifact(root, 'macos-arm64')).rejects.toThrow('escaped file')
  })
  it('requires explicit development admission for uncommitted build inputs', async () => {
    await save({ ...manifest, build: { development: true } })
    await expect(verifyArtifact(root, 'macos-arm64')).rejects.toThrow('identity mismatch')
    await expect(verifyArtifact(root, 'macos-arm64', true)).resolves.toMatchObject({
      build: { development: true },
    })
  })
})
