import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { archive, downloadArchive } from '../scripts/native-terminal/source.mts'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hvir-native-download-test-'))
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(root, { recursive: true, force: true })
})
const url = 'https://example.invalid/source.tar.gz'
const bytes = 'selected immutable input'
const expected = createHash('sha256').update(bytes).digest('hex')
describe('native input download policy', () => {
  it('returns the observed digest for inspection and reuses bytes for pinned verification', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(bytes))
    vi.stubGlobal('fetch', fetch)
    const file = join(root, 'source.tar.gz')
    expect(await downloadArchive(url, file)).toBe(expected)
    await archive(url, expected, file)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('never overwrites a corrupt cached input to manufacture a matching pin', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const file = join(root, 'source.tar.gz')
    await writeFile(file, 'different bytes')
    await expect(archive(url, expected, file)).rejects.toThrow(
      'native-download: checksum mismatch',
    )
    expect(await readFile(file, 'utf8')).toBe('different bytes')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('bounds declared downloads before reading their body', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('x', {
            headers: { 'content-length': String(256 * 1024 * 1024 + 1) },
          }),
        ),
    )
    await expect(downloadArchive(url, join(root, 'source.tar.gz'))).rejects.toThrow(
      'native-download: oversized archive',
    )
  })
  it('refuses an insecure download URL', async () => {
    await expect(
      downloadArchive('http://example.invalid/input', join(root, 'source.tar.gz')),
    ).rejects.toThrow('native-download: HTTPS required')
  })
})
