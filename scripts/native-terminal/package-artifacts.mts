import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  NATIVE_TERMINAL_BINDING_FILES,
  nativeTerminalPackageLibrary,
  validNativeTerminalPackageManifest,
  type NativeTerminalPackageManifest,
} from '../../src/shared/native-terminal-package.ts'

export async function packageDigest(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}
export async function readPackageJson(path: string): Promise<unknown> {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.size > 1024 * 1024)
    throw new Error('native-package: invalid provenance file')
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}
interface SdkManifest {
  schema: number
  source: string
  target: string
  pinSha256: string
  embedAbi: number
  applicationVersion: string
  vtVersion: string
  build: { development: boolean; dependencyIsolation?: { policy?: string } }
  files: { path: string; sha256: string; bytes: number }[]
}
export interface BindingManifest {
  schema: number
  source: string
  target: string
  development: boolean
  producer: {
    source: string
    target: string
    pinSha256: string
    embedAbi: number
    manifestSha256: string
  }
  outputs: { file: string; sha256: string; bytes: number }[]
}
/** Build receipts stay byte-identical. Only this separate manifest follows signing. */
export async function nativeTerminalPackageManifest(
  root: string,
  bindings: string,
  source: string,
  target: string,
  signed = false,
): Promise<NativeTerminalPackageManifest> {
  const sdk = (await readPackageJson(join(root, 'sdk-manifest.json'))) as SdkManifest
  const binding = (await readPackageJson(join(root, 'bindings.json'))) as BindingManifest
  const sdkHash = await packageDigest(join(root, 'sdk-manifest.json'))
  if (
    sdk.schema !== 1 ||
    sdk.source !== source ||
    sdk.target !== target ||
    sdk.build?.development !== false ||
    binding.schema !== 1 ||
    binding.source !== source ||
    binding.target !== target ||
    binding.development !== false ||
    binding.producer?.source !== source ||
    binding.producer.target !== target ||
    binding.producer.manifestSha256 !== sdkHash ||
    binding.producer.pinSha256 !== sdk.pinSha256 ||
    binding.producer.embedAbi !== sdk.embedAbi ||
    (target.startsWith('linux-') &&
      sdk.build.dependencyIsolation?.policy !== 'linux-local-bundled-definitions') ||
    !Array.isArray(sdk.files) ||
    !sdk.files.some((file) => file.path?.startsWith('notices/')) ||
    !Array.isArray(binding.outputs)
  )
    throw new Error('native-package: build provenance mismatch')
  const files = {} as Record<
    'library' | 'engine' | 'resource',
    { sha256: string; buildSha256: string; bytes: number }
  >
  for (const kind of ['library', 'engine', 'resource'] as const) {
    const name =
      kind === 'library'
        ? nativeTerminalPackageLibrary(target)
        : NATIVE_TERMINAL_BINDING_FILES[kind]
    const built =
      kind === 'library'
        ? sdk.files.find((file) => file.path === name)
        : binding.outputs.find((file) => file.file === name)
    const path = resolve(kind === 'library' ? root : bindings, name)
    const stat = await lstat(path)
    const sha256 = await packageDigest(path)
    if (
      !built ||
      !stat.isFile() ||
      (await realpath(path)) !== path ||
      (!signed && (sha256 !== built.sha256 || stat.size !== built.bytes))
    )
      throw new Error('native-package: native build bytes mismatch')
    files[kind] = { sha256, buildSha256: built.sha256, bytes: stat.size }
  }
  const manifest = {
    schema: 1 as const,
    source,
    target,
    embedAbi: sdk.embedAbi,
    applicationVersion: sdk.applicationVersion,
    vtVersion: sdk.vtVersion,
    signed,
    provenance: {
      sdkManifestSha256: sdkHash,
      bindingManifestSha256: await packageDigest(join(root, 'bindings.json')),
      pinSha256: sdk.pinSha256,
    },
    files,
  }
  if (!validNativeTerminalPackageManifest(manifest, target))
    throw new Error('native-package: runtime identity mismatch')
  for (const file of sdk.files.filter((file) => file.path.startsWith('notices/'))) {
    if (file.path.split('/').some((part) => !part || part === '.' || part === '..'))
      throw new Error('native-package: notice path')
    const path = resolve(root, file.path)
    const stat = await lstat(path)
    if (
      !stat.isFile() ||
      (await realpath(path)) !== path ||
      stat.size !== file.bytes ||
      (await packageDigest(path)) !== file.sha256
    )
      throw new Error('native-package: notice integrity')
  }
  return manifest
}
export async function captureNativeTerminalPackage(
  root: string,
  bindings: string,
  source: string,
  target: string,
  signed = false,
) {
  const manifest = await nativeTerminalPackageManifest(
    root,
    bindings,
    source,
    target,
    signed,
  )
  await writeFile(join(root, 'runtime.json'), JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}
export async function inspectNativeTerminalPackage(
  root: string,
  bindings: string,
  target: string,
) {
  const recorded = await readPackageJson(join(root, 'runtime.json'))
  if (!validNativeTerminalPackageManifest(recorded, target))
    throw new Error('native-package: invalid runtime manifest')
  const actual = await nativeTerminalPackageManifest(
    root,
    bindings,
    recorded.source,
    target,
    recorded.signed,
  )
  if (!isDeepStrictEqual(recorded, actual))
    throw new Error('native-package: final bytes mismatch')
  return actual
}
