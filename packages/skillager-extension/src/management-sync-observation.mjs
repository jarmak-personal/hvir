import { boundedManagementJson } from './management-contract.mjs'

// Complete public read metadata; mutation report admission belongs to syncObservation.
export function publicSyncObservation(value, library, apply = false) {
  boundedManagementJson(value)
  if (
    value.schema !==
      (apply ? 'skillager.library-sync.v1' : 'skillager.library-sync-status.v1') ||
    value.library?.library_id !== library.id ||
    !['system', 'disabled'].includes(value.library?.git_mode) ||
    (library.gitMode !== undefined && value.library.git_mode !== library.gitMode) ||
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
        !item ||
        typeof item.source_identity !== 'string' ||
        !item.source_identity ||
        item.source_identity.length > 128,
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
  const outcomes = [
    'created',
    'updated',
    'unchanged',
    'skipped',
    'conflict',
    'failed',
    'uncertain',
  ]
  if (
    (!apply && value.status !== undefined) ||
    (apply && !['completed', 'partial', 'uncertain'].includes(value.status)) ||
    items.some(
      (item) =>
        !(
          item.canonical_skill_id === null || typeof item.canonical_skill_id === 'string'
        ) ||
        !(item.reason_code === null || typeof item.reason_code === 'string') ||
        (apply
          ? !outcomes.includes(item.outcome) ||
            typeof item.phase !== 'string' ||
            !item.phase ||
            typeof item.repair !== 'string' ||
            !item.repair
          : ![
              'eligible-create',
              'eligible-update',
              'current',
              'skipped',
              'conflict',
              'failed',
              'unavailable',
            ].includes(item.state)) ||
        (item.recovery_path != null && typeof item.recovery_path !== 'string') ||
        Object.keys(item).some(
          (key) => key.startsWith('recovery') && key !== 'recovery_path',
        ) ||
        (item.accepted_hash != null && !/^[a-f0-9]{64}$/u.test(item.accepted_hash)) ||
        (item.origin_ids !== undefined &&
          (!Array.isArray(item.origin_ids) ||
            item.origin_ids.some((id) => typeof id !== 'string' || !id))) ||
        (item.lineage_id != null && typeof item.lineage_id !== 'string'),
    )
  )
    throw new Error('Synchronization has no complete supported per-item outcomes')
  if (apply) {
    const counts = Object.fromEntries(outcomes.map((key) => [key, 0]))
    for (const item of items) counts[item.outcome]++
    if (outcomes.some((key) => value.counts?.[key] !== counts[key]))
      throw new Error(
        'Synchronization counts disagree with its complete per-item outcomes',
      )
  }
  return value
}
