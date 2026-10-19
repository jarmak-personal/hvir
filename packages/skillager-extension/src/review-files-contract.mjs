import { metadataObject as object } from './public-metadata.mjs'
import { digest } from './management-contract.mjs'

/** Shared complete file identities from public capture_review_tree contracts. */
export function exactTreeFiles(manifest) {
  const limits = object(manifest.limits)
  for (const [name, maximum] of Object.entries({
    files: 512,
    file_bytes: 2 * 1024 * 1024,
    tree_bytes: 32 * 1024 * 1024,
    response_bytes: 256 * 1024,
  }))
    if (!Number.isSafeInteger(limits[name]) || limits[name] < 1 || limits[name] > maximum)
      throw new Error(
        'Exact review contract exceeds the supported complete bounds; use public CLI review and Refresh',
      )
  if (
    !Array.isArray(manifest.files) ||
    !manifest.files.length ||
    manifest.files.length > limits.files ||
    manifest.file_count !== manifest.files.length
  )
    throw new Error(
      'The complete eligible tree manifest is unavailable; no omitted-file acceptance is allowed',
    )
  const paths = new Set()
  let bytes = 0
  for (const file of manifest.files) {
    if (
      typeof file.path !== 'string' ||
      !file.path ||
      file.path.startsWith('/') ||
      file.path.includes('\0') ||
      file.path.split('/').some((part) => !part || part === '.' || part === '..') ||
      paths.has(file.path) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > limits.file_bytes ||
      typeof file.executable !== 'boolean'
    )
      throw new Error(
        'The complete manifest contains an unsupported path, size or executable identity',
      )
    digest(file.sha256)
    paths.add(file.path)
    bytes += file.size
  }
  if (
    !paths.has('SKILL.md') ||
    bytes !== manifest.total_bytes ||
    bytes > limits.tree_bytes
  )
    throw new Error(
      'The complete manifest totals or entrypoint disagree; no partial approval is available',
    )
}
