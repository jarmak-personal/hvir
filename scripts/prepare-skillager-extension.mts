import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { prepareExtensionUi } from './prepare-extension-ui.mts'
/** Reproducible ordinary package assets; neither installed automatically nor imported by core. */
const directory = resolve('packages/skillager-extension')
await prepareExtensionUi(directory)
for (const [source, output] of [
  ['app', 'skillager'],
  ['updater', 'updater'],
  ['operations', 'operations'],
]) {
  const result = await build({
    entryPoints: [`${directory}/src/${source}.mjs`],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    write: false,
    minify: true,
    legalComments: 'none',
    charset: 'utf8',
  })
  await writeFile(`${directory}/${output}.js`, result.outputFiles[0]!.text)
}
