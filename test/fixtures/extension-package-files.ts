import { readFileSync } from 'node:fs'
import { validateExtensionManifest } from '../../src/shared/extensions/manifest'

/** Read the maintained example declarations at the filesystem fixture boundary. */
export function readExtensionPackageManifest(path: string) {
  return validateExtensionManifest(JSON.parse(readFileSync(path, 'utf8')) as unknown)
    .manifest
}
