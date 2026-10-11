import { boundedManagementJson } from './management-contract.mjs'

// Complete public read metadata; mutation report admission belongs to syncObservation.
export function publicSyncObservation(value, library, apply = false) {
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
    items.some(
      (item) =>
        typeof item.source_identity !== 'string' || item.source_identity.length > 128,
    )
  )
    throw new Error(
      'Complete synchronization has unsupported source identities; reconcile through public Skillager status.',
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
  return value
}
