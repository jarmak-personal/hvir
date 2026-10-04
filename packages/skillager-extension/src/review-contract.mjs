import { metadataObject as object } from './public-metadata.mjs'
import {
  boundedManagementJson,
  absoluteLocalPath,
  digest,
} from './management-contract.mjs'
import { acceptanceArgs } from './management-argv.mjs'

export function exactReviewManifest(value, binding) {
  boundedManagementJson(value)
  if (
    value.schema !== 'skillager.library-accept.v1' ||
    value.status !== 'preview' ||
    value.review_manifest?.schema !== 'skillager.library-review-manifest.v1'
  )
    throw new Error(
      'The installed CLI lacks the complete exact-tree review manifest contract. Install supported Skillager source or use ordinary file tools and public CLI review/accept, then Refresh. Version alone is insufficient.',
    )
  const manifest = object(value.review_manifest)
  if (
    manifest.library_id !== binding.library.id ||
    manifest.library_root !== binding.library.root.path ||
    manifest.skill_id !== binding.skillId ||
    value.skill?.id !== binding.skillId ||
    manifest.skill_root !== value.skill.path ||
    (binding.root && manifest.skill_root !== binding.root.path) ||
    manifest.working_hash !== value.skill.working_hash ||
    (binding.hash && manifest.working_hash !== binding.hash)
  )
    throw new Error(
      'Exact review library/source identity or current version changed. Start a fresh complete review.',
    )
  absoluteLocalPath(manifest.skill_root)
  digest(manifest.working_hash)
  digest(manifest.confirmation_token)
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
  const next = value.next_command_argv,
    expected = [
      'skillager',
      ...acceptanceArgs(binding.skillId, manifest.confirmation_token),
    ]
  const eligible =
    value.requires_override === false &&
    Array.isArray(next) &&
    next.length === expected.length &&
    next.every((argument, index) => argument === expected[index])
  return {
    manifest,
    eligible,
    gate: eligible
      ? undefined
      : 'Skillager offers no ordinary acceptance command for this exact tree. Inspect scan/lint/Git gates and use its audited public CLI review/repair route, then Refresh.',
  }
}
export function sameReviewedManifest(reviewed, fresh) {
  if (JSON.stringify(reviewed) !== JSON.stringify(fresh))
    throw new Error(
      'The complete reviewed manifest/token changed after reading. Start a fresh review; no acceptance was applied.',
    )
}
