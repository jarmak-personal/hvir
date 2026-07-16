import type { HostConnectionState } from '../../../shared'

const connectionStatusCopy: Record<
  HostConnectionState,
  { readonly mark: string; readonly label: string }
> = {
  connected: { mark: '✓', label: 'Connected' },
  connecting: { mark: '…', label: 'Connecting' },
  reconnecting: { mark: '↻', label: 'Reconnecting' },
  failed: { mark: '×', label: 'Connection failed' },
  disconnected: { mark: '×', label: 'Disconnected' },
}

export function connectionStateCopy(state: HostConnectionState): {
  readonly mark: string
  readonly label: string
} {
  return connectionStatusCopy[state]
}

export function connectionStateLabel(state: HostConnectionState): string {
  return connectionStatusCopy[state].label
}
