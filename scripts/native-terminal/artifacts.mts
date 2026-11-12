import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const pinPath = resolve(repository, 'scripts/native-terminal/pin.json')
export const pin = JSON.parse(await readFile(pinPath, 'utf8')) as {
  schema: number
  source: {
    commit: string
    tag: string
    url: string
    sha256: string
    applicationVersion: string
    vtVersion: string
    embedAbi: number
  }
  zig: { version: string; archives: Record<string, { url: string; sha256: string }> }
  dependencies: Record<string, string>
  patches: { file: string; sha256: string; purpose: string }[]
  targets: Record<
    string,
    { platform: string; arch: string; triple: string; library: string }
  >
}
export async function digest(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}
export interface NativeArtifact {
  readonly schema: 1
  readonly source: string
  readonly pinSha256: string
  readonly target: string
  readonly applicationVersion: string
  readonly vtVersion: string
  readonly embedAbi: number
  readonly build: Record<string, unknown>
  readonly files: readonly { path: string; sha256: string; bytes: number }[]
}
/** Check identity/integrity for a trusted local build or exact CI artifact producer.
 * A self-reported manifest is not proof of authorship. Application imports are forbidden. */
export async function verifyArtifact(
  directory: string,
  target: string,
  allowDevelopment = false,
): Promise<NativeArtifact> {
  const selected = pin.targets[target]
  if (!selected) throw new Error('native-artifact: unsupported target')
  const root = await realpath(directory)
  const manifestPath = resolve(root, 'manifest.json')
  const info = await lstat(manifestPath)
  if (!info.isFile() || info.size > 1024 * 1024)
    throw new Error('native-artifact: invalid manifest')
  const m = JSON.parse(await readFile(manifestPath, 'utf8')) as NativeArtifact
  if (
    m.schema !== 1 ||
    !/^[a-f0-9]{40}$/.test(m.source) ||
    m.pinSha256 !== (await digest(pinPath)) ||
    m.target !== target ||
    m.applicationVersion !== pin.source.applicationVersion ||
    m.vtVersion !== pin.source.vtVersion ||
    m.embedAbi !== pin.source.embedAbi ||
    !m.build ||
    (m.build.development !== false && !allowDevelopment) ||
    !Array.isArray(m.files) ||
    m.files.length < 3 ||
    m.files.length > 256
  )
    throw new Error('native-artifact: identity mismatch')
  const names = new Set<string>()
  for (const file of m.files as NativeArtifact['files']) {
    if (
      !file ||
      typeof file.path !== 'string' ||
      !file.path ||
      isAbsolute(file.path) ||
      file.path.split(/[\\/]/).some((p) => !p || p === '.' || p === '..') ||
      names.has(file.path) ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 1 ||
      file.bytes > 512 * 1024 * 1024
    )
      throw new Error('native-artifact: invalid file record')
    names.add(file.path)
    const path = resolve(root, file.path),
      actual = await realpath(path)
    if (
      relative(root, actual).startsWith(`..${sep}`) ||
      actual !== path ||
      !(await lstat(path)).isFile()
    )
      throw new Error('native-artifact: escaped file')
    if ((await lstat(path)).size !== file.bytes || (await digest(path)) !== file.sha256)
      throw new Error('native-artifact: corrupt file')
  }
  if (
    ![selected.library, 'loader-probe', 'hvir_ghostty_embed.h', 'ghostty.h'].every((n) =>
      names.has(n),
    )
  )
    throw new Error('native-artifact: missing required file')
  return m
}
