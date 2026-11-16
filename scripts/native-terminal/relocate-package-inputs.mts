import { lstat, mkdir, realpath, rename } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// Acceptance retains shared contracts and its Node/shell tools. The installed app
// must launch with every original application/native implementation path absent.
const roots = [
  'out/main',
  'out/preload',
  'out/renderer',
  'out/native-download',
  'out/native-sdk',
  'out/native-terminal',
  'dist/linux-unpacked',
  'dist/linux-arm64-unpacked',
  'src/main',
  'src/preload',
  'src/renderer',
  'src/workers',
  'src/agent-cli',
  'src/agent-transport',
  'packages/native-terminal',
] as const
export async function relocateNativePackageInputs(repository: string, requested: string) {
  if (!isAbsolute(repository) || !isAbsolute(requested))
    throw new Error('Native package input relocation requires absolute paths')
  const root = await realpath(repository)
  const destination = resolve(requested)
  const inside = relative(root, destination)
  if (
    !inside ||
    (!inside.startsWith(`..${sep}`) && inside !== '..' && !isAbsolute(inside))
  )
    throw new Error('Native package input destination must be outside the checkout')
  await mkdir(destination)
  const canonical = await realpath(destination)
  const canonicalInside = relative(root, canonical)
  if (
    !canonicalInside ||
    (!canonicalInside.startsWith(`..${sep}`) &&
      canonicalInside !== '..' &&
      !isAbsolute(canonicalInside))
  )
    throw new Error('Native package input destination must be outside the checkout')
  const records: { path: string; disposition: 'moved' | 'absent' }[] = []
  for (const path of roots) {
    const source = resolve(root, path)
    try {
      await lstat(source)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      records.push({ path, disposition: 'absent' })
      continue
    }
    const target = resolve(canonical, path)
    await mkdir(dirname(target), { recursive: true })
    await rename(source, target)
    records.push({ path, disposition: 'moved' })
  }
  for (const path of roots) {
    try {
      await lstat(resolve(root, path))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    throw new Error('Native package developer input remains at its original path')
  }
  return {
    nativeDeveloperInputs: 'unavailable-at-original-paths',
    retained: 'shared-contract-and-acceptance-tool-support',
    roots: records,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [requested, ...rest] = process.argv.slice(2)
  if (!requested || rest.length || !isAbsolute(requested))
    throw new Error('Usage: relocate-package-inputs.mts ABSOLUTE_NEW_DESTINATION')
  if (
    process.env.CI !== 'true' ||
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.HVIR_NATIVE_PACKAGE_ACCEPTANCE !== '1'
  )
    throw new Error(
      'Native package input relocation requires explicit ephemeral acceptance',
    )
  console.log(JSON.stringify(await relocateNativePackageInputs(process.cwd(), requested)))
}
