import { useCallback, useMemo, type ReactElement } from 'react'

import {
  basenameHostPath,
  GIT_CHANGE_DISPLAY_LIMIT,
  MAX_PROJECT_WATCH_INTERESTS,
  unwrapOperation,
  type GitChangedFile,
  type HostPath,
} from '../../../shared'
import { DirectoryTree } from './DirectoryTree'
import { MissingWorkspaceNotice } from '../workspaces/MissingWorkspaceNotice'
import { buildTreeGitDecorations } from './git-status-decoration'

const NO_CHANGED_FILES: readonly GitChangedFile[] = []

interface FileTreeProps {
  readonly root: HostPath
  readonly refreshVersion: number
  readonly ignoredRefreshVersion: number
  readonly changedFiles?: readonly GitChangedFile[]
  readonly gitChangesLimited?: boolean
  readonly selected?: HostPath
  readonly onOpen: (path: HostPath, pinned: boolean) => void
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
  ignoredRefreshVersion,
  changedFiles = NO_CHANGED_FILES,
  gitChangesLimited = false,
  selected,
  onOpen,
  connected = true,
  missing = false,
  hidden = false,
  gitEnabled = true,
  watchInterestsLimited = false,
  onExpandedChange,
}: FileTreeProps): ReactElement {
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
    <section className="rail-section" aria-label="Files" hidden={hidden}>
      {missing ? (
        <MissingWorkspaceNotice root={root} />
      ) : (
        <div className="tree-scroll">
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
              refreshVersion={refreshVersion}
              ignoredRefreshVersion={ignoredRefreshVersion}
              gitDecorations={gitDecorations}
              selected={selected}
              onOpenFile={onOpen}
              onExpandedChange={onExpandedChange}
            />
          ) : (
            <div className="tree-error">Reconnect to browse this host.</div>
          )}
        </div>
      )}
    </section>
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
