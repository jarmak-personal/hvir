import type { ReactElement } from 'react'

import type { HostConnectionState } from '../../../shared'

const statusCopy: Record<
  HostConnectionState,
  { readonly mark: string; readonly label: string }
> = {
  connected: { mark: '✓', label: 'Connected' },
  connecting: { mark: '…', label: 'Connecting' },
  reconnecting: { mark: '↻', label: 'Reconnecting' },
  failed: { mark: '×', label: 'Connection failed' },
  disconnected: { mark: '×', label: 'Disconnected' },
}

export function RemoteConnectionBadge({
  state,
  hostLabel,
}: {
  readonly state: HostConnectionState
  readonly hostLabel: string
}): ReactElement {
  const copy = statusCopy[state]
  return (
    <span
      className={`remote-connection-badge ${state}`}
      aria-label={`${hostLabel} · ${copy.label}`}
      title={`${hostLabel} · ${copy.label}`}
    >
      <span className="remote-connection-mark" aria-hidden="true">
        {copy.mark}
      </span>
      <span className="remote-connection-host">{hostLabel}</span>
    </span>
  )
}
