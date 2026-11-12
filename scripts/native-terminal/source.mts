import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lstat, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { digest, pin, repository } from './artifacts.mts'

export const execute = promisify(execFile)
/** One bounded, write-once download policy; inspection returns an observed digest only. */
export async function downloadArchive(url: string, path: string): Promise<string> {
  if (new URL(url).protocol !== 'https:')
    throw new Error('native-download: HTTPS required')
  const existing = await lstat(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (!existing) {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
    if (!response.ok) throw new Error(`native-download: HTTP ${response.status}`)
    if (response.url && new URL(response.url).protocol !== 'https:')
      throw new Error('native-download: HTTPS required')
    const declared = Number(response.headers.get('content-length'))
    if (declared > 256 * 1024 * 1024)
      throw new Error('native-download: oversized archive')
    const parts: Uint8Array[] = []
    let bytes = 0
    if (!response.body) throw new Error('native-download: missing body')
    for await (const part of response.body) {
      bytes += part.length
      if (bytes > 256 * 1024 * 1024) throw new Error('native-download: oversized archive')
      parts.push(part)
    }
    await writeFile(path, Buffer.concat(parts), { flag: 'wx' })
  } else if (!existing.isFile() || existing.size > 256 * 1024 * 1024)
    throw new Error('native-download: invalid cached archive')
  return digest(path)
}
/** Normal compiler/source preparation always requires the accepted expected digest. */
export async function archive(url: string, sha256: string, path: string): Promise<void> {
  if ((await downloadArchive(url, path)) !== sha256)
    throw new Error('native-download: checksum mismatch')
}
export async function extract(path: string, directory: string): Promise<void> {
  // Builds authenticate official inputs first; upgrade inspection records its observed digest.
  // Both reject escaping archive member names.
  const listing = (await execute('tar', ['-tf', path], { maxBuffer: 8 * 1024 * 1024 }))
    .stdout
  if (
    listing
      .split('\n')
      .filter(Boolean)
      .some((n) => n.startsWith('/') || n.split('/').includes('..'))
  )
    throw new Error('native-source: unsafe archive')
  await mkdir(directory)
  await execute('tar', ['-xf', path, '--strip-components=1', '-C', directory])
}
export async function prepareSource(
  work: string,
  selectedArchive?: string,
): Promise<string> {
  const input = selectedArchive ?? join(work, 'source.tar.gz')
  if (!selectedArchive) await archive(pin.source.url, pin.source.sha256, input)
  if ((await digest(input)) !== pin.source.sha256)
    throw new Error('native-source: checksum mismatch')
  const source = join(work, 'source')
  await extract(input, source)
  for (const [name, expected] of Object.entries(pin.dependencies))
    if ((await digest(join(source, 'deps', name))) !== expected)
      throw new Error('native-source: dependency inventory mismatch')
  await patchSource(source)
  return source
}
export interface NativePatchResult {
  readonly file: string
  readonly result: 'applied' | 'failed' | 'blocked'
}
/** Inspect ordered patches on an owned trial copy; builds fail on the first refusal. */
export async function patchSource(
  source: string,
  inspect = false,
): Promise<NativePatchResult[]> {
  const results: NativePatchResult[] = []
  let failed = false
  for (const patch of pin.patches) {
    if (failed) {
      results.push({ file: patch.file, result: 'blocked' })
      continue
    }
    const file = join(repository, 'scripts/native-terminal', patch.file)
    if ((await digest(file)) !== patch.sha256)
      throw new Error('native-source: patch checksum mismatch')
    try {
      await execute(
        'patch',
        ['--batch', '--forward', '--fuzz=0', '-p1', '--dry-run', '-i', file],
        {
          cwd: source,
        },
      )
      await execute('patch', ['--batch', '--forward', '--fuzz=0', '-p1', '-i', file], {
        cwd: source,
      })
      results.push({ file: patch.file, result: 'applied' })
    } catch (error) {
      if (!inspect) throw error
      failed = true
      results.push({ file: patch.file, result: 'failed' })
    }
  }
  return results
}
export async function prepareZig(work: string): Promise<string> {
  const host = `${process.platform}-${process.arch}`,
    entry = pin.zig.archives[host]
  if (!entry) throw new Error('native-toolchain: unsupported build host')
  const file = join(work, 'zig.tar.xz'),
    directory = join(work, 'zig')
  await archive(entry.url, entry.sha256, file)
  await extract(file, directory)
  return join(directory, 'zig')
}
