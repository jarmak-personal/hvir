import { planArgs, exposurePlan } from './exposure-contract.mjs'
import { removalPreview, digest } from './management-contract.mjs'
import { removalArgs, syncArgs } from './management-argv.mjs'
import { publicSyncObservation } from './management-sync-observation.mjs'
import { syncReviewHash } from './management-sync-review.mjs'

/** Safe current public facts, never a historical-success inference or recovery deletion. */
export async function exposureFacts(io, operation, workspace, library) {
  if (
    workspace?.id !== operation.workspace?.id ||
    workspace.host !== 'local' ||
    workspace.root?.hostId !== 'local' ||
    workspace.root.path !== operation.workspace.root.path
  )
    throw new Error('Reconcile in the original exact local project/worktree')
  const input = { request: operation.request, agent: operation.agent, library },
    fresh = await io.run(
      planArgs(operation.requestRaw, operation.agent),
      undefined,
      true,
      (value, code) => {
        if (![0, 2].includes(code) || value.schema !== 'skillager.exposure-plan.v1')
          throw new Error('Supported current exposure observation is unavailable')
      },
    )
  if (fresh.status === 'would_apply') {
    const plan = exposurePlan(fresh, input, workspace)
    return {
      operation: operation.request.action,
      state: 'fresh-complete-plan',
      token: plan.confirmation_token,
      publicFacts: await syncReviewHash(plan),
      safeNext:
        'Original completion remains unknown. Review the complete new plan before any new explicit change.',
    }
  }
  // These are action-specific completed-state observations. Other refusals retain the record.
  const admissible = {
    group: ['name-conflict'],
    'set-members': ['target-missing'],
    ungroup: ['target-missing'],
    'adopt-native': ['origin-mismatch', 'origin-unavailable'],
  }
  if (!admissible[operation.request.action]?.includes(fresh.reason_code))
    throw new Error(
      `${fresh.reason ?? 'Current safe facts are unavailable'}. Inspect/repair the reported files and retained recovery locations with ordinary tools and the public CLI, then observe again. Original completion remains unknown.`,
    )
  const listed = await io.run([
    'expose',
    '--list',
    '--agent',
    operation.agent,
    '--scope',
    'project',
    '--json',
  ])
  if (listed.schema !== 'skillager.exposures.v1' || !Array.isArray(listed.exposures))
    throw new Error('Complete current managed exposure inventory is unavailable')
  const facts = []
  for (const target of operation.plan.targets) {
    if (!['router', 'direct', 'native-origin'].includes(target.kind)) continue
    const matches = listed.exposures.filter(
      (item) =>
        item.target === target.path &&
        item.agent === operation.agent &&
        item.scope === 'project',
    )
    if (matches.length > 1) throw new Error('Current target identity is ambiguous')
    if (matches.length) {
      const item = matches[0],
        request = {
          workspace,
          agent: operation.agent,
          exposureId: item.exposure_id,
          target: { hostId: 'local', path: target.path },
        }
      const plan = removalPreview(await io.run(removalArgs(request)), request)
      facts.push({
        target: request.target,
        state: 'unchanged-managed',
        exposureId: item.exposure_id,
        targetState: digest(plan.preview.target_state_hash),
        membership: item.skill_ids ?? null,
      })
    } else if (target.action === 'remove') {
      facts.push({
        target: { hostId: 'local', path: target.path },
        state: 'managed-record-absent',
      })
    } else
      throw new Error(
        'The expected current managed target is absent; repair through public CLI before reconciliation',
      )
  }
  const sync = publicSyncObservation(await io.run(syncArgs(library)), library)
  if (!sync.coverage.complete)
    throw new Error(
      'Complete native preservation observations are unavailable; resolve through public CLI',
    )
  return {
    operation: operation.request.action,
    state: 'supported-current-observation',
    targets: facts,
    nativePreservation: await syncReviewHash(sync),
    safeNext:
      'Original completion remains unknown. No retained recovery was deleted; any future operation needs a fresh complete public token plan.',
  }
}
