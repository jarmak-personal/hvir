import { importReconciliation } from './import-operation.mjs'
import { observeExposures, observeNative } from './exposure-observation.mjs'
import { removalPreview } from './management-contract.mjs'
import { removalArgs } from './management-argv.mjs'
import { prepareExposureChange } from './exposure-operation.mjs'
import { syncReviewHash } from './management-sync-review.mjs'

/** Inspect only this canonical destination and original; never scan/sync the library. */
export async function placementReconciliation(io, operation, registration, workspace) {
  if (
    workspace?.id !== operation.workspace.id ||
    workspace.host !== 'local' ||
    workspace.root?.hostId !== 'local' ||
    workspace.root.path !== operation.workspace.root.path
  )
    throw new Error('Inspect this operation in its original local project.')
  const saved = await importReconciliation(io, operation, registration)
  if (!saved.registered)
    return {
      ...saved,
      project: 'unknown',
      safeNext:
        'No library is registered. Inspect the saved destination and project files with ordinary file tools before a fresh review; nothing was retried.',
    }
  const library = saved.registered,
    root = operation.source.root.path
  const copies = (await observeExposures(io, workspace, operation.agent)).filter(
    (item) => item.target === root,
  )
  if (copies.length > 1) throw new Error('Current project copy identity is ambiguous.')
  if (copies.length) {
    const copy = copies[0]
    if (
      copy.skill_id !== `lib/${operation.name}` ||
      copy.source_library_id !== library.id
    )
      throw new Error(
        'A different copy now occupies this project location. Inspect it before acknowledgment.',
      )
    const request = {
      workspace,
      agent: operation.agent,
      exposureId: copy.exposure_id,
      target: { hostId: 'local', path: root },
    }
    const plan = removalPreview(await io.run(removalArgs(request)), request)
    return {
      ...saved,
      project: {
        state: 'unchanged-managed',
        target: request.target,
        mode: copy.mode,
        exposureId: copy.exposure_id,
        targetState: plan.preview.target_state_hash,
        token: plan.token,
      },
      safeNext:
        'Current saved and managed-copy facts are shown; original completion remains unknown. Choose a fresh task for any further change.',
    }
  }
  const row = { path: operation.file.path },
    observation = await observeNative(io, row, workspace, operation.agent, library)
  if (saved.state === 'destination-absent' || saved.acceptance === 'pending') {
    const origin = observation.origin,
      expected = operation.plan.original
    if (
      observation.project !== workspace.root.path ||
      observation.agent !== operation.agent ||
      observation.scope !== 'project' ||
      observation.library_id !== library.id ||
      origin?.origin_id !== expected.origin_id ||
      origin.entrypoint !== operation.file.path ||
      origin.path !== root ||
      origin.skill_id !== operation.source.id ||
      origin.native?.agent !== operation.agent ||
      origin.native?.scope !== 'project' ||
      origin.native?.project_root !== workspace.root.path
    )
      throw new Error(
        'Current original identity is unresolved or changed. Inspect this project before acknowledgment.',
      )
    return {
      ...saved,
      partialFiles: 'unknown',
      project: {
        state: 'original-present',
        target: operation.source.root,
        originId: origin.origin_id,
        content: 'not-asserted',
        publicFacts: await syncReviewHash(observation),
      },
      safeNext:
        saved.acceptance === 'pending'
          ? 'The project original is present and the saved library version is pending. Inspect or accept that library version before a fresh replacement review; nothing was replayed.'
          : 'The project original is present and the library destination is currently absent. Partial files and original completion remain unknown. A new explicit task requires fresh review; nothing was replayed.',
    }
  }
  const chosen = observation.candidates.find(
    (item) =>
      item.status === 'available' && item.source.skill_id === `lib/${operation.name}`,
  )
  if (!chosen)
    throw new Error(
      'The original or its exact saved preservation is not currently available. Inspect the retained report and repair through Skillager before acknowledgment.',
    )
  const prepared = await prepareExposureChange(
    io,
    {
      library,
      agent: operation.agent,
      request: JSON.stringify(chosen.requests[operation.mode]),
    },
    workspace,
  )
  return {
    ...saved,
    project: {
      state: 'preserved-original',
      target: operation.source.root,
      token: prepared.plan.confirmation_token,
      publicFacts: await syncReviewHash(prepared.plan),
    },
    safeNext:
      'The original remains a separately preserved project skill. Choose Use full copy or Use stub for a fresh replacement review; saving is not repeated.',
  }
}
