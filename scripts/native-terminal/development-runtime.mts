import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { digest, pin, verifyArtifact } from './artifacts.mts'

export const developmentRoot = 'packages/native-terminal/build/development'
export const developmentReceipt = `${developmentRoot}/runtime.json`
const repair = 'Run npm ci (or npm run native:prepare), then retry npm run dev.'

export function developmentTarget(
  platform = process.platform,
  arch = process.arch,
): string {
  const target = `${platform === 'darwin' ? 'macos' : platform}-${arch}`
  if (!pin.targets[target])
    throw new Error(
      `native-development: unsupported target ${target}. Use npm run dev:legacy for the web engine.`,
    )
  return target
}

/** Content identity permits reuse across unrelated commits without relabeling producers. */
export async function developmentInputIdentity(
  root: string,
  target: string,
): Promise<string> {
  const hash = createHash('sha256').update(`native-development-v2:${target}\n`)
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(join(root, directory), { withFileTypes: true })
    for (const entry of entries.sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const path = `${directory}/${entry.name}`
      if (
        path === 'packages/native-terminal/build' ||
        [
          'dev.mts',
          'development-runtime.mts',
          'development-process.mts',
          'prepare-development.mts',
          'qualify-development.mts',
          'upgrade.mts',
        ].some((name) => path === `scripts/native-terminal/${name}`)
      )
        continue
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) hash.update(`${path}\0${await digest(join(root, path))}\n`)
      else throw new Error(`native-development: unsupported source entry ${path}`)
    }
  }
  await visit('scripts/native-terminal')
  await visit('packages/native-terminal')
  const electron = JSON.parse(
    await readFile(join(root, 'node_modules/electron/package.json'), 'utf8'),
  ) as { version: string }
  const bindings = JSON.parse(
    await readFile(join(root, 'scripts/native-terminal/bindings-pin.json'), 'utf8'),
  ) as { electron: { version: string } }
  if (electron.version !== bindings.electron.version)
    throw new Error(
      'native-development: installed Electron differs from the native bindings pin. Update the pin and rebuild together.',
    )
  hash.update(`electron:${electron.version}\n`)
  return hash.digest('hex')
}

export interface DevelopmentRuntimeReceipt {
  schema: 1
  target: string
  inputSha256: string
  artifact: string
  manifestSha256: string
  bindingsSha256: string
}

async function regularFile(root: string, path: string): Promise<string> {
  const absolute = resolve(root, path)
  if (
    !relative(root, absolute) ||
    relative(root, absolute).split(sep).includes('..') ||
    !(await lstat(absolute)).isFile() ||
    (await realpath(absolute)) !== absolute
  )
    throw new Error('native-development: invalid prepared file')
  return absolute
}

/** Filesystem preflight only: no native loading, compilation, download, or GPU work. */
export async function readDevelopmentRuntime(
  root: string,
  target = developmentTarget(),
  verifySdk: typeof verifyArtifact = verifyArtifact,
  selectedReceipt = developmentReceipt,
): Promise<{ library: string; receipt: DevelopmentRuntimeReceipt }> {
  try {
    root = await realpath(root)
    const receiptPath = await regularFile(root, selectedReceipt)
    if ((await lstat(receiptPath)).size > 16 * 1024) throw new Error('oversized receipt')
    const receipt = JSON.parse(
      await readFile(receiptPath, 'utf8'),
    ) as DevelopmentRuntimeReceipt
    if (
      receipt.schema !== 1 ||
      receipt.target !== target ||
      receipt.inputSha256 !== (await developmentInputIdentity(root, target)) ||
      typeof receipt.artifact !== 'string' ||
      !receipt.artifact.startsWith(`${developmentRoot}/attempt-`) ||
      !receipt.artifact.endsWith('/artifact')
    )
      throw new Error('source or target changed')
    const sdkDirectory = resolve(root, receipt.artifact)
    const manifestPath = await regularFile(root, `${receipt.artifact}/manifest.json`)
    if ((await digest(manifestPath)) !== receipt.manifestSha256)
      throw new Error('SDK receipt changed')
    const sdk = await verifySdk(sdkDirectory, target, true)
    const bindingPath = await regularFile(
      root,
      'packages/native-terminal/build/Release/bindings.json',
    )
    if ((await digest(bindingPath)) !== receipt.bindingsSha256)
      throw new Error('bindings receipt changed')
    const binding = JSON.parse(await readFile(bindingPath, 'utf8')) as {
      schema: number
      target: string
      source: string
      development: boolean
      producer: {
        source: string
        target: string
        pinSha256: string
        embedAbi: number
        manifestSha256: string
      }
      outputs: { file: string; bytes: number; sha256: string }[]
    }
    if (
      binding.schema !== 1 ||
      binding.target !== target ||
      typeof binding.development !== 'boolean' ||
      !/^[a-f0-9]{40}$/.test(binding.source) ||
      binding.producer.source !== sdk.source ||
      binding.producer.target !== target ||
      binding.producer.embedAbi !== pin.source.embedAbi ||
      binding.producer.pinSha256 !== sdk.pinSha256 ||
      binding.producer.manifestSha256 !== receipt.manifestSha256
    )
      throw new Error('bindings producer mismatch')
    for (const file of [
      'native_terminal_engine.node',
      'native_terminal_resource.node',
      'resource-probe',
    ]) {
      const output = binding.outputs.find((entry) => entry.file === file)
      const path = await regularFile(
        root,
        `packages/native-terminal/build/Release/${file}`,
      )
      if (
        !output ||
        (await lstat(path)).size !== output.bytes ||
        (await digest(path)) !== output.sha256
      )
        throw new Error('corrupt bindings')
    }
    // npm's local-file dependency must resolve to this checkout's prepared package.
    if (
      (await realpath(join(root, 'node_modules/@hvir/native-terminal'))) !==
      (await realpath(join(root, 'packages/native-terminal')))
    )
      throw new Error('foreign installed native package')
    return {
      library: await regularFile(
        root,
        `${receipt.artifact}/${pin.targets[target]!.library}`,
      ),
      receipt,
    }
  } catch (cause) {
    throw new Error(
      `native-development: missing, stale, or incompatible prepared runtime. ${repair}`,
      { cause },
    )
  }
}
