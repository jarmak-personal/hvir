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
