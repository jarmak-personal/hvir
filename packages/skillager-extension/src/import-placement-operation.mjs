import {
  prepareImportPlacement,
  importPlacementArgs,
  placementCompletion,
} from './import-placement-contract.mjs'
import {
  registeredLibrary,
  acceptedSource,
  boundedManagementResult,
  digest,
} from './management-contract.mjs'

/** One human decision; Skillager alone sequences acceptance and physical replacement. */
export async function saveAndUseCopy(io, input, invocation, admit) {
  if (invocation.caller === 'agent')
    throw new Error('Save and use is human-only; agents cannot accept instructions.')
  digest(input.hash)
  digest(input.token)
  const workspace = invocation.context.workspace
  const prepared = await prepareImportPlacement(io, input, workspace)
  const { manifest, value: preview } = prepared
  if (
    !prepared.eligible ||
    input.token !== preview.confirmation_token ||
    input.hash !== manifest.source_hash
  )
    throw new Error(
      prepared.gate ??
        'This original or its destination changed. Review Save and use again.',
    )
  const operation = {
    action: 'save-and-use-copy',
    workspace,
    agent: input.agent,
    mode: input.mode,
    library: {
      id: preview.library_identity.library_id,
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
    name: prepared.name,
    target: { hostId: 'local', path: manifest.destination_path },
    targets: preview.replacement.targets
      .filter((target) => target.action !== 'keep')
      .map((target) => ({ hostId: 'local', path: target.path })),
    token: input.token,
    plan: preview,
  }
  admit(operation)
  let code
  const result = await io.run(
    importPlacementArgs(input, input.token),
    operation,
    false,
    (_value, exit) => {
      code = exit
    },
  )
  placementCompletion(result, code, preview, input, workspace)
  let source, library
  if (result.save.status === 'accepted') {
    const status = await io.run(['library', 'status', manifest.destination_id, '--json'])
    library = registeredLibrary(status)
    if (
      library.id !== operation.library.id ||
      library.root.path !== operation.library.root.path ||
      library.gitMode !== operation.library.gitMode
    )
      throw new Error(
        'The saved library registration changed. Inspect this operation before continuing.',
      )
    source = acceptedSource(status, library, manifest.destination_id, input.hash)
    if (source.root.path !== operation.target.path)
      throw new Error(
        'The saved canonical path changed. Inspect this operation before continuing.',
      )
  }
  const complete = result.status === 'saved-and-replaced',
    saved = result.status === 'saved-not-replaced',
    refused = result.status === 'refused',
    outcome = complete
      ? 'verified'
      : saved
        ? 'saved-not-replaced'
        : refused
          ? 'refused'
          : 'uncertain'
  const reply = boundedManagementResult({
    outcome,
    action: operation.action,
    library,
    source,
    original: { file: input.file },
    mode: input.mode,
    save: result.save,
    placement: result.placement,
    initialization: result.initialization,
    ...(result.error ? { error: result.error } : {}),
    ...(result.cleanup ? { cleanup: result.cleanup } : {}),
    message: complete
      ? `Saved in your library and using ${input.mode === 'stub' ? 'Stub' : 'Full'} in this project. Restart the agent to use it.`
      : saved
        ? 'Saved in your library. Project replacement was not applied. Refresh this skill, then choose Use full copy or Use stub to review the remaining change.'
        : refused
          ? `${result.error.message} No save or replacement started. Resolve the conflict and review again.`
          : 'Save and use may have completed partly. Inspect the separate save and project results before continuing; do not repeat the operation.',
  })
  if (complete || saved || refused) io.verified()
  return reply
}
