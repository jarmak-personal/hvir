import type { ReactElement } from 'react'

import type { HostConnectionState } from '../../../shared'
import { connectionStateCopy } from './connection-status'

export function RemoteConnectionBadge({
  state,
  hostLabel,
  compact = false,
}: {
  readonly state: HostConnectionState
  readonly hostLabel: string
  readonly compact?: boolean
}): ReactElement {
  const copy = connectionStateCopy(state)
  return (
    <span
      className={`remote-connection-badge ${state}`}
      aria-label={`${hostLabel} · ${copy.label}`}
      title={`${hostLabel} · ${copy.label}`}
    >
      <span className="remote-connection-mark" aria-hidden="true">
        {copy.mark}
      </span>
      <span className="remote-connection-host">{compact ? 'ssh' : hostLabel}</span>
    </span>
  )
}
