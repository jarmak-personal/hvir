import { useEffect, useMemo, useState, type ReactElement } from 'react'

import {
  hostPath,
  hostPathEquals,
  joinHostPath,
  type DirEntry,
  type HostPath,
} from '../../../shared'

export interface DirectoryTreeProps {
  readonly root: HostPath
  readonly rootLabel?: string
  readonly loadEntries: (path: HostPath) => Promise<readonly DirEntry[]>
  readonly refreshVersion?: number
  readonly selected?: HostPath
  readonly expandedPath?: HostPath
  readonly showFiles?: boolean
  readonly onSelectDirectory?: (path: HostPath) => void
  readonly onOpenFile?: (path: HostPath, pinned: boolean) => void
}

/**
 * Lazy host-qualified tree presentation shared by the active Files rail and
 * the pre-project folder picker. Callers own transport, confinement, and what
 * selecting a node means; the tree owns expansion/loading/error behavior.
 */
export function DirectoryTree({
  root,
  rootLabel = root.path,
  loadEntries,
  refreshVersion = 0,
  selected,
  expandedPath,
  showFiles = true,
  onSelectDirectory,
  onOpenFile,
}: DirectoryTreeProps): ReactElement {
  return (
    <div className="directory-tree" role="tree">
      <DirectoryNode
        path={root}
        label={rootLabel}
        depth={0}
        initiallyOpen
        loadEntries={loadEntries}
        refreshVersion={refreshVersion}
        selected={selected}
        expandedPath={expandedPath}
        showFiles={showFiles}
        onSelectDirectory={onSelectDirectory}
        onOpenFile={onOpenFile}
      />
    </div>
  )
}

interface DirectoryNodeProps extends Omit<DirectoryTreeProps, 'root' | 'rootLabel'> {
  readonly path: HostPath
  readonly label: string
  readonly depth: number
  readonly initiallyOpen?: boolean
  readonly refreshVersion: number
  readonly showFiles: boolean
}

function DirectoryNode({
  path,
  label,
  depth,
  initiallyOpen = false,
  loadEntries,
  refreshVersion,
  selected,
  expandedPath,
  showFiles,
  onSelectDirectory,
  onOpenFile,
}: DirectoryNodeProps): ReactElement {
  const stablePath = useMemo(
    () => hostPath(path.hostId, path.path),
    [path.hostId, path.path],
  )
  const shouldReveal = Boolean(expandedPath && containsPath(stablePath, expandedPath))
  const [open, setOpen] = useState(initiallyOpen || shouldReveal)
  const [entries, setEntries] = useState<readonly DirEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const isSelected = Boolean(selected && hostPathEquals(selected, stablePath))

  useEffect(() => {
    if (shouldReveal) setOpen(true)
  }, [shouldReveal])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    void loadEntries(stablePath)
      .then((nextEntries) => {
        if (cancelled) return
        setEntries(
          [...nextEntries].sort(
            (left, right) =>
              Number(right.type === 'dir') - Number(left.type === 'dir') ||
              left.name.localeCompare(right.name),
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
  }, [loadEntries, open, refreshVersion, stablePath])

  return (
    <div className="tree-directory" role="treeitem" aria-expanded={open}>
      <button
        type="button"
        className={`tree-row directory-row${isSelected ? ' selected' : ''}`}
        style={{ paddingLeft: 10 + depth * 14 }}
        onClick={() => {
          if (onSelectDirectory) {
            onSelectDirectory(stablePath)
            setOpen((value) => (isSelected ? !value : true))
          } else {
            setOpen((value) => !value)
          }
        }}
        title={stablePath.path}
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
        ? entries.flatMap((entry) => {
            const child = joinHostPath(stablePath, entry.name)
            if (entry.type === 'dir') {
              return [
                <DirectoryNode
                  key={`${child.hostId}:${child.path}`}
                  path={child}
                  label={entry.name}
                  depth={depth + 1}
                  loadEntries={loadEntries}
                  refreshVersion={refreshVersion}
                  selected={selected}
                  expandedPath={expandedPath}
                  showFiles={showFiles}
                  onSelectDirectory={onSelectDirectory}
                  onOpenFile={onOpenFile}
                />,
              ]
            }
            if (!showFiles) return []
            const fileSelected = Boolean(selected && hostPathEquals(selected, child))
            return [
              <button
                type="button"
                key={`${child.hostId}:${child.path}`}
                className={`tree-row file-row${fileSelected ? ' selected' : ''}`}
                style={{ paddingLeft: 24 + (depth + 1) * 14 }}
                onClick={() => entry.type === 'file' && onOpenFile?.(child, false)}
                onDoubleClick={() => entry.type === 'file' && onOpenFile?.(child, true)}
                disabled={entry.type !== 'file'}
                title={child.path}
              >
                <span className="tree-name">{entry.name}</span>
              </button>,
            ]
          })
        : null}
    </div>
  )
}

function containsPath(parent: HostPath, candidate: HostPath): boolean {
  if (parent.hostId !== candidate.hostId) return false
  if (parent.path === '/') return candidate.path.startsWith('/')
  return candidate.path === parent.path || candidate.path.startsWith(`${parent.path}/`)
}
