import { boundedManagementResult, digest } from './management-contract.mjs'
import {
  prepareProjectImport,
  projectImportArgs,
  projectImportSelection,
} from './project-import-contract.mjs'
import {
  projectImportCompletion,
  projectImportSummary,
} from './project-import-result.mjs'
import {
  observeProjectImportState,
  projectImportStatusArgs,
} from './project-import-reconcile.mjs'

/** One domain mutation for the complete human selection; no per-item import loop. */
export async function saveProjectSkills(io, input, invocation, admit) {
  if (invocation.caller === 'agent')
    throw new Error(
      'Saving project skills is human-only; agents cannot accept instructions.',
    )
  digest(input.token)
  const selection = projectImportSelection(input.selection),
    workspace = invocation.context.workspace,
    preview = await prepareProjectImport(io, input.selection, workspace)
  if (preview.confirmation_token !== input.token)
    throw new Error(
      'These skills or the library changed. Review the current selection again.',
    )
  const operation = {
    action: 'save-project-skills',
    workspace,
    selection,
    library: {
      id: preview.library.library_id,
      root: { hostId: 'local', path: preview.library.root },
      gitMode: preview.library.git_mode,
    },
    initializes: preview.library.status === 'will-initialize',
    targets: preview.items.map((item) => ({
      hostId: 'local',
      path: item.destination.path,
    })),
    items: preview.items.map((item) => ({
      occurrence_id: item.occurrence_id,
      source_file: item.source.file,
      source_hash: item.source_hash,
      destination_id: item.destination.id,
      destination_path: item.destination.path,
    })),
    token: input.token,
  }
  projectImportStatusArgs(operation)
  admit(operation)
  let code
  const result = projectImportCompletion(
    await io.run(
      projectImportArgs(input.selection, input.token),
      operation,
      false,
      (_value, exit) => {
        code = exit
      },
    ),
    code,
    preview,
  )
  if (result.status === 'refused') {
    io.verified()
    return boundedManagementResult({
      outcome: 'refused',
      action: operation.action,
      message: `${result.error.message} Nothing was saved. Review the current selection again.`,
    })
  }
  if (result.counts.accepted) {
    const current = await observeProjectImportState(io, operation)
    if (
      current.library.library_id !== result.library.library_id ||
      current.library.root !== result.library.root ||
      current.library.git_mode !== result.library.git_mode ||
      result.items.some(
        (item, index) =>
          item.status === 'accepted' &&
          (current.items[index].canonical.acceptance !== 'accepted' ||
            current.items[index].canonical.working_hash !== item.accepted_hash ||
            current.items[index].canonical.accepted_hash !== item.accepted_hash),
      )
    )
      throw new Error(
        'Saved versions no longer agree with current library status. Inspect this operation before continuing.',
      )
  }
  const complete = result.status === 'completed',
    saved = result.counts.accepted,
    noun = saved === 1 ? 'skill' : 'skills',
    summary = Object.entries(result.counts)
      .filter(([, count]) => count > 0)
      .map(([status, count]) => `${count} ${status === 'accepted' ? 'saved' : status}`)
      .join(' · ')
  const reply = boundedManagementResult({
    outcome: complete ? 'verified' : result.status,
    action: operation.action,
    ...projectImportSummary(result),
    originals: 'unchanged',
    initialization: result.initialization?.status ?? null,
    message: complete
      ? `Saved ${saved} ${noun} to your library. Project originals are unchanged.`
      : `${result.status === 'uncertain' ? 'Save outcome unknown · ' : ''}${summary}. Review results.`,
  })
  if (complete) io.verified()
  return reply
}
