/** Packaged native code has a fixed layout; manifest data never selects a path. */
export const NATIVE_TERMINAL_PACKAGE_ABI = 11
export const NATIVE_TERMINAL_PACKAGE_VERSION = '1.4.1-dev'
export const NATIVE_TERMINAL_PACKAGE_VT_VERSION = '1.0.1'
export const NATIVE_TERMINAL_BINDING_FILES = {
  engine: 'native_terminal_engine.node',
  resource: 'native_terminal_resource.node',
} as const
export interface NativeTerminalPackageFile {
  readonly sha256: string
  readonly buildSha256: string
  readonly bytes: number
}
export interface NativeTerminalPackageManifest {
  readonly schema: 1
  readonly source: string
  readonly target: string
  readonly embedAbi: number
  readonly applicationVersion: string
  readonly vtVersion: string
  readonly signed: boolean
  readonly provenance: {
    readonly sdkManifestSha256: string
    readonly bindingManifestSha256: string
    readonly pinSha256: string
  }
  readonly files: Readonly<
    Record<'library' | 'engine' | 'resource', NativeTerminalPackageFile>
  >
}
export function nativeTerminalPackageLibrary(target: string): string {
  if (target === 'macos-arm64') return 'libghostty.dylib'
  if (target === 'linux-x64' || target === 'linux-arm64') return 'ghostty-internal.so'
  throw new Error('native-package-target')
}
export function validNativeTerminalPackageManifest(
  value: unknown,
  target: string,
): value is NativeTerminalPackageManifest {
  if (!value || typeof value !== 'object') return false
  const m = value as NativeTerminalPackageManifest
  const hash = (v: unknown): boolean => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
  return (
    m.schema === 1 &&
    typeof m.source === 'string' &&
    /^[a-f0-9]{40}$/.test(m.source) &&
    m.target === target &&
    ['macos-arm64', 'linux-x64', 'linux-arm64'].includes(target) &&
    m.embedAbi === NATIVE_TERMINAL_PACKAGE_ABI &&
    m.applicationVersion === NATIVE_TERMINAL_PACKAGE_VERSION &&
    m.vtVersion === NATIVE_TERMINAL_PACKAGE_VT_VERSION &&
    typeof m.signed === 'boolean' &&
    (target === 'macos-arm64' || !m.signed) &&
    !!m.provenance &&
    hash(m.provenance.sdkManifestSha256) &&
    hash(m.provenance.bindingManifestSha256) &&
    hash(m.provenance.pinSha256) &&
    !!m.files &&
    Object.keys(m.files).sort().join(',') === 'engine,library,resource' &&
    Object.values(m.files).every(
      (f) =>
        !!f &&
        hash(f.sha256) &&
        hash(f.buildSha256) &&
        Number.isSafeInteger(f.bytes) &&
        f.bytes > 0 &&
        f.bytes <= 128 * 1024 * 1024 &&
        (m.signed || f.sha256 === f.buildSha256),
    )
  )
}
