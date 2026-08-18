import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
} from 'react'

import {
  containsHostPath,
  hostPath,
  hostPathEquals,
  joinHostPath,
  type DirEntry,
  type FileType,
  type HostPath,
} from '../../../shared'
import { splitFileName } from './file-name'
import { compareDirectoryEntries } from './directory-entry-sort'
import { directoryEntriesEqual } from './git-ignore-refresh'
import {
  treeGitPathKey,
  type TreeDirectoryGitDecoration,
  type TreeFileGitDecoration,
  type TreeGitDecorations,
} from './git-status-decoration'
import { PathCopyMenu } from '../path-copy/PathCopyMenu'
import { usePathCopyMenu } from '../path-copy/use-path-copy-menu'

export interface DirectoryTreeEntryActions {
  readonly openFromPointer: (
    event: MouseEvent<HTMLElement>,
    target: HostPath,
    label: string,
    type: FileType,
  ) => void
  readonly openFromKeyboard: (
    event: KeyboardEvent<HTMLElement>,
    target: HostPath,
    label: string,
    type: FileType,
  ) => boolean
}

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
  readonly revealRequest?: DirectoryTreeRevealRequest
  readonly pathCopyRoot?: HostPath
  readonly entryActions?: DirectoryTreeEntryActions
  readonly showFiles?: boolean
  readonly onSelectDirectory?: (path: HostPath) => void
  readonly onOpenFile?: (
    path: HostPath,
    pinned: boolean,
    source: 'pointer' | 'keyboard',
  ) => void
  readonly onPointerActivate?: () => void
  readonly onExpandedChange?: (path: HostPath, expanded: boolean) => void
}

export interface DirectoryTreeRevealRequest {
  readonly path: HostPath
  readonly token: number
}

/**
 * Lazy host-qualified tree presentation shared by the active Files rail and
 * the pre-project folder picker. Callers own transport, confinement, and what
 * selecting a node means; the tree owns expansion/loading/error behavior and
 * performs scrolling only for an explicit reveal request.
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
  revealRequest,
  pathCopyRoot,
  entryActions,
  showFiles = true,
  onSelectDirectory,
  onOpenFile,
  onPointerActivate,
  onExpandedChange,
}: DirectoryTreeProps): ReactElement {
  const pathCopyMenu = usePathCopyMenu(pathCopyRoot)
  const actions =
    entryActions ??
    (pathCopyRoot
      ? {
          openFromPointer: (
            event: MouseEvent<HTMLElement>,
            target: HostPath,
            label: string,
          ) => pathCopyMenu.openFromPointer(event, target, label),
          openFromKeyboard: (
            event: KeyboardEvent<HTMLElement>,
            target: HostPath,
            label: string,
          ) => pathCopyMenu.openFromKeyboard(event, target, label),
        }
      : undefined)
  return (
    <>
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
          revealRequest={revealRequest}
          showFiles={showFiles}
          entryActions={actions}
          onSelectDirectory={onSelectDirectory}
          onOpenFile={onOpenFile}
          onPointerActivate={onPointerActivate}
          onExpandedChange={onExpandedChange}
        />
      </div>
      {pathCopyRoot && !entryActions ? (
        <PathCopyMenu workspaceRoot={pathCopyRoot} controller={pathCopyMenu} />
      ) : null}
    </>
  )
}

interface DirectoryNodeProps extends Omit<
  DirectoryTreeProps,
  'root' | 'rootLabel' | 'pathCopyRoot'
> {
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
  revealRequest,
  showFiles,
  entryActions,
  onSelectDirectory,
  onOpenFile,
  onPointerActivate,
  onExpandedChange,
}: DirectoryNodeProps): ReactElement {
  const stablePath = useMemo(
    () => hostPath(path.hostId, path.path),
    [path.hostId, path.path],
  )
  const shouldReveal = Boolean(
    revealRequest && containsHostPath(stablePath, revealRequest.path),
  )
  const [open, setOpen] = useState(initiallyOpen || shouldReveal)
  const [entries, setEntries] = useState<readonly DirEntry[]>([])
  const [ignoredNames, setIgnoredNames] = useState<ReadonlySet<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [loadedOnce, setLoadedOnce] = useState(false)
  const [error, setError] = useState<string>()
  const isSelected = Boolean(selected && hostPathEquals(selected, stablePath))
  const isRevealTarget = Boolean(
    revealRequest && hostPathEquals(revealRequest.path, stablePath),
  )
  const rowRef = useRef<HTMLButtonElement>(null)
  const gitDecoration = gitDecorations?.directories.get(treeGitPathKey(stablePath))
  const entryNames = useMemo(() => entries.map((entry) => entry.name), [entries])

  useEffect(() => {
    if (shouldReveal) setOpen(true)
  }, [shouldReveal])

  useEffect(() => {
    if (isSelected && isRevealTarget) {
      rowRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }, [isRevealTarget, isSelected, revealRequest?.token])

  useEffect(() => {
    onExpandedChange?.(stablePath, open)
    return () => {
      if (open) onExpandedChange?.(stablePath, false)
    }
  }, [onExpandedChange, open, stablePath])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    void loadEntries(stablePath)
      .then((nextEntries) => {
        if (cancelled) return
        const sortedEntries = [...nextEntries].sort(compareDirectoryEntries)
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
        if (!cancelled) {
          setLoading(false)
          setLoadedOnce(true)
        }
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
        ref={rowRef}
        type="button"
        role="treeitem"
        aria-expanded={open}
        aria-selected={isSelected}
        data-file-host={stablePath.hostId}
        data-file-path={stablePath.path}
        data-file-type={linked ? 'symlink' : 'dir'}
        className={`tree-row directory-row${isSelected ? ' selected' : ''}${linked ? ' symlink-row' : ''}${gitIgnored ? ' gitignored' : ''}${gitDecoration ? ` git-status-${gitDecoration.tone}` : ''}`}
        style={{ paddingLeft: 10 + depth * 14, zIndex: depth + 1 }}
        onContextMenu={(event) =>
          entryActions?.openFromPointer(
            event,
            stablePath,
            label,
            linked ? 'symlink' : 'dir',
          )
        }
        onClick={(event) => {
          if (onSelectDirectory) {
            onSelectDirectory(stablePath)
            setOpen((value) => (isSelected ? !value : true))
          } else {
            setOpen((value) => !value)
          }
          if (event.detail !== 0) onPointerActivate?.()
        }}
        onKeyDown={(event) => {
          if (
            entryActions?.openFromKeyboard(
              event,
              stablePath,
              label,
              linked ? 'symlink' : 'dir',
            )
          ) {
            return
          }
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
        {loading && !loadedOnce ? <span className="tree-loading">…</span> : null}
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
                  revealRequest={revealRequest}
                  showFiles={showFiles}
                  entryActions={entryActions}
                  onSelectDirectory={onSelectDirectory}
                  onOpenFile={onOpenFile}
                  onPointerActivate={onPointerActivate}
                  onExpandedChange={onExpandedChange}
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
                  revealRequest={revealRequest}
                  showFiles={showFiles}
                  entryActions={entryActions}
                  onSelectDirectory={onSelectDirectory}
                  onOpenFile={onOpenFile}
                  onPointerActivate={onPointerActivate}
                  onExpandedChange={onExpandedChange}
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
                data-file-host={child.hostId}
                data-file-path={child.path}
                data-file-type={entry.type}
                key={`${child.hostId}:${child.path}`}
                className={`tree-row file-row${fileSelected ? ' selected' : ''}${childGitIgnored ? ' gitignored' : ''}${fileGitDecoration ? ` git-status-${fileGitDecoration.tone}` : ''}`}
                style={{ paddingLeft: 24 + (depth + 1) * 14 }}
                onContextMenu={(event) =>
                  entryActions?.openFromPointer(event, child, entry.name, entry.type)
                }
                onClick={(event) =>
                  openable &&
                  onOpenFile?.(child, false, event.detail === 0 ? 'keyboard' : 'pointer')
                }
                onDoubleClick={() => openable && onOpenFile?.(child, true, 'pointer')}
                onKeyDown={(event) => {
                  if (
                    !entryActions?.openFromKeyboard(event, child, entry.name, entry.type)
                  ) {
                    handleLeafTreeKey(event)
                  }
                }}
                aria-disabled={!openable}
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
  revealRequest,
  showFiles,
  entryActions,
  onSelectDirectory,
  onOpenFile,
  onPointerActivate,
  onExpandedChange,
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
        revealRequest={revealRequest}
        showFiles={showFiles}
        entryActions={entryActions}
        onSelectDirectory={onSelectDirectory}
        onOpenFile={onOpenFile}
        onPointerActivate={onPointerActivate}
        onExpandedChange={onExpandedChange}
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
        data-file-host={stablePath.hostId}
        data-file-path={stablePath.path}
        data-file-type="symlink"
        className={`tree-row file-row symlink-row${fileSelected ? ' selected' : ''}${gitIgnored ? ' gitignored' : ''}${fileGitDecoration ? ` git-status-${fileGitDecoration.tone}` : ''}`}
        style={{ paddingLeft: 24 + depth * 14 }}
        onContextMenu={(event) =>
          entryActions?.openFromPointer(event, stablePath, label, 'symlink')
        }
        onClick={(event) =>
          onOpenFile?.(stablePath, false, event.detail === 0 ? 'keyboard' : 'pointer')
        }
        onDoubleClick={() => onOpenFile?.(stablePath, true, 'pointer')}
        onKeyDown={(event) => {
          if (!entryActions?.openFromKeyboard(event, stablePath, label, 'symlink')) {
            handleLeafTreeKey(event)
          }
        }}
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
      aria-disabled="true"
      data-file-host={stablePath.hostId}
      data-file-path={stablePath.path}
      data-file-type="symlink"
      className={`tree-row file-row symlink-row${gitIgnored ? ' gitignored' : ''}`}
      style={{ paddingLeft: 24 + depth * 14 }}
      onContextMenu={(event) =>
        entryActions?.openFromPointer(event, stablePath, label, 'symlink')
      }
      onKeyDown={(event) => {
        if (!entryActions?.openFromKeyboard(event, stablePath, label, 'symlink')) {
          handleLeafTreeKey(event)
        }
      }}
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

export function FileTreeName({ name }: { readonly name: string }): ReactElement {
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
