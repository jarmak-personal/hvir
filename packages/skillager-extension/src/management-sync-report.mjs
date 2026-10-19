/* global TextEncoder */
/** Summaries describe proved no-effect outcomes, never select the later CLI mutation. */
export function syncReport(value, apply = false) {
  const details = [],
    summary = { notApproved: 0, unchanged: 0 }
  for (const item of apply ? value.items : value.candidates) {
    const recovery = Object.keys(item).some(
      (key) => key.startsWith('recovery') && item[key] != null,
    )
    const safe =
      !recovery &&
      (apply
        ? item.repair === 'none'
        : item.repair === undefined || item.repair === 'none')
    if (
      safe &&
      item.reason_code === 'source-not-approved' &&
      (apply
        ? item.outcome === 'skipped' && item.phase === 'not-started'
        : item.state === 'skipped')
    )
      summary.notApproved++
    else if (
      safe &&
      item.reason_code === null &&
      (apply
        ? item.outcome === 'unchanged' && item.phase === 'accepted'
        : item.state === 'current')
    )
      summary.unchanged++
    else details.push(item)
  }
  if (details.length > 32)
    throw new Error(
      'Complete synchronization exceeds the supported 32-source detailed report bound. Use the public Skillager CLI, then explicitly reconcile.',
    )
  if (!apply) {
    const maximum = details.map((item) => [
      item.source_identity,
      item.canonical_skill_id,
      'unchanged',
      'source-approval',
      'x'.repeat(96),
      'x'.repeat(32),
      item.recovery_path ?? null,
    ])
    if (
      new TextEncoder().encode(JSON.stringify(maximum)).length > 5120 ||
      new TextEncoder().encode(JSON.stringify(value.coverage)).length > 512
    )
      throw new Error(
        'Complete synchronization outcomes cannot fit the action-result bound. Use the public Skillager CLI; no synchronization was submitted.',
      )
  }
  return {
    summary: {
      total: value.coverage.selected_sources,
      detailed: details.length,
      notApproved: { label: 'not approved for sync', count: summary.notApproved },
      unchanged: { label: 'unchanged', count: summary.unchanged },
    },
    columns: apply
      ? [
          'Source identity',
          'Canonical skill',
          'Outcome',
          'Phase',
          'Reason',
          'Repair',
          'Recovery path',
        ]
      : [
          'Source identity',
          'Canonical skill',
          'State',
          'Reason',
          'Repair',
          'Recovery path',
        ],
    items: details.map((item) =>
      apply
        ? [
            item.source_identity,
            item.canonical_skill_id,
            item.outcome,
            item.phase,
            item.reason_code,
            item.repair,
            item.recovery_path ?? null,
          ]
        : [
            item.source_identity,
            item.canonical_skill_id,
            item.state,
            item.reason_code,
            item.repair ?? null,
            item.recovery_path ?? null,
          ],
    ),
  }
}
