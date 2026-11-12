import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { digest, pin, repository } from './artifacts.mts'

export const execute = promisify(execFile)
/** Content-addressed inputs fail closed on corruption; an existing bad file is never replaced. */
export async function archive(url: string, sha256: string, path: string): Promise<void> {
  try {
    await access(path)
  } catch {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
    if (!response.ok) throw new Error(`native-download: HTTP ${response.status}`)
    const declared = Number(response.headers.get('content-length'))
    if (declared > 256 * 1024 * 1024)
      throw new Error('native-download: oversized archive')
    const parts: Uint8Array[] = []
    let bytes = 0
    if (!response.body) throw new Error('native-download: missing body')
    for await (const part of response.body) {
      bytes += part.length
      if (bytes > 256 * 1024 * 1024) {
        await response.body.cancel()
        throw new Error('native-download: oversized archive')
      }
      parts.push(part)
    }
    await writeFile(path, Buffer.concat(parts), { flag: 'wx' })
  }
  if ((await digest(path)) !== sha256)
    throw new Error('native-download: checksum mismatch')
}
export async function extract(path: string, directory: string): Promise<void> {
  // Only digest-authenticated official archives reach tar. Reject escaping names as well.
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
  for (const patch of pin.patches) {
    const file = join(repository, 'scripts/native-terminal', patch.file)
    if ((await digest(file)) !== patch.sha256)
      throw new Error('native-source: patch checksum mismatch')
    await execute('patch', ['--batch', '--fuzz=0', '-p1', '--dry-run', '-i', file], {
      cwd: source,
    })
    await execute('patch', ['--batch', '--fuzz=0', '-p1', '-i', file], { cwd: source })
  }
  return source
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
