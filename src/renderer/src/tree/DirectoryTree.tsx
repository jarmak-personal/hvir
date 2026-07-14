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
import { splitFileName } from './file-name'
import { directoryEntriesEqual } from './git-ignore-refresh'
import {
  treeGitPathKey,
  type TreeDirectoryGitDecoration,
  type TreeFileGitDecoration,
  type TreeGitDecorations,
} from './git-status-decoration'

export interface DirectoryTreeProps {
  readonly root: HostPath
  readonly rootLabel?: string
  readonly loadEntries: (path: HostPath) => Promise<readonly DirEntry[]>
  readonly loadIgnoredEntries?: (
    directory: HostPath,
    names: readonly string[],
  ) => Promise<ReadonlySet<string>>
  readonly resolveEntry?: (path: HostPath) => Promise<FileType>
  readonly refreshVersion?: number
  readonly ignoredRefreshVersion?: number
  readonly gitDecorations?: TreeGitDecorations
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
  loadIgnoredEntries,
  resolveEntry,
  refreshVersion = 0,
  ignoredRefreshVersion = 0,
  gitDecorations,
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
        loadIgnoredEntries={loadIgnoredEntries}
        resolveEntry={resolveEntry}
        refreshVersion={refreshVersion}
        ignoredRefreshVersion={ignoredRefreshVersion}
        gitDecorations={gitDecorations}
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
  readonly gitIgnored?: boolean
  readonly gitIgnoredRoot?: boolean
  readonly refreshVersion: number
  readonly ignoredRefreshVersion: number
  readonly showFiles: boolean
}

function DirectoryNode({
  path,
  label,
  depth,
  initiallyOpen = false,
  linked = false,
  gitIgnored = false,
  gitIgnoredRoot = false,
  loadEntries,
  loadIgnoredEntries,
  resolveEntry,
  refreshVersion,
  ignoredRefreshVersion,
  gitDecorations,
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
  const [ignoredNames, setIgnoredNames] = useState<ReadonlySet<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const isSelected = Boolean(selected && hostPathEquals(selected, stablePath))
  const gitDecoration = gitDecorations?.directories.get(treeGitPathKey(stablePath))
  const entryNames = useMemo(() => entries.map((entry) => entry.name), [entries])

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
        const sortedEntries = [...nextEntries].sort(
          (left, right) =>
            Number(right.type === 'dir' || right.type === 'symlink') -
              Number(left.type === 'dir' || left.type === 'symlink') ||
            left.name.localeCompare(right.name),
        )
        setEntries((current) =>
          directoryEntriesEqual(current, sortedEntries) ? current : sortedEntries,
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

  useEffect(() => {
    if (!open) return
    if (!loadIgnoredEntries || gitIgnored || entryNames.length === 0) {
      setIgnoredNames((current) => (current.size === 0 ? current : new Set()))
      return
    }
    let cancelled = false
    void loadIgnoredEntries(stablePath, entryNames).then(
      (nextIgnored) => {
        if (!cancelled) setIgnoredNames(nextIgnored)
      },
      () => {
        if (!cancelled) setIgnoredNames(new Set())
      },
    )
    return () => {
      cancelled = true
    }
  }, [
    entryNames,
    gitIgnored,
    ignoredRefreshVersion,
    loadIgnoredEntries,
    open,
    stablePath,
  ])

  return (
    <div className="tree-directory" role="none">
      <button
        type="button"
        role="treeitem"
        aria-expanded={open}
        aria-selected={isSelected}
        className={`tree-row directory-row${isSelected ? ' selected' : ''}${linked ? ' symlink-row' : ''}${gitIgnored ? ' gitignored' : ''}${gitDecoration ? ` git-status-${gitDecoration.tone}` : ''}`}
        style={{ paddingLeft: 10 + depth * 14, zIndex: depth + 1 }}
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
        title={`${
          linked
            ? `${stablePath.path} · symbolic link to directory (target confined to project)`
            : stablePath.path
        }${gitIgnored ? ' · Git ignored' : ''}`}
      >
        <TreeDepthGuides depth={depth} />
        <span className="tree-chevron">{open ? '⌄' : '›'}</span>
        {linked ? (
          <span className="tree-symlink" aria-hidden="true">
            ↗
          </span>
        ) : null}
        <span className="tree-name">{label}</span>
        {gitIgnoredRoot ? <span className="tree-gitignored">ignored</span> : null}
        {gitDecoration ? <DirectoryGitStatus decoration={gitDecoration} /> : null}
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
            const directlyIgnored = ignoredNames.has(entry.name)
            const childGitIgnored = gitIgnored || directlyIgnored
            const childGitIgnoredRoot = !gitIgnored && directlyIgnored
            if (entry.type === 'dir') {
              return [
                <DirectoryNode
                  key={`${child.hostId}:${child.path}`}
                  path={child}
                  label={entry.name}
                  depth={depth + 1}
                  gitIgnored={childGitIgnored}
                  gitIgnoredRoot={childGitIgnoredRoot}
                  loadEntries={loadEntries}
                  loadIgnoredEntries={loadIgnoredEntries}
                  resolveEntry={resolveEntry}
                  refreshVersion={refreshVersion}
                  ignoredRefreshVersion={ignoredRefreshVersion}
                  gitDecorations={gitDecorations}
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
                  gitIgnored={childGitIgnored}
                  gitIgnoredRoot={childGitIgnoredRoot}
                  loadEntries={loadEntries}
                  loadIgnoredEntries={loadIgnoredEntries}
                  resolveEntry={resolveEntry}
                  refreshVersion={refreshVersion}
                  ignoredRefreshVersion={ignoredRefreshVersion}
                  gitDecorations={gitDecorations}
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
            const fileGitDecoration = gitDecorations?.files.get(treeGitPathKey(child))
            return [
              <button
                type="button"
                role="treeitem"
                aria-selected={fileSelected}
                key={`${child.hostId}:${child.path}`}
                className={`tree-row file-row${fileSelected ? ' selected' : ''}${childGitIgnored ? ' gitignored' : ''}${fileGitDecoration ? ` git-status-${fileGitDecoration.tone}` : ''}`}
                style={{ paddingLeft: 24 + (depth + 1) * 14 }}
                onClick={() => openable && onOpenFile?.(child, false)}
                onDoubleClick={() => openable && onOpenFile?.(child, true)}
                onKeyDown={(event) => handleLeafTreeKey(event)}
                disabled={!openable}
                title={`${child.path}${childGitIgnored ? ' · Git ignored' : ''}`}
              >
                <TreeDepthGuides depth={depth + 1} />
                <FileTreeName name={entry.name} />
                {fileGitDecoration ? (
                  <FileGitStatus decoration={fileGitDecoration} />
                ) : null}
                {childGitIgnoredRoot ? (
                  <span className="tree-gitignored">ignored</span>
                ) : null}
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
  gitIgnored = false,
  gitIgnoredRoot = false,
  loadEntries,
  loadIgnoredEntries,
  resolveEntry,
  refreshVersion,
  ignoredRefreshVersion,
  gitDecorations,
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
        gitIgnored={gitIgnored}
        gitIgnoredRoot={gitIgnoredRoot}
        linked
        loadEntries={loadEntries}
        loadIgnoredEntries={loadIgnoredEntries}
        resolveEntry={resolveEntry}
        refreshVersion={refreshVersion}
        ignoredRefreshVersion={ignoredRefreshVersion}
        gitDecorations={gitDecorations}
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
    const fileGitDecoration = gitDecorations?.files.get(treeGitPathKey(stablePath))
    return (
      <button
        type="button"
        role="treeitem"
        aria-selected={fileSelected}
        className={`tree-row file-row symlink-row${fileSelected ? ' selected' : ''}${gitIgnored ? ' gitignored' : ''}${fileGitDecoration ? ` git-status-${fileGitDecoration.tone}` : ''}`}
        style={{ paddingLeft: 24 + depth * 14 }}
        onClick={() => onOpenFile?.(stablePath, false)}
        onDoubleClick={() => onOpenFile?.(stablePath, true)}
        onKeyDown={(event) => handleLeafTreeKey(event)}
        title={`${stablePath.path} · symbolic link to file (target confined to project)${gitIgnored ? ' · Git ignored' : ''}`}
      >
        <TreeDepthGuides depth={depth} />
        <span className="tree-symlink" aria-hidden="true">
          ↗
        </span>
        <FileTreeName name={label} />
        {fileGitDecoration ? <FileGitStatus decoration={fileGitDecoration} /> : null}
        {gitIgnoredRoot ? <span className="tree-gitignored">ignored</span> : null}
      </button>
    )
  }
  if (!resolveEntry && !showFiles) return null
  return (
    <button
      type="button"
      role="treeitem"
      className={`tree-row file-row symlink-row${gitIgnored ? ' gitignored' : ''}`}
      style={{ paddingLeft: 24 + depth * 14 }}
      disabled
      title={
        error
          ? `${stablePath.path} · ${error}${gitIgnored ? ' · Git ignored' : ''}`
          : targetType
            ? `${stablePath.path} · unsupported symbolic link target${gitIgnored ? ' · Git ignored' : ''}`
            : `${stablePath.path} · resolving link…${gitIgnored ? ' · Git ignored' : ''}`
      }
    >
      <TreeDepthGuides depth={depth} />
      <span className="tree-symlink" aria-hidden="true">
        ↗
      </span>
      <FileTreeName name={label} />
      {gitIgnoredRoot ? <span className="tree-gitignored">ignored</span> : null}
      {!error && !targetType ? <span className="tree-loading">…</span> : null}
    </button>
  )
}

function TreeDepthGuides({ depth }: { readonly depth: number }): ReactElement | null {
  if (depth <= 0) return null
  return (
    <span className="tree-depth-guides" aria-hidden="true">
      {Array.from({ length: depth }, (_, index) => (
        <span className="tree-depth-guide" key={index} />
      ))}
    </span>
  )
}

function FileTreeName({ name }: { readonly name: string }): ReactElement {
  const { stem, extension } = splitFileName(name)
  return (
    <span className="tree-name tree-file-name">
      <span className="tree-file-stem">{stem}</span>
      {extension ? <span className="tree-file-extension">{extension}</span> : null}
    </span>
  )
}

function FileGitStatus({
  decoration,
}: {
  readonly decoration: TreeFileGitDecoration
}): ReactElement {
  return (
    <span
      className={`tree-git-status file ${decoration.tone}`}
      aria-label={decoration.label}
      title={decoration.label}
    >
      {decoration.marker}
    </span>
  )
}

function DirectoryGitStatus({
  decoration,
}: {
  readonly decoration: TreeDirectoryGitDecoration
}): ReactElement {
  return (
    <span
      className={`tree-git-status directory ${decoration.tone}`}
      aria-label={decoration.label}
      title={decoration.label}
    >
      <span aria-hidden="true" />
    </span>
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
