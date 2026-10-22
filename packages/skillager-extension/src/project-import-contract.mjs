/* global TextEncoder */
import {
  absoluteLocalPath,
  boundedManagementJson,
  digest,
} from './management-contract.mjs'
import {
  exactExternalImportTree,
  externalImportLibrary,
  importArgs,
} from './import-contract.mjs'
import { isCanonicalSkillId, metadataText } from './public-metadata.mjs'
import { metadataEncoding } from './management-sync-review.mjs'
import { isStaleCatalogCursor } from './catalog-cli.mjs'

export const projectImportUpdate =
  'Update Skillager to save project skills together. Browsing and individual skill actions remain available.'
export const projectImportSchema = 'skillager.project-import.v1'
const inventorySchema = 'skillager.project-import-inventory.v1'
const categories = [
  'eligible',
  'already_saved',
  'managed',
  'duplicate',
  'conflict',
  'blocked',
]
const maximums = {
  selection_items: 32,
  selection_bytes: 4096,
  inventory_items: 10000,
  page_items: 100,
  argv_bytes: 8192,
  files: 512,
  file_bytes: 2 * 1024 * 1024,
  tree_bytes: 32 * 1024 * 1024,
  response_bytes: 256 * 1024,
}
export const sameProjectImportFact = (a, b) => metadataEncoding(a) === metadataEncoding(b)
const bytes = (value) => new TextEncoder().encode(value).length
function count(value) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error('Complete project skill counts are unavailable.')
  return value
}
function occurrence(value) {
  if (typeof value !== 'string' || !/^project:[a-f0-9]{64}$/u.test(value))
    throw new Error('Choose exact project skill occurrences again.')
  return value
}
export function projectImportSelection(value) {
  if (typeof value !== 'string' || bytes(value) > maximums.selection_bytes)
    throw new Error('Choose at most 32 project skills within the selection limit.')
  let values
  try {
    values = JSON.parse(value)
  } catch {
    throw new Error('Choose project skills again.')
  }
  if (
    !Array.isArray(values) ||
    !values.length ||
    values.length > maximums.selection_items ||
    new Set(values.map(occurrence)).size !== values.length
  )
    throw new Error('Choose between 1 and 32 distinct project skills.')
  return values.sort()
}
export function projectImportArgs(selection, token) {
  const args = [
    'import-project',
    '--json',
    '--review-manifest',
    '--select',
    JSON.stringify(projectImportSelection(selection)),
  ]
  if (token !== undefined) args.push('--yes', '--confirmation-token', digest(token))
  return args
}
export function projectInventoryArgs({ limit = 100, cursor } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximums.page_items)
    throw new Error('Choose an inventory page of 1 to 100 skills.')
  if (
    cursor !== undefined &&
    (typeof cursor !== 'string' || !cursor.length || cursor.length > 4096)
  )
    throw new Error('Refresh the project skill inventory.')
  return [
    'import-project',
    '--json',
    '--limit',
    String(limit),
    ...(cursor ? ['--cursor', cursor] : []),
  ]
}
export function projectImportWorkspace(workspace) {
  if (
    workspace?.host !== 'local' ||
    workspace.root?.hostId !== 'local' ||
    typeof workspace.id !== 'string' ||
    !workspace.id
  )
    throw new Error(
      'Choose the exact local project to save its skills. SSH import is unavailable.',
    )
  return absoluteLocalPath(workspace.root.path).path
}
function limits(value) {
  for (const [key, maximum] of Object.entries(maximums))
    if (!Number.isSafeInteger(value?.[key]) || value[key] < 1 || value[key] > maximum)
      throw new Error(
        'The complete project import exceeds supported limits. Choose fewer skills.',
      )
  return value
}
function observation(value) {
  if (
    !['complete', 'partial'].includes(value?.status) ||
    !Array.isArray(value.errors) ||
    value.errors.length > 20 ||
    count(value.error_count) < value.errors.length ||
    (value.status === 'complete') !== (value.error_count === 0) ||
    (value.error_count > 0 && !value.errors.length)
  )
    throw new Error(
      'Project discovery coverage is unavailable. Refresh before choosing skills.',
    )
  for (const error of value.errors) {
    if (!metadataText(error.code, 128))
      throw new Error('Discovery failure identity is unavailable.')
    if (error.path !== null) metadataText(error.path, 4096)
  }
}
export function projectImportRefusal(value) {
  if (
    value?.status !== 'refused' ||
    typeof value.error?.code !== 'string' ||
    typeof value.error.message !== 'string' ||
    !value.error.code ||
    !value.error.message ||
    value.confirmation_token !== undefined ||
    value.next_command_argv !== undefined
  )
    throw new Error('Skillager returned incomplete project import metadata.')
  metadataText(value.error.code, 128)
  metadataText(value.error.message, 2048)
  return value.error.message
}
export function projectImportEnvelope(value, schema, workspace) {
  boundedManagementJson(value)
  if (value?.schema !== schema) throw new Error(projectImportUpdate)
  if (value.status === 'refused') throw new Error(projectImportRefusal(value))
  if (value.project_root !== projectImportWorkspace(workspace))
    throw new Error(
      'Project skill metadata belongs to another project. Refresh this project.',
    )
  externalImportLibrary(value.library)
  limits(value.limits)
  observation(value.observation)
}
export function projectImportCanonical(value, library) {
  if (value === null) return
  if (
    !isCanonicalSkillId(value?.skill_id) ||
    value.path !== `${library.root}/skills/${value.skill_id.slice(4)}` ||
    !['accepted', 'pending', 'missing'].includes(value.acceptance)
  )
    throw new Error('The existing library copy identity is unavailable.')
  if (value.working_hash !== null) digest(value.working_hash)
  if (value.accepted_hash !== null) digest(value.accepted_hash)
  if (
    (value.acceptance === 'accepted' &&
      (!value.working_hash || value.working_hash !== value.accepted_hash)) ||
    (value.acceptance === 'missing' && value.working_hash !== null)
  )
    throw new Error('The existing library acceptance facts disagree.')
}
/** Whole-project totals stay independent of the current inventory page and browser search. */
export function projectImportInventory(value, workspace) {
  projectImportEnvelope(value, inventorySchema, workspace)
  if (
    value.scope !== 'project' ||
    !Array.isArray(value.items) ||
    value.items.length > value.limits.page_items ||
    count(value.summary?.total) > value.limits.inventory_items ||
    categories.reduce((sum, key) => sum + count(value.summary[key]), 0) !==
      value.summary.total ||
    value.items.length > value.summary.total ||
    !(
      value.next_cursor === null ||
      (typeof value.next_cursor === 'string' &&
        value.next_cursor.length > 0 &&
        value.next_cursor.length <= 4096)
    )
  )
    throw new Error('Complete project import inventory is unavailable.')
  const ids = new Set(),
    files = new Set(),
    pageCounts = Object.fromEntries(categories.map((key) => [key, 0]))
  for (const item of value.items) {
    occurrence(item.occurrence_id)
    const file = absoluteLocalPath(item.skill_file).path
    if (
      ids.has(item.occurrence_id) ||
      files.has(file) ||
      !file.startsWith(`${value.project_root}/`) ||
      !file.endsWith('/SKILL.md') ||
      !categories.includes(item.eligibility)
    )
      throw new Error(
        'Project skill occurrences are repeated or belong to another project.',
      )
    ids.add(item.occurrence_id)
    files.add(file)
    pageCounts[item.eligibility]++
    metadataText(item.id)
    metadataText(item.name, 320)
    metadataText(item.description, 2000)
    if (item.source_hash !== null) digest(item.source_hash)
    if (item.source_identity !== null) digest(item.source_identity)
    if (item.destination_id !== null && !isCanonicalSkillId(item.destination_id))
      throw new Error('The project skill destination is unavailable.')
    if (item.reason_code !== null) metadataText(item.reason_code, 128)
    if (item.duplicate_of !== null) occurrence(item.duplicate_of)
    projectImportCanonical(item.canonical, value.library)
    if (
      (item.eligibility === 'eligible' &&
        (!item.source_hash ||
          !item.source_identity ||
          !item.destination_id ||
          item.reason_code !== null ||
          item.duplicate_of !== null ||
          item.canonical !== null)) ||
      (item.eligibility === 'already_saved' &&
        (item.canonical?.acceptance !== 'accepted' ||
          item.canonical.working_hash !== item.source_hash)) ||
      (item.eligibility === 'duplicate' && !item.duplicate_of)
    )
      throw new Error('Project import eligibility facts disagree. Refresh the inventory.')
  }
  if (categories.some((key) => pageCounts[key] > value.summary[key]))
    throw new Error('Project inventory totals do not cover the page.')
  if (value.default_selection === null) {
    if (value.summary.eligible <= value.limits.selection_items)
      throw new Error('The complete default selection is unavailable.')
  } else {
    const selection =
      value.default_selection.length === 0
        ? []
        : projectImportSelection(JSON.stringify(value.default_selection))
    if (
      selection.length !== value.summary.eligible ||
      !sameProjectImportFact(selection, value.default_selection) ||
      value.items.some(
        (item) =>
          selection.includes(item.occurrence_id) !== (item.eligibility === 'eligible'),
      )
    )
      throw new Error('Default selection does not cover all eligible project skills.')
  }
  return value
}
function location(value, path) {
  if (
    value?.path !== path ||
    ['device', 'inode', 'mode'].some(
      (key) => !Number.isSafeInteger(value[key]) || value[key] < 0,
    )
  )
    throw new Error('The exact project source location identity is unavailable.')
}
/** The token belongs to this batch; nested external manifests grant no separate action. */
export function exactProjectImport(value, selection, workspace) {
  projectImportEnvelope(value, projectImportSchema, workspace)
  const chosen = projectImportSelection(selection)
  if (
    value.status !== 'preview' ||
    chosen.length > value.limits.selection_items ||
    bytes(JSON.stringify(chosen)) > value.limits.selection_bytes ||
    !sameProjectImportFact(value.selection, chosen) ||
    !Array.isArray(value.items) ||
    value.items.length !== chosen.length
  )
    throw new Error('The complete selected project skill review changed.')
  digest(value.confirmation_token)
  digest(value.library_state)
  location(value.project_identity, value.project_root)
  if (
    typeof value.library.history?.available !== 'boolean' ||
    !(
      value.library.history.reason === null ||
      typeof value.library.history.reason === 'string'
    )
  )
    throw new Error('Library history must be visible in the complete project review.')
  const destinations = new Set(),
    sources = new Set()
  let fileCount = 0,
    totalBytes = 0
  for (const [index, item] of value.items.entries()) {
    const manifest = item.review_manifest
    if (
      !manifest ||
      !item.destination ||
      item.occurrence_id !== chosen[index] ||
      item.source_hash !== manifest?.source_hash ||
      !item.source?.file?.startsWith(`${value.project_root}/`) ||
      ['status', 'root', 'library_id', 'git_mode'].some(
        (key) => manifest.library?.[key] !== value.library[key],
      ) ||
      manifest.confirmation_token !== undefined ||
      destinations.has(item.destination?.path) ||
      sources.has(item.source.file)
    )
      throw new Error(
        'Selected source or destination identities disagree with the complete review.',
      )
    importArgs({
      skillId: item.source.id,
      file: { hostId: 'local', path: item.source.file },
      name: item.destination.name,
    })
    exactExternalImportTree(manifest, item.source, item.destination)
    digest(item.source_identity)
    location(item.source_location, item.source.path)
    location(item.source_file_identity, item.source.file)
    if (!metadataText(item.lint?.status, 128) || !metadataText(item.scan?.risk, 128))
      throw new Error('Selected lint and scan details are unavailable.')
    count(item.lint.blocking_count)
    count(item.scan.finding_count)
    destinations.add(item.destination.path)
    sources.add(item.source.file)
    fileCount += manifest.file_count
    totalBytes += manifest.total_bytes
  }
  if (
    fileCount > value.limits.files ||
    totalBytes > value.limits.tree_bytes ||
    !sameProjectImportFact(value.next_command_argv, [
      'skillager',
      ...projectImportArgs(selection, value.confirmation_token),
    ])
  )
    throw new Error(
      'The complete selected review or confirmation command exceeds supported bounds.',
    )
  return value
}
/** Public native exit validation preserves refusals; unsupported versions leave other tasks intact. */
export async function readProjectImport(io, args, schema) {
  try {
    return await io.run(args, undefined, true, (value, code) => {
      if (value?.schema === 'skillager.error.v1') {
        boundedManagementJson(value)
        const details = value.error
        if (
          !Number.isSafeInteger(code) ||
          code < 1 ||
          !metadataText(details?.code, 128) ||
          !metadataText(details?.message, 2048)
        )
          throw new Error('Skillager returned incomplete project import error metadata.')
        const error = new Error(`${details.message} (${details.code})`)
        if (schema === inventorySchema && code === 15) {
          const stdout = JSON.stringify(value),
            cli = {
              outcome: 'completed',
              code,
              stdout: stdout.length <= 4096 ? stdout : undefined,
            }
          if (isStaleCatalogCursor({ cli })) error.cli = cli
        }
        throw error
      }
      if (value?.schema !== schema) throw new Error(projectImportUpdate)
      if (code === 2 && value.status === 'refused')
        throw new Error(projectImportRefusal(value))
      if (code !== 0)
        throw new Error(
          'Skillager could not read project import metadata. Refresh before continuing.',
        )
    })
  } catch (error) {
    if (
      error.nativeExit === 2 &&
      /invalid choice: ['"]import-project['"]/u.test(error.nativeStderr ?? '')
    )
      throw new Error(projectImportUpdate, { cause: error })
    throw error
  }
}
export async function prepareProjectImport(io, selection, workspace) {
  projectImportWorkspace(workspace)
  return exactProjectImport(
    await readProjectImport(io, projectImportArgs(selection), projectImportSchema),
    selection,
    workspace,
  )
}
export async function observeProjectImport(io, workspace, paging) {
  projectImportWorkspace(workspace)
  return projectImportInventory(
    await readProjectImport(io, projectInventoryArgs(paging), inventorySchema),
    workspace,
  )
}
