import { execute } from './source.mts'

/** Loader dependencies are system-owned or relocatable; build-directory dependencies fail. */
export async function inspectBinary(
  library: string,
  platform: string,
  arch: string,
): Promise<string> {
  const format = (await execute('file', ['-b', library])).stdout
  if (!(arch === 'arm64' ? /arm64|aarch64/i : /x86-64|x86_64/i).test(format))
    throw new Error('native-binary: CPU mismatch')
  if (platform === 'darwin') {
    const dependencies = (await execute('otool', ['-L', library])).stdout
      .split('\n')
      .slice(1)
      .filter(Boolean)
    if (
      dependencies.some(
        (line) =>
          !/^\s*(@rpath\/libghostty\.dylib|\/(System\/Library|usr\/lib)\/)/.test(line),
      )
    )
      throw new Error('native-binary: non-system dependency')
    const loadCommands = (await execute('otool', ['-l', library])).stdout
    if (/LC_RPATH/.test(loadCommands))
      throw new Error('native-binary: unexpected search path')
    return dependencies.map((line) => line.trim()).join('\n')
  }
  const dynamic = (await execute('readelf', ['-d', library])).stdout
  if (/\((RPATH|RUNPATH)\)/.test(dynamic))
    throw new Error('native-binary: unexpected search path')
  const versions = (await execute('readelf', ['--version-info', library])).stdout
  for (const match of versions.matchAll(/GLIBC_(\d+)\.(\d+)/g))
    if (Number(match[1]) > 2 || (Number(match[1]) === 2 && Number(match[2]) > 35))
      throw new Error('native-binary: glibc floor exceeded')
  for (const match of versions.matchAll(/GLIBCXX_(\d+)\.(\d+)\.(\d+)/g))
    if (Number(match[1]) > 3 || Number(match[2]) > 4 || Number(match[3]) > 30)
      throw new Error('native-binary: libstdc++ floor exceeded')
  return dynamic
    .split('\n')
    .filter((line) => /NEEDED/.test(line))
    .join('\n')
}

/** ELF definitions outside the embedding API must bind inside this library.
 * A NEEDED inventory alone cannot prove that Electron does not preempt bundled code. */
export function linuxDependencyIsolation(symbols: string, relocations: string) {
  const exports: string[] = [],
    imports: string[] = []
  const bundled =
    /^(?:Fc[A-Z]|FT_|hb_|png_|xml|html|onig|deflate|inflate|crc32|adler32|zlib|gz|compress|uncompress)/
  for (const line of symbols.split('\n')) {
    const match = /^\s*\d+:\s+\S+\s+\d+\s+\S+\s+(\S+)\s+\S+\s+(\S+)\s+(\S+)/.exec(line)
    if (!match || match[1] === 'LOCAL') continue
    const name = match[3]!.split('@')[0]!
    if (match[2] === 'UND') {
      if (bundled.test(name))
        throw new Error('native-binary: preemptible bundled dependency import')
      imports.push(name)
    } else {
      if (!/^ghostty_/.test(name) && name !== 'hvir_ghostty_embed_abi')
        throw new Error('native-binary: unexpected dynamic export')
      exports.push(name)
    }
  }
  for (const name of [
    'ghostty_init',
    'ghostty_info',
    'ghostty_external_surface_new',
    'hvir_ghostty_embed_abi',
  ])
    if (!exports.includes(name))
      throw new Error('native-binary: missing embedding export')
  for (const line of relocations.split('\n')) {
    if (!/\bR_/.test(line)) continue
    if (line.split(/\s+/).some((field) => bundled.test(field.split('@')[0]!)))
      throw new Error('native-binary: preemptible bundled dependency relocation')
  }
  return {
    policy: 'linux-local-bundled-definitions' as const,
    exports: [...new Set(exports)].sort(),
    imports: [...new Set(imports)].sort(),
    bundledDependencies: [
      'fontconfig',
      'harfbuzz',
      'freetype',
      'libpng',
      'zlib',
      'oniguruma',
      'libxml2',
    ],
  }
}

/** Inspect only the full Ghostty ELF library, never Node-API addons or probes. */
export async function inspectLinuxDependencyIsolation(library: string) {
  const symbols = (
    await execute('readelf', ['--dyn-syms', '--wide', library], {
      maxBuffer: 1024 * 1024,
    })
  ).stdout
  const relocations = (
    await execute('readelf', ['--relocs', '--wide', library], {
      maxBuffer: 4 * 1024 * 1024,
    })
  ).stdout
  return linuxDependencyIsolation(symbols, relocations)
}
