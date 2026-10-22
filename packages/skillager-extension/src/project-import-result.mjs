import { boundedManagementJson, digest } from './management-contract.mjs'
import { externalImportLibrary } from './import-contract.mjs'
import {
  projectImportSchema,
  projectImportRefusal,
  sameProjectImportFact as same,
} from './project-import-contract.mjs'

const statuses = ['accepted', 'failed', 'skipped', 'uncertain']
/** Validate every submitted result before deriving a compact complete summary. */
export function projectImportCompletion(value, code, preview) {
  boundedManagementJson(value)
  if (value?.schema !== projectImportSchema || ![0, 2].includes(code))
    throw new Error(
      'The project save reply is incomplete. Inspect its operation before continuing.',
    )
  if (value.status === 'refused') {
    if (code !== 2 || value.initialization !== undefined || value.items !== undefined)
      throw new Error(
        'The project save refusal does not establish that no effects started.',
      )
    projectImportRefusal(value)
    return value
  }
  if (
    !['completed', 'partial', 'uncertain'].includes(value.status) ||
    value.project_root !== preview.project_root ||
    !same(value.selection, preview.selection) ||
    value.plan_hash !== preview.confirmation_token ||
    !Array.isArray(value.items) ||
    value.items.length !== preview.items.length ||
    (value.status === 'completed') !== (code === 0)
  )
    throw new Error('The save reply does not cover the exact reviewed project selection.')
  const library = externalImportLibrary(value.library),
    expected = preview.library
  if (
    library.root !== expected.root ||
    library.git_mode !== expected.git_mode ||
    (expected.library_id !== null && library.library_id !== expected.library_id)
  )
    throw new Error('The saved library identity changed. Inspect the retained operation.')
  if (expected.status === 'ready') {
    if (!same(value.initialization, null) || library.status !== 'ready')
      throw new Error('The save reply unexpectedly changed library initialization.')
  } else if (value.initialization !== null) {
    const init = value.initialization
    if (
      init.root !== expected.root ||
      !['initialized', 'registered', 'uncertain'].includes(init.status) ||
      (init.status !== 'uncertain' &&
        (library.status !== 'ready' || init.library_id !== library.library_id))
    )
      throw new Error('The first-library save result is incomplete.')
  }
  const counts = Object.fromEntries(statuses.map((key) => [key, 0]))
  for (const [index, item] of value.items.entries()) {
    const reviewed = preview.items[index]
    if (
      item.occurrence_id !== reviewed.occurrence_id ||
      item.source_id !== reviewed.source.id ||
      item.source_file !== reviewed.source.file ||
      item.source_hash !== reviewed.source_hash ||
      item.destination_id !== reviewed.destination.id ||
      item.destination_path !== reviewed.destination.path ||
      !statuses.includes(item.status) ||
      (item.status === 'accepted'
        ? item.accepted_hash !== reviewed.source_hash ||
          item.reason_code !== null ||
          library.status !== 'ready'
        : item.accepted_hash !== null ||
          typeof item.reason_code !== 'string' ||
          !item.reason_code ||
          item.reason_code.length > 128)
    )
      throw new Error(
        'A project save outcome is missing or differs from its reviewed occurrence.',
      )
    if (item.accepted_hash !== null) digest(item.accepted_hash)
    counts[item.status]++
  }
  if (
    !same(value.counts, counts) ||
    (value.status === 'completed' && counts.accepted !== preview.items.length) ||
    (value.status === 'partial' &&
      (!counts.accepted || counts.accepted === preview.items.length)) ||
    (value.status === 'uncertain' && counts.accepted !== 0) ||
    (counts.accepted &&
      expected.status === 'will-initialize' &&
      !['initialized', 'registered'].includes(value.initialization?.status))
  )
    throw new Error('Complete project save totals or initialization facts disagree.')
  return value
}

/** Indices refer to the reviewed selection; complete native identities stay in the retained report. */
export function projectImportSummary(value) {
  return {
    counts: value.counts,
    items: value.items.map((item, index) => ({ index, status: item.status })),
    ...(value.status !== 'completed' ? { details: 'operation-report' } : {}),
  }
}
