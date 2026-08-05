import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'

import {
  basenameHostPath,
  containsHostPath,
  GIT_CHANGE_DISPLAY_LIMIT,
  MAX_PROJECT_WATCH_INTERESTS,
  unwrapOperation,
  hostPath,
  type FileType,
  type GitChangedFile,
  type FileOpenContext,
  type HostPath,
} from '../../../shared'
import { DirectoryTree, type DirectoryTreeRevealRequest } from './DirectoryTree'
import { MissingWorkspaceNotice } from '../workspaces/MissingWorkspaceNotice'
import { buildTreeGitDecorations } from './git-status-decoration'
import { FilenameSearch } from './FilenameSearch'
import { FileCreateOverlays } from './FileCreateOverlays'
import { fileActionDestination, useFileCreateActions } from './use-file-create-actions'
import type { ViewerPathRebindCapability } from '../viewer/viewer-path-rebind'

const NO_CHANGED_FILES: readonly GitChangedFile[] = []

interface FileTreeProps {
  readonly root: HostPath
  readonly refreshVersion: number
  readonly searchRefreshVersion: number
  readonly ignoredRefreshVersion: number
  readonly changedFiles?: readonly GitChangedFile[]
  readonly gitChangesLimited?: boolean
  readonly selected?: HostPath
  readonly revealRequest?: DirectoryTreeRevealRequest
  readonly onOpen: (path: HostPath, pinned: boolean, context?: FileOpenContext) => void
  readonly viewerPathRebind: ViewerPathRebindCapability
  readonly onWorkspaceContentChanged: () => void
  readonly connected?: boolean
  readonly missing?: boolean
  readonly hidden?: boolean
  readonly gitEnabled?: boolean
  readonly watchInterestsLimited?: boolean
  readonly onExpandedChange?: (path: HostPath, expanded: boolean) => void
}

export function FileTree({
  root,
  refreshVersion,
  searchRefreshVersion,
  ignoredRefreshVersion,
  changedFiles = NO_CHANGED_FILES,
  gitChangesLimited = false,
  selected,
  revealRequest,
  onOpen,
  viewerPathRebind,
  onWorkspaceContentChanged,
  connected = true,
  missing = false,
  hidden = false,
  gitEnabled = true,
  watchInterestsLimited = false,
  onExpandedChange,
}: FileTreeProps): ReactElement {
  const [searchActive, setSearchActive] = useState(false)
  const [dropTarget, setDropTarget] = useState<HostPath>()
  const fileCreate = useFileCreateActions({
    root,
    onCreatedFile: onOpen,
    canRebindPath: viewerPathRebind.canRebindPath,
    onRebindPath: viewerPathRebind.rebindPath,
    onWorkspaceContentChanged,
  })
  useEffect(() => setDropTarget(undefined), [root.hostId, root.path])
  const gitDecorations = useMemo(
    () =>
      buildTreeGitDecorations(
        root,
        gitEnabled ? changedFiles : NO_CHANGED_FILES,
        gitEnabled && !gitChangesLimited,
      ),
    [changedFiles, gitChangesLimited, gitEnabled, root],
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
    <section className="rail-section files-panel" aria-label="Files" hidden={hidden}>
      {missing ? (
        <MissingWorkspaceNotice root={root} />
      ) : (
        <>
          <FilenameSearch
            root={root}
            connected={connected}
            gitIgnoreAvailable={gitEnabled}
            refreshVersion={searchRefreshVersion + fileCreate.refreshVersion}
            onActiveChange={setSearchActive}
            onOpen={onOpen}
          />
          <div
            className={`tree-scroll${dropTarget ? ' file-drop-active' : ''}`}
            hidden={searchActive}
            onContextMenu={(event) => fileCreate.openRootFromPointer(event)}
            onKeyDown={(event) => {
              if (!isPasteShortcut(event) || isEditableTarget(event.target)) return
              const target = fileTarget(event.target, root)
              if (!target) return
              event.preventDefault()
              event.stopPropagation()
              fileCreate.pasteFiles(target.path, target.type)
            }}
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes('Files')) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'copy'
              const target = fileTarget(event.target, root) ?? { path: root, type: 'dir' }
              setDropTarget(fileActionDestination(root, target.path, target.type))
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setDropTarget(undefined)
              }
            }}
            onDrop={(event) => {
              if (!event.dataTransfer.types.includes('Files')) return
              event.preventDefault()
              const target = fileTarget(event.target, root) ?? { path: root, type: 'dir' }
              setDropTarget(undefined)
              fileCreate.dropFiles(
                [...event.dataTransfer.files],
                target.path,
                target.type,
              )
            }}
          >
            {dropTarget ? (
              <div className="file-drop-target" role="status">
                Copy into {basenameHostPath(dropTarget) || dropTarget.path}
              </div>
            ) : null}
            {watchInterestsLimited ? (
              <div className="tree-scope-notice" role="status">
                Live updates are limited to the first{' '}
                {MAX_PROJECT_WATCH_INTERESTS.toLocaleString()} visible folders. Collapsed
                folders still load when opened.
              </div>
            ) : null}
            {gitEnabled && gitChangesLimited ? (
              <div className="tree-scope-notice" role="status">
                Per-file Git markers are hidden while the working tree exceeds{' '}
                {GIT_CHANGE_DISPLAY_LIMIT.toLocaleString()} changes.
              </div>
            ) : null}
            {connected ? (
              <DirectoryTree
                root={root}
                rootLabel={basenameHostPath(root) || root.path}
                loadEntries={loadProjectEntries}
                loadIgnoredEntries={gitEnabled ? loadIgnoredEntries : undefined}
                resolveEntry={resolveProjectEntry}
                refreshVersion={refreshVersion + fileCreate.refreshVersion}
                ignoredRefreshVersion={ignoredRefreshVersion}
                gitDecorations={gitDecorations}
                selected={fileCreate.selectedDirectory ?? selected}
                revealRequest={fileCreate.revealRequest ?? revealRequest}
                pathCopyRoot={root}
                entryActions={fileCreate.entryActions}
                onOpenFile={(path, pinned) => {
                  fileCreate.clearCreatedSelection()
                  onOpen(path, pinned)
                }}
                onExpandedChange={onExpandedChange}
              />
            ) : (
              <div className="tree-error">Reconnect to browse this host.</div>
            )}
          </div>
          <FileCreateOverlays controller={fileCreate} />
        </>
      )}
    </section>
  )
}

function fileTarget(
  value: EventTarget | null,
  root: HostPath,
): { readonly path: HostPath; readonly type: FileType } | undefined {
  if (!(value instanceof Element)) return undefined
  const row = value.closest<HTMLElement>('[data-file-path][data-file-type]')
  const path = row?.dataset.filePath
  const hostId = row?.dataset.fileHost
  const type = row?.dataset.fileType
  if (!path || hostId !== root.hostId || !isFileType(type)) return undefined
  const target = hostPath(root.hostId, path)
  return containsHostPath(root, target) ? { path: target, type } : undefined
}

function isFileType(value: unknown): value is FileType {
  return ['file', 'dir', 'symlink', 'other'].includes(String(value))
}

function isPasteShortcut(event: React.KeyboardEvent): boolean {
  return (
    event.key.toLowerCase() === 'v' &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey
  )
}

function isEditableTarget(value: EventTarget | null): boolean {
  return (
    value instanceof HTMLInputElement ||
    value instanceof HTMLTextAreaElement ||
    (value instanceof HTMLElement && value.isContentEditable)
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
