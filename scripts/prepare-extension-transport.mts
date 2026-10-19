import { copyFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const GUEST_TRANSPORT_ASSETS = [
  'guest-client.mjs',
  'connector-output.mjs',
] as const
const source = fileURLToPath(new URL('../src/shared/extensions/', import.meta.url))
/** Public browser transport is captured alongside presentation, under its own owner. */
export async function prepareExtensionTransport(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  for (const asset of GUEST_TRANSPORT_ASSETS)
    await copyFile(join(source, asset), join(directory, asset))
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2]
  if (!directory || process.argv.length !== 3)
    throw new Error('Usage: npm run extension:transport -- /absolute/package-directory')
  await prepareExtensionTransport(resolve(directory))
}
