import type { ReactElement } from 'react'

import {
  basenameHostPath,
  unwrapOperation,
  type HostPath,
  type HostConnectionState,
  type HostWatchTier,
} from '../../../shared'
import { DirectoryTree } from './DirectoryTree'

interface FileTreeProps {
  readonly root: HostPath
  readonly refreshVersion: number
  readonly selected?: HostPath
  readonly onOpen: (path: HostPath, pinned: boolean) => void
  readonly onShowGit?: () => void
  readonly changedCount?: number
  readonly connectionState?: HostConnectionState
  readonly watchTier?: HostWatchTier
  readonly sessionLabel: string
  readonly onChangeSession: () => void
  readonly onDisconnectSession: () => void
  readonly onReconnectSession: () => void
  readonly sessionBusy?: boolean
  readonly sessionError?: string
}

export function FileTree({
  root,
  refreshVersion,
  selected,
  onOpen,
  onShowGit,
  changedCount = 0,
  connectionState = 'connected',
  watchTier = 'native',
  sessionLabel,
  onChangeSession,
  onDisconnectSession,
  onReconnectSession,
  sessionBusy = false,
  sessionError,
}: FileTreeProps): ReactElement {
  return (
    <section className="tree-panel" aria-label="Files">
      <SessionBar
        label={sessionLabel}
        remote={root.hostId !== 'local'}
        connectionState={connectionState}
        watchTier={watchTier}
        onChange={onChangeSession}
        onDisconnect={onDisconnectSession}
        onReconnect={onReconnectSession}
        busy={sessionBusy}
        error={sessionError}
      />
      <header className="panel-header">
        <span>Files</span>
        <span className="panel-meta">{basenameHostPath(root)}</span>
        {onShowGit ? (
          <button className="rail-switch" type="button" onClick={onShowGit}>
            Git{changedCount > 0 ? ` ${changedCount}` : ''}
          </button>
        ) : null}
      </header>
      <div className="tree-scroll">
        {connectionState === 'connected' ? (
          <DirectoryTree
            root={root}
            rootLabel={basenameHostPath(root) || root.path}
            loadEntries={loadProjectEntries}
            refreshVersion={refreshVersion}
            selected={selected}
            onOpenFile={onOpen}
          />
        ) : (
          <div className="tree-error">Reconnect to browse this host.</div>
        )}
      </div>
    </section>
  )
}

export function SessionBar({
  label,
  remote,
  connectionState,
  watchTier,
  onChange,
  onDisconnect,
  onReconnect,
  busy,
  error,
}: {
  readonly label: string
  readonly remote: boolean
  readonly connectionState: HostConnectionState
  readonly watchTier: HostWatchTier
  readonly onChange: () => void
  readonly onDisconnect: () => void
  readonly onReconnect: () => void
  readonly busy: boolean
  readonly error?: string
}): ReactElement {
  const disconnected = connectionState === 'disconnected' || connectionState === 'failed'
  return (
    <div
      className="session-bar"
      title={error ?? `${label} · ${connectionState} · ${watchTier}`}
    >
      <span className={`connection-state ${connectionState}`} />
      <span className="session-copy">
        <strong>{label}</strong>
        <small className={error ? 'error' : ''}>{error ?? connectionState}</small>
      </span>
      <span className="session-actions">
        <button type="button" onClick={onChange} disabled={busy}>
          Change
        </button>
        {remote ? (
          <button
            type="button"
            onClick={disconnected ? onReconnect : onDisconnect}
            disabled={busy}
          >
            {busy ? 'Working…' : disconnected ? 'Reconnect' : 'Disconnect'}
          </button>
        ) : null}
      </span>
    </div>
  )
}

function loadProjectEntries(path: HostPath) {
  return window.hvir.invoke('fs:readdir', { path }).then(unwrapOperation)
}
