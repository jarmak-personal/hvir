/* global TextEncoder */
import {
  registeredLibrary,
  sameLibrary,
  initializationResult,
  boundedManagementResult,
} from './management-contract.mjs'
import { initializationArgs, syncArgs } from './management-argv.mjs'
import { publicSyncObservation } from './management-sync-observation.mjs'
import { syncReport } from './management-sync-report.mjs'
import { syncReviewHash } from './management-sync-review.mjs'

export async function initializeLibrary(io, selection) {
  const result = await io.run(initializationArgs(selection), {
    action: 'initialize-library',
    selection,
  })
  const observed = initializationResult(
    result,
    await io.run(['library', 'status', '--json']),
    selection,
  )
  const reply = boundedManagementResult({
    outcome: 'verified',
    action: 'initialize-library',
    ...observed,
    guidance:
      'Create your first skill with the public Skillager CLI, then Refresh to read and review its exact version.',
  })
  io.verified()
  return reply
}
export function syncObservation(value, library, apply = false) {
  publicSyncObservation(value, library, apply)
  syncReport(value, apply)
  return value
}
function syncCompletion(value, code, library) {
  syncObservation(value, library, true)
  const status = value.counts.uncertain
    ? 'uncertain'
    : value.counts.conflict || value.counts.failed || !value.coverage.complete
      ? 'partial'
      : 'completed'
  if (value.status !== status || code !== (status === 'completed' ? 0 : 2))
    throw new Error('Synchronization exit/status disagree with its complete outcomes')
}
export async function synchronizeLibrary(io, input, human = false) {
  const library = registeredLibrary(await io.run(['library', 'status', '--json']))
  sameLibrary(input.library, library)
  const fresh = syncObservation(await io.run(syncArgs(library)), library)
  if (
    (human || input.reviewHash !== undefined) &&
    (typeof input.reviewHash !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(input.reviewHash) ||
      input.reviewHash !== (await syncReviewHash(fresh)))
  )
    throw new Error(
      'The complete reviewed synchronization plan changed or is missing. Review the fresh plan before confirming.',
    )
  const result = await io.run(
    syncArgs(library, true),
    { action: 'sync-library', library },
    true,
    (value, code) => syncCompletion(value, code, library),
  )
  const report = {
    action: 'sync-library',
    status: result.status,
    coverage: result.coverage,
    counts: result.counts,
    ...syncReport(result, true),
  }
  if (new TextEncoder().encode(JSON.stringify(report)).length > 6144)
    throw new Error(
      'Submitted synchronization report exceeds the complete action-result bound. Reconcile with the public Skillager CLI; no partial success is claimed.',
    )
  const uncertain =
    !result.coverage.complete || result.items.some((item) => item.outcome === 'uncertain')
  const reply = boundedManagementResult({
    outcome: uncertain
      ? 'uncertain'
      : result.status === 'partial'
        ? 'partial'
        : 'verified',
    ...report,
  })
  if (!uncertain) io.verified()
  return reply
}
