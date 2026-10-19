import { metadataObject as object } from './public-metadata.mjs'
import {
  boundedManagementJson,
  absoluteLocalPath,
  digest,
} from './management-contract.mjs'
import { exactTreeFiles } from './review-files-contract.mjs'
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
  exactTreeFiles(manifest)
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
