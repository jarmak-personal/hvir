import { importArgs, exactImportManifest } from './import-contract.mjs'
import {
  registeredLibrary,
  acceptedSource,
  boundedManagementResult,
  digest,
} from './management-contract.mjs'

export async function saveAndAccept(io, input, invocation, admit) {
  if (invocation.caller === 'agent')
    throw new Error('Save and accept is human-only; agents cannot accept instructions')
  digest(input.hash)
  digest(input.token)
  const workspace = invocation.context.workspace
  if (workspace?.host !== 'local' || workspace.root?.hostId !== 'local')
    throw new Error(
      'Save and accept requires the selected exact local project; no local connector was substituted',
    )
  const current = exactImportManifest(await io.run(importArgs(input)), input, workspace)
  const manifest = current.manifest
  if (
    !current.eligible ||
    manifest.confirmation_token !== input.token ||
    manifest.source_hash !== input.hash
  )
    throw new Error(
      current.gate ??
        'The exact original or import destination changed. Review Save and accept again.',
    )
  const operation = {
    action: 'save-and-accept',
    workspace,
    library: {
      id: manifest.library.library_id,
      root: { hostId: 'local', path: manifest.library.root },
      gitMode: manifest.library.git_mode,
    },
    initializes: manifest.library.status === 'will-initialize',
    source: {
      id: input.skillId,
      root: { hostId: 'local', path: manifest.source_root },
      hash: input.hash,
    },
    file: input.file,
    name: current.name,
    target: { hostId: 'local', path: manifest.destination_path },
    token: input.token,
  }
  admit(operation)
  const result = await io.run(importArgs(input, input.token), operation)
  if (
    result.schema !== 'skillager.import.v1' ||
    result.status !== 'imported' ||
    result.source?.id !== input.skillId ||
    result.source.path !== manifest.source_root ||
    result.source.content_hash !== input.hash ||
    result.destination?.id !== manifest.destination_id ||
    result.destination.path !== manifest.destination_path ||
    result.destination.working_hash !== input.hash ||
    result.destination.accepted_hash !== input.hash ||
    result.destination.acceptance !== 'accepted' ||
    result.approval?.state !== 'reviewed' ||
    result.approval.scope !== 'global' ||
    result.approval.content_hash !== input.hash ||
    result.copied_file_count !== manifest.file_count ||
    (operation.initializes &&
      (result.library?.status !== 'initialized' ||
        result.library.root !== manifest.library.root ||
        result.library.git_mode !== manifest.library.git_mode))
  )
    throw new Error(
      'Submitted Save and accept has no complete exact result. Inspect its retained report; copied or committed content may remain pending.',
    )
  const status = await io.run(['library', 'status', manifest.destination_id, '--json'])
  const library = registeredLibrary(status)
  if (
    (operation.library.id !== null && library.id !== operation.library.id) ||
    library.root.path !== operation.library.root.path ||
    library.gitMode !== operation.library.gitMode
  )
    throw new Error(
      'Import registration changed; reconcile the exact submitted operation',
    )
  const source = acceptedSource(status, library, manifest.destination_id, input.hash)
  if (source.root.path !== operation.target.path)
    throw new Error(
      'Imported canonical path changed; reconcile the exact submitted operation',
    )
  const reply = boundedManagementResult({
    outcome: 'verified',
    action: operation.action,
    library,
    source,
    original: { file: input.file, preserved: true },
    initialized: operation.initializes,
    message: 'Saved and accepted in your library. The project original is unchanged.',
  })
  io.verified()
  return reply
}

export async function importReconciliation(io, operation, library) {
  if (
    library.root.path !== operation.library.root.path ||
    library.gitMode !== operation.library.gitMode ||
    (operation.library.id !== null && library.id !== operation.library.id)
  )
    throw new Error(
      'The import library changed; inspect the original destination with public CLI tools. Original completion remains unknown.',
    )
  const id = `lib/${operation.name}`
  const status = await io.run(['library', 'status', id, '--json'])
  const observed = registeredLibrary(status)
  if (
    observed.id !== library.id ||
    observed.root.path !== library.root.path ||
    observed.gitMode !== library.gitMode ||
    status.skill?.id !== id ||
    status.skill.path !== operation.target.path ||
    !['pending', 'accepted'].includes(status.skill.acceptance)
  )
    throw new Error(
      'The submitted import destination needs public CLI inspection/repair before acknowledgment. Original completion remains unknown.',
    )
  digest(status.skill.working_hash)
  if (status.skill.accepted_hash !== null) digest(status.skill.accepted_hash)
  return {
    action: operation.action,
    registered: library,
    target: operation.target,
    workingHash: status.skill.working_hash,
    acceptedHash: status.skill.accepted_hash,
    acceptance: status.skill.acceptance,
    originalCompletion: 'unknown',
    safeNext:
      'The original remains separate. Inspect or accept the current canonical version; do not replay import into an occupied name.',
  }
}
