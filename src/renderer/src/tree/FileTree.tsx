import { useEffect, useState, type ReactElement } from 'react'

import {
  basenameHostPath,
  joinHostPath,
  type DirEntry,
  type HostPath,
} from '../../../shared'

interface FileTreeProps {
  readonly root: HostPath
  readonly refreshVersion: number
  readonly selected?: HostPath
  readonly onOpen: (path: HostPath, pinned: boolean) => void
}

export function FileTree({
  root,
  refreshVersion,
  selected,
  onOpen,
}: FileTreeProps): ReactElement {
  return (
    <section className="tree-panel" aria-label="Files">
      <header className="panel-header">
        <span>Files</span>
        <span className="panel-meta">{basenameHostPath(root)}</span>
      </header>
      <div className="tree-scroll">
        <Directory
          path={root}
          label={basenameHostPath(root) || root.path}
          depth={0}
          initiallyOpen
          refreshVersion={refreshVersion}
          selected={selected}
          onOpen={onOpen}
        />
      </div>
    </section>
  )
}

interface DirectoryProps {
  readonly path: HostPath
  readonly label: string
  readonly depth: number
  readonly initiallyOpen?: boolean
  readonly refreshVersion: number
  readonly selected?: HostPath
  readonly onOpen: (path: HostPath, pinned: boolean) => void
}

function Directory({
  path,
  label,
  depth,
  initiallyOpen = false,
  refreshVersion,
  selected,
  onOpen,
}: DirectoryProps): ReactElement {
  const [open, setOpen] = useState(initiallyOpen)
  const [entries, setEntries] = useState<readonly DirEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    void window.hvir
      .invoke('fs:readdir', { path })
      .then((nextEntries) => {
        if (cancelled) return
        setEntries(
          [...nextEntries].sort(
            (a, b) =>
              Number(b.type === 'dir') - Number(a.type === 'dir') ||
              a.name.localeCompare(b.name),
          ),
        )
        setError(undefined)
      })
      .catch((reason: unknown) => {
        if (!cancelled)
          setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, path, refreshVersion])

  return (
    <div className="tree-directory">
      <button
        className="tree-row directory-row"
        style={{ paddingLeft: 10 + depth * 14 }}
        onClick={() => setOpen((value) => !value)}
        title={path.path}
      >
        <span className="tree-chevron">{open ? '⌄' : '›'}</span>
        <span className="tree-name">{label}</span>
        {loading ? <span className="tree-loading">…</span> : null}
      </button>
      {open && error ? (
        <div className="tree-error" style={{ paddingLeft: 24 + depth * 14 }}>
          {error}
        </div>
      ) : null}
      {open
        ? entries.map((entry) => {
            const child = joinHostPath(path, entry.name)
            if (entry.type === 'dir') {
              return (
                <Directory
                  key={`${child.hostId}:${child.path}`}
                  path={child}
                  label={entry.name}
                  depth={depth + 1}
                  refreshVersion={refreshVersion}
                  selected={selected}
                  onOpen={onOpen}
                />
              )
            }
            const isSelected =
              selected?.hostId === child.hostId && selected.path === child.path
            return (
              <button
                key={`${child.hostId}:${child.path}`}
                className={`tree-row file-row${isSelected ? ' selected' : ''}`}
                style={{ paddingLeft: 24 + (depth + 1) * 14 }}
                onClick={() => entry.type === 'file' && onOpen(child, false)}
                onDoubleClick={() => entry.type === 'file' && onOpen(child, true)}
                disabled={entry.type !== 'file'}
                title={child.path}
              >
                <span className="tree-name">{entry.name}</span>
              </button>
            )
          })
        : null}
    </div>
  )
}
