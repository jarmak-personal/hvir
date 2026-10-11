import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateCapturedExtension } from '../../src/main/extensions/package-store'

/** Immutable release inputs, independent of the maintained template rebuild. */
export function releasedExtension(name: 'reference' | 'clock') {
  const root = 'test/fixtures/extensions/0.3.0'
  const inventory = JSON.parse(readFileSync(join(root, 'inventory.json'), 'utf8')) as {
    files: Record<string, unknown>
  }
  const files = new Map(
    Object.keys(inventory.files)
      .filter((path) => path.startsWith(`${name}/`))
      .map((path) => [path.slice(name.length + 1), readFileSync(join(root, path))]),
  )
  return validateCapturedExtension({ sourceIdentity: `released-0.3.0-${name}`, files })
}
