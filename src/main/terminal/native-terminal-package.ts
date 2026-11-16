import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  NATIVE_TERMINAL_BINDING_FILES,
  nativeTerminalPackageLibrary,
  validNativeTerminalPackageManifest,
} from '../../shared/native-terminal-package'

/** Candidate selection cannot turn an installed app into a development-code loader. */
export async function nativeTerminalLibraryForStartup(
  packaged: boolean,
): Promise<string | undefined> {
  if (!packaged) return process.env['HVIR_NATIVE_TERMINAL_LIBRARY']
  if (process.env['HVIR_NATIVE_TERMINAL'] !== '1') return
  return verifyPackagedNativeTerminal(
    process.resourcesPath,
    process.platform,
    process.arch,
  )
}

/** This is application installation data, never a project or renderer-supplied path. */
export async function verifyPackagedNativeTerminal(
  resources: string,
  platform: string,
  arch: string,
): Promise<string> {
  const target = `${platform === 'darwin' ? 'macos' : platform}-${arch}`
  const libraryName = nativeTerminalPackageLibrary(target)
  const root = resolve(resources, 'native-terminal')
  const bindings = join(
    resources,
    'app.asar.unpacked/node_modules/@hvir/native-terminal/build/Release',
  )
  try {
    if ((await realpath(root)) !== root) throw new Error('native-package-path')
    const path = join(root, 'runtime.json')
    const stat = await lstat(path)
    if (!stat.isFile() || stat.size > 16 * 1024)
      throw new Error('native-package-manifest')
    const manifest: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!validNativeTerminalPackageManifest(manifest, target))
      throw new Error('native-package-identity')
    for (const [kind, file] of Object.entries(manifest.files)) {
      const path =
        kind === 'library'
          ? join(root, libraryName)
          : join(bindings, NATIVE_TERMINAL_BINDING_FILES[kind as 'engine' | 'resource'])
      const stat = await lstat(path)
      if (!stat.isFile() || stat.size !== file.bytes || (await realpath(path)) !== path)
        throw new Error('native-package-file')
      // Bounded async chunks avoid a whole-library read/hash on the paint-critical loop.
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 }))
        hash.update(chunk as Buffer)
      if (hash.digest('hex') !== file.sha256) throw new Error('native-package-integrity')
    }
    return join(root, libraryName)
  } catch (cause) {
    if (cause instanceof Error && /^native-package-/.test(cause.message)) throw cause
    throw new Error('native-package-unavailable', { cause })
  }
}
