import type { SessionsProjectionRow, SessionsUsageFact } from '../../../shared'

import type { SessionDetailsModel } from './SessionDetailsPopover'

/** One projection-owned presentation shared by every session-details surface. */
export function sessionDetailsModel(
  row: SessionsProjectionRow,
  usage?: SessionsUsageFact,
): SessionDetailsModel {
  return {
    title: row.title,
    provider: row.provider.name,
    profile:
      row.profile.status === 'available' || row.profile.status === 'stale'
        ? (row.profile.value.displayName ?? String(row.profile.value.id))
        : 'Unavailable',
    model: row.model,
    workspace: `${row.project.name} / ${row.workspace.name}`,
    host: `${row.host.label}${row.host.kind === 'ssh' ? ' · SSH' : ''}`,
    state:
      row.connectionState === 'connected'
        ? row.lifecycle
        : `${row.lifecycle} · ${row.connectionState}`,
    context: row.context,
    compactions: row.compactions ?? { status: 'unsupported' },
    freshness: row.telemetryFreshness,
    usage: usage ?? row.usage,
    pressurePolicy: row.provider.contextPressure,
  }
}
