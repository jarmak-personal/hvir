/* global TextEncoder */
import { boundedManagementResult } from './management-contract.mjs'
import { metadataText, isCanonicalSkillId } from './public-metadata.mjs'
import { syncReviewHash } from './management-sync-review.mjs'
import {
  projectImportSelection,
  projectImportEnvelope,
  projectImportCanonical,
  readProjectImport,
} from './project-import-contract.mjs'

const statusSchema = 'skillager.project-import-status.v1'
/** Both identities come from the review; missing originals must not erase destinations. */
export function projectImportStatusArgs(operation) {
  const selection = JSON.stringify(
      projectImportSelection(JSON.stringify(operation.selection)),
    ),
    destinations = operation.items.map((item) => item.destination_id)
  if (
    destinations.length !== operation.selection.length ||
    new Set(destinations).size !== destinations.length ||
    destinations.some((id) => !isCanonicalSkillId(id)) ||
    operation.items.some(
      (item, index) => item.occurrence_id !== operation.selection[index],
    )
  )
    throw new Error('The selected destination identities are incomplete. Review again.')
  const encoded = JSON.stringify(destinations),
    args = [
      'import-project',
      '--status',
      '--select',
      selection,
      '--destinations',
      encoded,
      '--json',
    ]
  if (
    new TextEncoder().encode(selection + encoded).length > 6144 ||
    new TextEncoder().encode(JSON.stringify(args)).length > 8192
  )
    throw new Error(
      'The selected destination names exceed the status bound. Choose fewer skills.',
    )
  return args
}
export function exactProjectImportState(value, operation) {
  projectImportEnvelope(value, statusSchema, operation.workspace)
  if (
    !Number.isSafeInteger(value.limits.status_request_bytes) ||
    value.limits.status_request_bytes < 1 ||
    value.limits.status_request_bytes > 6144 ||
    value.library.root !== operation.library.root.path ||
    value.library.git_mode !== operation.library.gitMode ||
    (operation.library.id !== null &&
      value.library.library_id !== operation.library.id) ||
    !Array.isArray(value.items) ||
    value.items.length !== operation.items.length
  )
    throw new Error(
      'The current library or selected destinations changed. Inspect the retained operation.',
    )
  for (const [index, item] of value.items.entries()) {
    const expected = operation.items[index]
    projectImportCanonical(item.canonical, value.library)
    if (
      item.occurrence_id !== expected.occurrence_id ||
      item.destination_id !== expected.destination_id ||
      item.canonical?.skill_id !== expected.destination_id ||
      item.canonical.path !== expected.destination_path
    )
      throw new Error('Current state does not cover every exact submitted destination.')
    if (item.source !== null) {
      if (item.source?.skill_file !== expected.source_file)
        throw new Error(
          'The current project occurrence changed. Inspect its source before acknowledgment.',
        )
      metadataText(item.source.id)
      metadataText(item.source.name, 320)
      metadataText(item.source.description, 2000)
    }
  }
  return value
}
export async function observeProjectImportState(io, operation) {
  const value = await readProjectImport(
    io,
    projectImportStatusArgs(operation),
    statusSchema,
  )
  return exactProjectImportState(value, operation)
}
/** A digest binds all current facts while the exact operation remains available in report pages. */
export async function projectImportReconciliation(io, operation) {
  const current = await observeProjectImportState(io, operation),
    counts = { accepted: 0, pending: 0, missing: 0 }
  for (const item of current.items) counts[item.canonical.acceptance]++
  return boundedManagementResult({
    action: operation.action,
    registration: current.library.status === 'ready' ? 'registered' : 'not-registered',
    libraryId: current.library.library_id,
    counts,
    items: current.items.map((item, index) => ({
      index,
      state: item.canonical.acceptance,
    })),
    observationHash: await syncReviewHash(current),
    originalCompletion: 'unknown',
    partialFiles: 'unknown',
    safeNext:
      'Current destination facts do not prove this batch completed. Inspect saved or pending items before a fresh selection; no operation was replayed.',
  })
}
