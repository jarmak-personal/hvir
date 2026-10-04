import { readFileSync } from 'node:fs'
import { createHash, webcrypto } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { buildSync } from 'esbuild'
import { expect, it } from 'vitest'

interface FileEntry {
  path: string
  size: number
  sha256: string
  executable: boolean
}
interface Manifest {
  schema: string
  library_id: string
  library_root: string
  skill_id: string
  skill_root: string
  working_hash: string
  confirmation_token: string
  files: FileEntry[]
  file_count: number
  total_bytes: number
}
interface Preview {
  review_manifest: Manifest
  next_command_argv: string[]
  requires_override: boolean
  skill: { id: string; path: string; working_hash: string }
}
function load<T>(name: string): T {
  const source = buildSync({
    entryPoints: [`packages/skillager-extension/src/${name}.mjs`],
    bundle: true,
    format: 'iife',
    globalName: 'Module',
    write: false,
  }).outputFiles[0]!.text
  const context = {
    TextEncoder,
    Uint8Array,
    crypto: webcrypto,
    atob,
    Module: undefined as unknown,
  }
  runInNewContext(source, context)
  return context.Module as T
}
function fixture() {
  const value = JSON.parse(
    readFileSync('test/fixtures/skillager-management/first-no-git-review.json', 'utf8'),
  ) as Preview
  const manifest = value.review_manifest
  return {
    value,
    manifest,
    binding: {
      library: {
        id: manifest.library_id,
        root: { hostId: 'local', path: manifest.library_root },
      },
      skillId: manifest.skill_id,
      root: { hostId: 'local', path: manifest.skill_root },
      hash: manifest.working_hash,
    },
  }
}
const contract = load<{
  exactReviewManifest(
    value: unknown,
    binding: unknown,
  ): { manifest: Manifest; eligible: boolean }
  sameReviewedManifest(reviewed: unknown, fresh: unknown): void
}>('review-contract')
it('admits the supported complete first no-Git manifest without relying on HEAD or approved body commands', () => {
  const f = fixture()
  expect(contract.exactReviewManifest(f.value, f.binding)).toMatchObject({
    eligible: true,
    manifest: f.manifest,
  })
  expect(() =>
    contract.exactReviewManifest({ ...f.value, review_manifest: undefined }, f.binding),
  ).toThrow(/Version alone/)
  expect(() =>
    contract.exactReviewManifest(f.value, { ...f.binding, hash: 'a'.repeat(64) }),
  ).toThrow(/version/)
})
it('keeps complete reading independent of missing/override confirmation, but never treats injected command flags as eligible', () => {
  const f = fixture()
  f.value.requires_override = true
  expect(contract.exactReviewManifest(f.value, f.binding)).toMatchObject({
    eligible: false,
    manifest: f.manifest,
  })
  f.value.requires_override = false
  f.value.next_command_argv.push('--force')
  expect(contract.exactReviewManifest(f.value, f.binding).eligible).toBe(false)
})
it('rejects incomplete totals, duplicate/escaping paths and changes to executable/token/library identity after reads', () => {
  const f = fixture()
  f.manifest.total_bytes++
  expect(() => contract.exactReviewManifest(f.value, f.binding)).toThrow(/totals/)
  f.manifest.total_bytes--
  for (const path of ['../outside', '/outside']) {
    f.manifest.files[0]!.path = path
    expect(() => contract.exactReviewManifest(f.value, f.binding)).toThrow(/path/)
  }
  const original = fixture().manifest
  for (const changed of [
    { ...original, library_id: 'different' },
    { ...original, confirmation_token: 'b'.repeat(64) },
    {
      ...original,
      files: original.files.map((file) => ({ ...file, executable: !file.executable })),
    },
  ])
    expect(() => contract.sameReviewedManifest(original, changed)).toThrow(
      /changed after reading/,
    )
})

const reader = load<{
  readReviewFile(
    client: unknown,
    manifest: Manifest,
    file: FileEntry,
    current: () => boolean,
  ): Promise<{ kind: string; text?: string; data?: string }>
}>('review-reading')
function readingFixture(text: string) {
  const { manifest } = fixture(),
    bytes = Buffer.from(text),
    file: FileEntry = {
      path: 'support.sh',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      executable: true,
    }
  const calls: Array<{ capability: string; input: Record<string, unknown> }> = []
  let pageText = text,
    selectedHash = file.sha256
  const client = {
    request(capability: string, input: Record<string, unknown>) {
      calls.push({ capability, input })
      if (capability === 'source.select')
        return Promise.resolve({
          receipt: 'selected',
          path: input['path'],
          currentFile: true,
          bytes: file.size,
          sha256: selectedHash,
        })
      return Promise.resolve(
        input['release'] ? null : { data: pageText, nextOffset: null },
      )
    },
  }
  return {
    manifest,
    file,
    calls,
    client,
    text: (value: string) => {
      pageText = value
    },
    hash: (value: string) => {
      selectedHash = value
    },
  }
}
it('verifies complete received UTF-8 bytes, current confined receipt and executable metadata, releasing the receipt', async () => {
  const f = readingFixture('#!/bin/sh\nprintf "日本"\n')
  await expect(
    reader.readReviewFile(f.client, f.manifest, f.file, () => true),
  ).resolves.toMatchObject({
    kind: 'text',
    text: '#!/bin/sh\nprintf "日本"\n',
    file: { executable: true },
  })
  expect(f.calls.at(-1)).toMatchObject({
    capability: 'source.read',
    input: { release: true },
  })
  f.text('different transferred bytes')
  await expect(
    reader.readReviewFile(f.client, f.manifest, f.file, () => true),
  ).rejects.toThrow(/received UTF-8 bytes differ/)
  f.hash('b'.repeat(64))
  await expect(
    reader.readReviewFile(f.client, f.manifest, f.file, () => true),
  ).rejects.toThrow(/current confined file/)
})
it('refuses nonimage binary and hidden/late reads with exact path and achievable CLI route, never omitting the file', async () => {
  const f = readingFixture('binary\0content')
  await expect(
    reader.readReviewFile(f.client, f.manifest, f.file, () => true),
  ).rejects.toThrow(/support.sh:.*nonimage binary.*public Skillager CLI/)
  const hidden = readingFixture('complete instructions')
  await expect(
    reader.readReviewFile(hidden.client, hidden.manifest, hidden.file, () => false),
  ).rejects.toThrow(/partial or hidden/)
  expect(hidden.calls.at(-1)?.input['release']).toBe(true)
})
it('verifies recognized image bytes through the selected entrypoint parent and generic SHA-256 without tree hashing', async () => {
  const { manifest } = fixture(),
    bytes = Buffer.from('owned-image-bytes'),
    file: FileEntry = {
      path: 'assets/image.png',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      executable: false,
    }
  const entry = manifest.files[0]!,
    released: string[] = []
  const client = {
    request(capability: string, input: Record<string, unknown>) {
      if (capability === 'source.select')
        return Promise.resolve({
          receipt: 'parent',
          path: input['path'],
          currentFile: true,
          bytes: entry.size,
          sha256: entry.sha256,
        })
      if (capability === 'source.asset')
        return Promise.resolve({ receipt: 'image', mime: 'image/png', bytes: file.size })
      if (input['release']) {
        released.push(String(input['receipt']))
        return Promise.resolve(null)
      }
      return Promise.resolve({ data: bytes.toString('base64'), nextOffset: null })
    },
  }
  await expect(
    reader.readReviewFile(client, manifest, file, () => true),
  ).resolves.toMatchObject({ kind: 'image' })
  expect(released).toEqual(['image', 'parent'])
  file.sha256 = 'c'.repeat(64)
  await expect(reader.readReviewFile(client, manifest, file, () => true)).rejects.toThrow(
    /image bytes/,
  )
})
