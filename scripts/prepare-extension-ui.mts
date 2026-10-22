import { format, resolveConfig } from 'prettier'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PRESENTATION_COLORS } from '../src/shared/presentation/tokens.ts'
import {
  SYSTEM_INTERFACE_FONT_STACK,
  SYSTEM_MONOSPACE_FONT_STACK,
} from '../src/shared/interface-typography.ts'

export const PRESENTATION_ASSETS = [
  'tokens.css',
  'primitives.css',
  'presentation.css',
  'guest-ui.js',
] as const
export async function presentationTokenCss(): Promise<string> {
  const fonts = `  --hvir-interface-font: ${SYSTEM_INTERFACE_FONT_STACK};\n  --hvir-monospace-font: ${SYSTEM_MONOSPACE_FONT_STACK};\n  --hvir-interface-scale: 1;\n`
  const css = Object.entries(PRESENTATION_COLORS)
    .map(
      ([theme, colors]) =>
        `${theme === 'dark' ? ':root' : ":root[data-theme='light']"} {\n${theme === 'dark' ? fonts : ''}${Object.entries(
          colors,
        )
          .map(([name, color]) => `  ${name}: ${color};\n`)
          .join('')}}\n`,
    )
    .join('\n')
  return format(css, {
    ...(await resolveConfig(fileURLToPath(import.meta.url))),
    parser: 'css',
  })
}
const source = fileURLToPath(new URL('../src/shared/presentation/', import.meta.url))
export async function regeneratePresentationTokens(): Promise<void> {
  await writeFile(join(source, 'tokens.css'), await presentationTokenCss())
}
export async function prepareExtensionUi(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  for (const asset of PRESENTATION_ASSETS)
    await copyFile(join(source, asset), join(directory, asset))
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2]
  if (!directory || process.argv.length !== 3)
    throw new Error('Usage: npm run extension:ui -- /absolute/package-directory')
  if (directory === '--tokens') await regeneratePresentationTokens()
  else await prepareExtensionUi(resolve(directory))
}
