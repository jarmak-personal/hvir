import type { ReactElement } from 'react'

import type { HostConnectionState } from '../../../shared'

const statusCopy: Record<
  HostConnectionState,
  { readonly short: string; readonly label: string }
> = {
  connected: { short: 'on', label: 'Connected' },
  connecting: { short: 'wait', label: 'Connecting' },
  reconnecting: { short: 'retry', label: 'Reconnecting' },
  failed: { short: 'err', label: 'Connection failed' },
  disconnected: { short: 'off', label: 'Disconnected' },
}

export function ConnectionStatus({
  state,
}: {
  readonly state: HostConnectionState
}): ReactElement {
  const copy = statusCopy[state]
  return (
    <span
      className={`connection-state ${state}`}
      aria-label={copy.label}
      title={copy.label}
    >
      {copy.short}
    </span>
  )
}
