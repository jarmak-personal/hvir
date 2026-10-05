import { build } from 'esbuild'
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { prepareExtensionUi } from './prepare-extension-ui.mts'
import { extensionPackageArchive } from './extension-package-archive.mts'
import { EXTENSION_CONTRACT } from '../src/shared/extensions/contract.ts'
/** Reproducible ordinary package assets; neither installed automatically nor imported by core. */
const sourceDirectory = fileURLToPath(
  new URL('../packages/skillager-extension', import.meta.url),
)
const staticAssets = [
  'hvir-extension.json',
  'README.md',
  'skillager.css',
  'library.html',
  'project.html',
  'detail.html',
  'management.html',
  'skillager.svg',
]
export async function prepareSkillagerExtension(
  directory = sourceDirectory,
): Promise<void> {
  await mkdir(directory, { recursive: true })
  if (resolve(directory) !== resolve(sourceDirectory))
    for (const name of staticAssets)
      await copyFile(join(sourceDirectory, name), join(directory, name))
  await prepareExtensionUi(directory)
  for (const [source, output] of [
    ['app', 'skillager'],
    ['operations', 'operations'],
  ]) {
    const result = await build({
      entryPoints: [join(sourceDirectory, 'src', `${source}.mjs`)],
      bundle: true,
      platform: 'browser',
      format: 'iife',
      write: false,
      minify: true,
      legalComments: 'none',
      charset: 'utf8',
    })
    await writeFile(join(directory, `${output}.js`), result.outputFiles[0]!.text)
  }
}
export async function buildSkillagerExtensionArchive(output: string): Promise<{
  id: string
  version: string
  contract: string
}> {
  const stage = await mkdtemp(join(tmpdir(), 'hvir-skillager-package-'))
  try {
    await prepareSkillagerExtension(stage)
    const files = new Map<string, Uint8Array>()
    for (const name of (await readdir(stage)).sort())
      files.set(name, await readFile(join(stage, name)))
    const manifest = JSON.parse(
      Buffer.from(files.get('hvir-extension.json')!).toString('utf8'),
    ) as {
      id?: string
      version?: string
      contract?: string
    }
    // Distribution identity, not a second package validator; ordinary capture owns admission.
    if (
      manifest.id !== 'skillager' ||
      !/^\d+\.\d+\.\d+$/.test(manifest.version ?? '') ||
      manifest.contract !== EXTENSION_CONTRACT
    )
      throw new Error('Skillager release identity is invalid')
    await writeFile(output, await extensionPackageArchive(files))
    return { id: manifest.id, version: manifest.version!, contract: manifest.contract }
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (!args.length) await prepareSkillagerExtension()
  else if (args.length === 2 && args[0] === '--zip' && isAbsolute(args[1]!))
    await buildSkillagerExtensionArchive(args[1]!)
  else
    throw new Error('Usage: npm run extension:skillager -- [--zip /absolute/package.zip]')
}
