import {
  acceptedSource,
  digest,
  registeredLibrary,
  sameLibrary,
  exposurePreview,
  removalPreview,
  boundedManagementResult,
} from './management-contract.mjs'
import { exposureArgs, removalArgs } from './management-argv.mjs'

export async function prepareCopy(io, input, workspace, remove = false, add = false) {
  const library = registeredLibrary(await io.run(['library', 'status', '--json']))
  sameLibrary(input.library, library)
  const request = {
    library,
    workspace,
    agent: input.agent,
    mode: input.mode,
    exposureId: input.exposureId,
    target: input.target,
  }
  if (remove)
    return { request, plan: removalPreview(await io.run(removalArgs(request)), request) }
  request.source = acceptedSource(
    await io.run(['library', 'status', input.skillId, '--json']),
    library,
    input.skillId,
    input.hash,
  )
  return {
    request,
    plan: exposurePreview(await io.run(exposureArgs(request)), request, add),
  }
}

export async function applyCopy(io, action, input, workspace, admit = () => {}) {
  const remove = action === 'remove-copy',
    add = action === 'add-copy'
  if (!remove && (typeof input.hash !== 'string' || !/^[a-f0-9]{64}$/u.test(input.hash)))
    throw new Error('Select one complete exact accepted source hash before Add or Update')
  const { request, plan } = await prepareCopy(io, input, workspace, remove, add)
  if (!add && input.token !== plan.token)
    throw new Error(
      'The complete reviewed plan changed. Review the fresh plan before confirming.',
    )
  admit({ action, target: { hostId: 'local', path: plan.target } })
  const value = await io.run(
    remove ? removalArgs(request, plan.token) : exposureArgs(request, plan.token),
    {
      action,
      library: request.library,
      workspace,
      agent: request.agent,
      mode: request.mode,
      source: request.source,
      exposureId: plan.result.exposure_id,
      target: { hostId: 'local', path: plan.target },
      token: plan.token,
    },
  )
  const result = remove ? value.results?.[0] : value?.[0]
  // These exact public reasons originate before direct exposure installation.
  // Generic skipped errors may follow partial physical effects and stay uncertain.
  const beforeInstallReasons = [
    'target exists without Skillager provenance',
    'target has local edits',
    'exact exposure hash is blocked by prior project policy',
    'exposure preview is stale or does not match this command; review the current preview and execute its returned command',
  ]
  if (
    !remove &&
    Array.isArray(value) &&
    value.length === 1 &&
    result?.schema === 'skillager.exposure-result.v1' &&
    result.status === 'skipped' &&
    beforeInstallReasons.includes(result.reason) &&
    result.skill_id === request.source.id &&
    result.mode === request.mode &&
    result.agent === request.agent &&
    result.scope === 'project' &&
    result.target === plan.target &&
    result.exposure_id === plan.result.exposure_id &&
    result.restart_required === false
  ) {
    const reply = boundedManagementResult({
      outcome: 'refused',
      action,
      reason: result.reason,
      target: { hostId: 'local', path: plan.target },
      agent: request.agent,
      mode: request.mode,
      exposureId: result.exposure_id,
      message:
        'Skillager preserved this exact target before installation. Observe it and choose a fresh operation explicitly.',
    })
    io.verified()
    return reply
  }
  if (
    (remove
      ? value.schema !== 'skillager.exposure-remove.v1' || value.results?.length !== 1
      : !Array.isArray(value) || value.length !== 1) ||
    result?.status !== (remove ? 'removed' : 'exposed') ||
    result.agent !== request.agent ||
    result.scope !== 'project' ||
    result.target !== plan.target ||
    (!remove &&
      (result.skill_id !== request.source.id || result.mode !== request.mode)) ||
    (request.exposureId && result.exposure_id !== request.exposureId)
  )
    throw new Error(
      'Submitted copy operation has no verified exact result. Reconcile its current managed target.',
    )
  const listing = await io.run([
    'expose',
    '--list',
    '--agent',
    request.agent,
    '--scope',
    'project',
    '--json',
  ])
  if (listing.schema !== 'skillager.exposures.v1' || !Array.isArray(listing.exposures))
    throw new Error(
      'Submitted copy operation requires an explicit fresh managed-target observation',
    )
  const matches = listing.exposures.filter(
    (item) =>
      item?.exposure_id === result.exposure_id &&
      item.agent === request.agent &&
      item.scope === 'project',
  )
  if (
    remove
      ? matches.length !== 0
      : matches.length !== 1 ||
        matches[0].target !== plan.target ||
        matches[0].source_library_id !== request.library.id ||
        matches[0].skill_id !== request.source.id ||
        matches[0].mode !== request.mode ||
        !digest(matches[0].current_hash) ||
        matches[0].status !== 'current'
  )
    throw new Error(
      'Submitted operation and current managed-target observation disagree. Reconcile this exact operation.',
    )
  if (!remove) {
    const observed = await io.run(['library', 'status', request.source.id, '--json'])
    acceptedSource(observed, request.library, request.source.id, request.source.hash)
    const bindings = Array.isArray(observed.skill.exposures)
      ? observed.skill.exposures.filter(
          (item) =>
            item?.path === plan.target &&
            item.agent === request.agent &&
            item.scope === 'project',
        )
      : []
    if (
      !Array.isArray(bindings) ||
      bindings.length !== 1 ||
      bindings[0].kind !== request.mode ||
      bindings[0].status !== 'current' ||
      bindings[0].source_hash !== request.source.hash ||
      bindings[0].source_library_id !== request.library.id
    )
      throw new Error(
        'Submitted operation and current source-bound exposure disagree. Reconcile this exact operation.',
      )
  }
  const reply = boundedManagementResult({
    outcome: 'verified',
    action,
    target: { hostId: 'local', path: plan.target },
    agent: request.agent,
    mode: request.mode,
    exposureId: result.exposure_id,
    restartRequired: result.restart_required === true,
  })
  io.verified()
  return reply
}
