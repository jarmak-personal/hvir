import {
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react'

import {
  hostPath,
  hostPathEquals,
  joinHostPath,
  type DirEntry,
  type FileType,
  type HostPath,
} from '../../../shared'

export interface DirectoryTreeProps {
  readonly root: HostPath
  readonly rootLabel?: string
  readonly loadEntries: (path: HostPath) => Promise<readonly DirEntry[]>
  readonly resolveEntry?: (path: HostPath) => Promise<FileType>
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
  resolveEntry,
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
        resolveEntry={resolveEntry}
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
  readonly linked?: boolean
  readonly refreshVersion: number
  readonly showFiles: boolean
}

function DirectoryNode({
  path,
  label,
  depth,
  initiallyOpen = false,
  linked = false,
  loadEntries,
  resolveEntry,
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
              Number(right.type === 'dir' || right.type === 'symlink') -
                Number(left.type === 'dir' || left.type === 'symlink') ||
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
    <div className="tree-directory" role="none">
      <button
        type="button"
        role="treeitem"
        aria-expanded={open}
        aria-selected={isSelected}
        className={`tree-row directory-row${isSelected ? ' selected' : ''}${linked ? ' symlink-row' : ''}`}
        style={{ paddingLeft: 10 + depth * 14 }}
        onClick={() => {
          if (onSelectDirectory) {
            onSelectDirectory(stablePath)
            setOpen((value) => (isSelected ? !value : true))
          } else {
            setOpen((value) => !value)
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight') {
            event.preventDefault()
            if (open) focusFirstTreeChild(event.currentTarget)
            else setOpen(true)
          } else if (event.key === 'ArrowLeft') {
            event.preventDefault()
            if (open) setOpen(false)
            else focusParentTreeItem(event.currentTarget)
          } else {
            moveTreeFocus(event)
          }
        }}
        title={
          linked
            ? `${stablePath.path} · symbolic link to directory (target confined to project)`
            : stablePath.path
        }
      >
        <span className="tree-chevron">{open ? '⌄' : '›'}</span>
        {linked ? (
          <span className="tree-symlink" aria-hidden="true">
            ↗
          </span>
        ) : null}
        <span className="tree-name">{label}</span>
        {loading ? <span className="tree-loading">…</span> : null}
      </button>
      {open && error ? (
        <div className="tree-error" style={{ paddingLeft: 24 + depth * 14 }}>
          {error}
        </div>
      ) : null}
      {open ? (
        <div role="group">
          {entries.flatMap((entry) => {
            const child = joinHostPath(stablePath, entry.name)
            if (entry.type === 'dir') {
              return [
                <DirectoryNode
                  key={`${child.hostId}:${child.path}`}
                  path={child}
                  label={entry.name}
                  depth={depth + 1}
                  loadEntries={loadEntries}
                  resolveEntry={resolveEntry}
                  refreshVersion={refreshVersion}
                  selected={selected}
                  expandedPath={expandedPath}
                  showFiles={showFiles}
                  onSelectDirectory={onSelectDirectory}
                  onOpenFile={onOpenFile}
                />,
              ]
            }
            if (entry.type === 'symlink') {
              return [
                <SymlinkNode
                  key={`${child.hostId}:${child.path}`}
                  path={child}
                  label={entry.name}
                  depth={depth + 1}
                  loadEntries={loadEntries}
                  resolveEntry={resolveEntry}
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
            const openable = entry.type === 'file'
            return [
              <button
                type="button"
                role="treeitem"
                aria-selected={fileSelected}
                key={`${child.hostId}:${child.path}`}
                className={`tree-row file-row${fileSelected ? ' selected' : ''}`}
                style={{ paddingLeft: 24 + (depth + 1) * 14 }}
                onClick={() => openable && onOpenFile?.(child, false)}
                onDoubleClick={() => openable && onOpenFile?.(child, true)}
                onKeyDown={(event) => handleLeafTreeKey(event)}
                disabled={!openable}
                title={child.path}
              >
                <span className="tree-name">{entry.name}</span>
              </button>,
            ]
          })}
        </div>
      ) : null}
    </div>
  )
}

function SymlinkNode({
  path,
  label,
  depth,
  loadEntries,
  resolveEntry,
  refreshVersion,
  selected,
  expandedPath,
  showFiles,
  onSelectDirectory,
  onOpenFile,
}: DirectoryNodeProps): ReactElement | null {
  const stablePath = useMemo(
    () => hostPath(path.hostId, path.path),
    [path.hostId, path.path],
  )
  const [targetType, setTargetType] = useState<FileType>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (!resolveEntry) return
    let cancelled = false
    void resolveEntry(stablePath).then(
      (type) => {
        if (!cancelled) {
          setTargetType(type)
          setError(undefined)
        }
      },
      (reason: unknown) => {
        if (!cancelled) {
          setTargetType(undefined)
          setError(reason instanceof Error ? reason.message : String(reason))
        }
      },
    )
    return () => {
      cancelled = true
    }
  }, [refreshVersion, resolveEntry, stablePath])

  if (targetType === 'dir') {
    return (
      <DirectoryNode
        path={stablePath}
        label={label}
        depth={depth}
        linked
        loadEntries={loadEntries}
        resolveEntry={resolveEntry}
        refreshVersion={refreshVersion}
        selected={selected}
        expandedPath={expandedPath}
        showFiles={showFiles}
        onSelectDirectory={onSelectDirectory}
        onOpenFile={onOpenFile}
      />
    )
  }
  if (targetType === 'file') {
    if (!showFiles) return null
    const fileSelected = Boolean(selected && hostPathEquals(selected, stablePath))
    return (
      <button
        type="button"
        role="treeitem"
        aria-selected={fileSelected}
        className={`tree-row file-row symlink-row${fileSelected ? ' selected' : ''}`}
        style={{ paddingLeft: 24 + depth * 14 }}
        onClick={() => onOpenFile?.(stablePath, false)}
        onDoubleClick={() => onOpenFile?.(stablePath, true)}
        onKeyDown={(event) => handleLeafTreeKey(event)}
        title={`${stablePath.path} · symbolic link to file (target confined to project)`}
      >
        <span className="tree-symlink" aria-hidden="true">
          ↗
        </span>
        <span className="tree-name">{label}</span>
      </button>
    )
  }
  if (!resolveEntry && !showFiles) return null
  return (
    <button
      type="button"
      role="treeitem"
      className="tree-row file-row symlink-row"
      style={{ paddingLeft: 24 + depth * 14 }}
      disabled
      title={
        error
          ? `${stablePath.path} · ${error}`
          : targetType
            ? `${stablePath.path} · unsupported symbolic link target`
            : `${stablePath.path} · resolving link…`
      }
    >
      <span className="tree-symlink" aria-hidden="true">
        ↗
      </span>
      <span className="tree-name">{label}</span>
      {!error && !targetType ? <span className="tree-loading">…</span> : null}
    </button>
  )
}

function moveTreeFocus(event: KeyboardEvent<HTMLButtonElement>): void {
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
  const items = visibleTreeItems(event.currentTarget)
  const current = items.indexOf(event.currentTarget)
  if (current < 0 || items.length === 0) return
  event.preventDefault()
  const target =
    event.key === 'Home'
      ? items[0]
      : event.key === 'End'
        ? items.at(-1)
        : items[current + (event.key === 'ArrowDown' ? 1 : -1)]
  target?.focus()
}

function handleLeafTreeKey(event: KeyboardEvent<HTMLButtonElement>): void {
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    focusParentTreeItem(event.currentTarget)
    return
  }
  moveTreeFocus(event)
}

function focusFirstTreeChild(current: HTMLButtonElement): void {
  const directory = current.closest('.tree-directory')
  if (!directory) return
  const items = visibleTreeItems(current)
  const next = items[items.indexOf(current) + 1]
  if (next && directory.contains(next)) next.focus()
}

function focusParentTreeItem(current: HTMLButtonElement): void {
  const containingDirectory = current.closest('.tree-directory')
  if (!containingDirectory) return
  const parentDirectory = current.classList.contains('directory-row')
    ? containingDirectory.parentElement?.closest('.tree-directory')
    : containingDirectory
  parentDirectory
    ?.querySelector<HTMLButtonElement>(':scope > button[role="treeitem"]')
    ?.focus()
}

function visibleTreeItems(current: HTMLButtonElement): readonly HTMLButtonElement[] {
  const tree = current.closest('[role="tree"]')
  if (!tree) return []
  return [
    ...tree.querySelectorAll<HTMLButtonElement>('button[role="treeitem"]:not(:disabled)'),
  ].filter((item) => item.offsetParent !== null)
}

function containsPath(parent: HostPath, candidate: HostPath): boolean {
  if (parent.hostId !== candidate.hostId) return false
  if (parent.path === '/') return candidate.path.startsWith('/')
  return candidate.path === parent.path || candidate.path.startsWith(`${parent.path}/`)
}
