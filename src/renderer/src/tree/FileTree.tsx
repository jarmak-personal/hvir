import { useCallback, useMemo, type ReactElement } from 'react'

import {
  basenameHostPath,
  unwrapOperation,
  type GitChangedFile,
  type HostConnectionState,
  type HostPath,
  type HostWatchTier,
} from '../../../shared'
import { DirectoryTree } from './DirectoryTree'
import { ConnectionStatus } from '../workspaces/ConnectionStatus'
import { buildTreeGitDecorations } from './git-status-decoration'

const NO_CHANGED_FILES: readonly GitChangedFile[] = []

interface FileTreeProps {
  readonly root: HostPath
  readonly refreshVersion: number
  readonly ignoredRefreshVersion: number
  readonly changedFiles?: readonly GitChangedFile[]
  readonly selected?: HostPath
  readonly onOpen: (path: HostPath, pinned: boolean) => void
  readonly connected?: boolean
  readonly hidden?: boolean
}

export function FileTree({
  root,
  refreshVersion,
  ignoredRefreshVersion,
  changedFiles = NO_CHANGED_FILES,
  selected,
  onOpen,
  connected = true,
  hidden = false,
}: FileTreeProps): ReactElement {
  const gitDecorations = useMemo(
    () => buildTreeGitDecorations(root, changedFiles),
    [changedFiles, root],
  )
  const loadIgnoredEntries = useCallback(
    async (
      directory: HostPath,
      names: readonly string[],
    ): Promise<ReadonlySet<string>> => {
      const ignored = new Set<string>()
      try {
        for (let index = 0; index < names.length; index += 512) {
          const result = await window.hvir.invoke('git:ignored-entries', {
            root,
            directory,
            names: names.slice(index, index + 512),
          })
          for (const name of result.ignoredNames) ignored.add(name)
        }
      } catch {
        // Git decoration is optional; filesystem browsing remains available.
      }
      return ignored
    },
    [root],
  )

  return (
    <section className="rail-section" aria-label="Files" hidden={hidden}>
      <header className="panel-header">
        <span className="panel-meta">{basenameHostPath(root)}</span>
      </header>
      <div className="tree-scroll">
        {connected ? (
          <DirectoryTree
            root={root}
            rootLabel={basenameHostPath(root) || root.path}
            loadEntries={loadProjectEntries}
            loadIgnoredEntries={loadIgnoredEntries}
            resolveEntry={resolveProjectEntry}
            refreshVersion={refreshVersion}
            ignoredRefreshVersion={ignoredRefreshVersion}
            gitDecorations={gitDecorations}
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
      <ConnectionStatus state={connectionState} />
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

function resolveProjectEntry(path: HostPath) {
  return window.hvir
    .invoke('fs:resolve-entry', { path })
    .then(unwrapOperation)
    .then((result) => result.type)
}
