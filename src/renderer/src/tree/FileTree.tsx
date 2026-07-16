import { useCallback, useMemo, type ReactElement } from 'react'

import {
  basenameHostPath,
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
  readonly selected?: HostPath
  readonly onOpen: (path: HostPath, pinned: boolean) => void
  readonly connected?: boolean
  readonly missing?: boolean
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
  missing = false,
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
      {missing ? (
        <MissingWorkspaceNotice root={root} />
      ) : (
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
