import {
  boundedManagementJson,
  absoluteLocalPath,
  digest,
} from './management-contract.mjs'
import { exactTreeFiles } from './review-files-contract.mjs'
import { metadataEncoding } from './management-sync-review.mjs'

export function importArgs(selection, confirmation) {
  if (
    typeof selection.skillId !== 'string' ||
    selection.skillId.startsWith('lib/') ||
    !/^[\w.-]+(?:\/[\w.-]+)+$/u.test(selection.skillId) ||
    selection.file?.hostId !== 'local'
  )
    throw new Error('Select one exact local external skill occurrence')
  const file = absoluteLocalPath(selection.file.path).path
  if (!file.endsWith('/SKILL.md'))
    throw new Error('Select the original canonical SKILL.md')
  if (selection.name !== undefined && !/^[\w.-]+$/u.test(selection.name))
    throw new Error('Choose one exact collision-free library name')
  return [
    'import',
    selection.skillId,
    ...(selection.name ? ['--as', selection.name] : []),
    '--source-file',
    file,
    '--review-manifest',
    '--json',
    ...(confirmation ? ['--yes', '--confirmation-token', digest(confirmation)] : []),
  ]
}
/** External import is its own public contract, not a library acceptance preview. */
export function exactImportManifest(value, selection, workspace) {
  boundedManagementJson(value)
  importArgs(selection)
  if (
    workspace?.host !== 'local' ||
    workspace.root?.hostId !== 'local' ||
    !selection.file.path.startsWith(`${workspace.root.path.replace(/\/+$/u, '')}/`)
  )
    throw new Error(
      'Select the original in its exact local project before Save and accept',
    )
  const manifest = value.review_manifest
  if (
    value.schema !== 'skillager.import.v1' ||
    value.status !== 'preview' ||
    manifest?.schema !== 'skillager.import-review-manifest.v1'
  )
    throw new Error(
      'Save and accept requires the public external import review manifest (Skillager 0.9.7 or supported source). Update Skillager, then select the original again.',
    )
  if (value.destination?.exists === true)
    throw new Error(
      'That library name already exists. Choose a different Library name in Save options, then Refresh review; the existing copy is preserved.',
    )
  if (
    value.source?.id !== selection.skillId ||
    manifest.source_id !== selection.skillId ||
    value.source.file !== selection.file.path ||
    manifest.source_file !== selection.file.path ||
    value.source.path !== manifest.source_root ||
    `${manifest.source_root}/SKILL.md` !== selection.file.path ||
    value.source_hash !== manifest.source_hash ||
    value.source.content_hash !== manifest.source_hash ||
    manifest.working_hash !== manifest.source_hash ||
    value.destination?.id !== manifest.destination_id ||
    value.destination.path !== manifest.destination_path ||
    value.destination.exists !== false ||
    value.destination.id !== `lib/${value.destination.name}` ||
    (selection.name !== undefined && value.destination.name !== selection.name) ||
    !/^[\w.-]+$/u.test(value.destination.name) ||
    manifest.destination_path !==
      `${manifest.library?.root}/skills/${value.destination.name}` ||
    value.project !== workspace.root.path
  )
    throw new Error(
      'The selected original, destination or exact import version changed. Review the current original again.',
    )
  const library = manifest.library
  if (
    !['ready', 'will-initialize'].includes(library?.status) ||
    !['system', 'disabled'].includes(library.git_mode) ||
    (!(library.library_id === null && library.status === 'will-initialize') &&
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(
        library.library_id,
      )) ||
    ['status', 'root', 'git_mode'].some((key) => value.library?.[key] !== library[key])
  )
    throw new Error('The complete public import library identity/history is unavailable')
  absoluteLocalPath(library.root)
  absoluteLocalPath(manifest.source_root)
  absoluteLocalPath(manifest.destination_path)
  digest(manifest.source_hash)
  digest(manifest.confirmation_token)
  exactTreeFiles(manifest)
  if (
    !manifest.source_provenance ||
    ['type', 'collection', 'package', 'version', 'editable'].some(
      (key) =>
        !Object.hasOwn(manifest.source_provenance, key) ||
        manifest.source_provenance[key] !== value.source[key],
    )
  )
    throw new Error('The external import provenance does not match its exact occurrence')
  const expected = [
    'skillager',
    ...importArgs(
      { ...selection, name: value.destination.name },
      manifest.confirmation_token,
    ),
  ]
  const eligible =
    value.blocked === false &&
    value.requires_override === false &&
    metadataEncoding(value.next_command_argv) === metadataEncoding(expected)
  return {
    manifest,
    name: value.destination.name,
    eligible,
    gate: eligible
      ? undefined
      : 'Skillager cannot ordinarily save and accept this source. Inspect its scan/lint or blocked-source guidance and use its audited public CLI repair route.',
  }
}
