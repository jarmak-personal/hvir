/* global TextEncoder */
import {
  registeredLibrary,
  sameLibrary,
  initializationResult,
  boundedManagementJson,
  boundedManagementResult,
} from './management-contract.mjs'
import { initializationArgs, syncArgs } from './management-argv.mjs'
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
  boundedManagementJson(value)
  if (
    value.schema !==
      (apply ? 'skillager.library-sync.v1' : 'skillager.library-sync-status.v1') ||
    value.library?.library_id !== library.id ||
    value.library?.root !== library.root.path ||
    typeof value.coverage?.complete !== 'boolean'
  )
    throw new Error(
      'Complete synchronization identity/coverage is unavailable; reconcile public library status',
    )
  const items = apply ? value.items : value.candidates
  if (
    !Array.isArray(items) ||
    items.length > 32 ||
    items.some(
      (item) =>
        typeof item.source_identity !== 'string' || item.source_identity.length > 128,
    )
  )
    throw new Error(
      'Complete synchronization exceeds the supported 32-source report bound. Use the public Skillager CLI, then explicitly reconcile.',
    )
  const coverage = value.coverage
  if (
    [
      'discovered_origins',
      'approved_origins',
      'selected_sources',
      'processed_sources',
      'discovery_error_count',
    ].some((field) => !Number.isSafeInteger(coverage[field]) || coverage[field] < 0) ||
    coverage.selected_sources !== items.length ||
    coverage.processed_sources > coverage.selected_sources ||
    coverage.selected_sources > coverage.discovered_origins ||
    coverage.approved_origins > coverage.discovered_origins ||
    (coverage.complete &&
      (coverage.processed_sources !== coverage.selected_sources ||
        coverage.discovery_error_count !== 0)) ||
    new Set(items.map((item) => item.source_identity)).size !== items.length
  )
    throw new Error(
      'Synchronization coverage disagrees with its complete unique source report',
    )
  if (
    apply &&
    (!['completed', 'partial', 'uncertain'].includes(value.status) ||
      items.some(
        (item) =>
          ![
            'created',
            'updated',
            'unchanged',
            'skipped',
            'conflict',
            'failed',
            'uncertain',
          ].includes(item.outcome),
      ))
  )
    throw new Error('Synchronization has no complete supported per-item outcomes')
  if (!apply) {
    const maximum = items.map((item) => [
      item.source_identity,
      item.canonical_skill_id,
      'unchanged',
      'source-approval',
      'x'.repeat(96),
      'x'.repeat(32),
    ])
    if (
      new TextEncoder().encode(JSON.stringify(maximum)).length > 5120 ||
      new TextEncoder().encode(JSON.stringify(value.coverage)).length > 512
    )
      throw new Error(
        'Complete synchronization outcomes cannot fit the action-result bound. Use the public Skillager CLI; no synchronization was submitted.',
      )
  } else {
    const counts = {
      created: 0,
      updated: 0,
      unchanged: 0,
      skipped: 0,
      conflict: 0,
      failed: 0,
      uncertain: 0,
    }
    for (const item of items) counts[item.outcome]++
    if (Object.keys(counts).some((key) => value.counts?.[key] !== counts[key]))
      throw new Error(
        'Synchronization counts disagree with its complete per-item outcomes',
      )
  }
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
    columns: [
      'Source identity',
      'Canonical skill',
      'Outcome',
      'Phase',
      'Reason',
      'Repair',
    ],
    items: result.items.map((item) => [
      item.source_identity,
      item.canonical_skill_id,
      item.outcome,
      item.phase,
      item.reason_code,
      item.repair,
    ]),
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
