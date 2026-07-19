import { useState, type ReactElement } from 'react'

import {
  basenameHostPath,
  type DiffBase,
  type GitChangedFile,
  type GitChanges,
  type HostPath,
} from '../../../shared'
import { splitFileName } from '../tree/file-name'
import { displayGitParentPath } from './commit-file-tree'
import { gitChangeGroups } from './git-rail-model'
import { virtualRange } from './virtual-range'

const DETAIL_ROW_HEIGHT = 28

interface GitChangesViewProps {
  readonly root: HostPath
  readonly changes?: GitChanges
  readonly loading: boolean
  readonly error?: string
  readonly onOpen: (path: HostPath, base: DiffBase, untracked?: boolean) => void
}

export function GitChangesView({
  root,
  changes,
  loading,
  error,
  onOpen,
}: GitChangesViewProps): ReactElement {
  if (!changes) {
    return (
      <>
        {error ? <div className="tree-error">Changes unavailable: {error}</div> : null}
        {loading ? <div className="git-empty">Loading changes…</div> : null}
      </>
    )
  }
  let content: ReactElement
  if (changes.repositoryState === 'not-git') {
    content = <div className="git-empty">Not a Git repository</div>
  } else if (changes.workingTreeLimited) {
    content = (
      <>
        <GitChangeLimitNotice changes={changes} />
        {gitChangeGroups(changes).map((group) => (
          <ChangeGroup
            key={group.key}
            title={group.title}
            files={group.files}
            root={root}
            base={group.base}
            onOpen={onOpen}
            collapsible={group.collapsible}
          />
        ))}
      </>
    )
  } else if (changes.workingTree.length === 0 && changes.branchPoint.length === 0) {
    content = (
      <div className="git-empty">
        {changes.repositoryState === 'unborn'
          ? 'No commits yet · working tree clean'
          : 'Working tree clean'}
      </div>
    )
  } else {
    content = (
      <>
      {gitChangeGroups(changes).map((group) => (
        <ChangeGroup
          key={
            group.key === 'branch-point'
              ? `${root.hostId}:${root.path}:branch-point`
              : group.key
          }
          title={group.title}
          files={group.files}
          root={root}
          base={group.base}
          onOpen={onOpen}
          collapsible={group.collapsible}
        />
      ))}
      {!changes.branchPointAvailable ? (
        <div
          className="git-empty git-branch-unavailable"
          title={changes.branchPointUnavailableReason}
        >
          Branch point unavailable
        </div>
      ) : null}
      </>
    )
  }

  return (
    <>
      {error ? <div className="tree-error">Changes unavailable: {error}</div> : null}
      {content}
    </>
  )
}

function GitChangeLimitNotice({ changes }: { readonly changes: GitChanges }): ReactElement {
  return (
    <div className="git-limit-notice" role="status">
      {changes.workingTree.length >= (changes.workingTreeLimit ?? 2_000) ? (
        <>
          More than {changes.workingTreeLimit?.toLocaleString() ?? '2,000'} changes;
          showing the first {changes.workingTreeLimit?.toLocaleString() ?? '2,000'}.
        </>
      ) : (
        <>
          Git status exceeded the bounded output scan; showing{' '}
          {changes.workingTree.length.toLocaleString()} complete change records.
        </>
      )}{' '}
      Per-file statistics and branch-point detail are paused.
    </div>
  )
}

function ChangeGroup({
  title,
  files,
  root,
  base,
  onOpen,
  collapsible = false,
}: {
  readonly title: string
  readonly files: GitChanges['workingTree']
  readonly root: HostPath
  readonly base: DiffBase
  readonly onOpen: (path: HostPath, base: DiffBase, untracked?: boolean) => void
  readonly collapsible?: boolean
}): ReactElement {
  const [expanded, setExpanded] = useState(!collapsible)
  return (
    <div className={`git-group${collapsible ? ' branch-point' : ''}`}>
      <h3>
        {collapsible ? (
          <button
            type="button"
            className="git-group-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            <span className="git-group-chevron" aria-hidden="true">
              {expanded ? '⌄' : '›'}
            </span>
            <span>{title}</span>
            <span className="git-group-count">{files.length}</span>
          </button>
        ) : (
          <>
            <span>{title}</span>
            <span>{files.length}</span>
          </>
        )}
      </h3>
      {expanded ? (
        <VirtualChangeFiles files={files} root={root} base={base} onOpen={onOpen} />
      ) : null}
    </div>
  )
}

function VirtualChangeFiles({
  files,
  root,
  base,
  onOpen,
}: {
  readonly files: GitChanges['workingTree']
  readonly root: HostPath
  readonly base: DiffBase
  readonly onOpen: (path: HostPath, base: DiffBase, untracked?: boolean) => void
}): ReactElement {
  const [scrollTop, setScrollTop] = useState(0)
  const height = Math.min(280, files.length * DETAIL_ROW_HEIGHT)
  const { start, end } = virtualRange(
    files.length,
    DETAIL_ROW_HEIGHT,
    scrollTop,
    height,
    4,
  )
  return (
    <div
      className="git-change-files"
      style={{ height }}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div
        className="git-change-files-window"
        style={{ height: files.length * DETAIL_ROW_HEIGHT }}
      >
        {files.slice(start, end).map((file, offset) => {
          const index = start + offset
          const directory = displayGitParentPath(file.path, root)
          const name = splitFileName(basenameHostPath(file.path))
          const tone = gitChangeTone(file)
          return (
            <button
              type="button"
              className={`git-file git-status-${tone}`}
              key={`${file.path.hostId}:${file.path.path}`}
              style={{
                height: DETAIL_ROW_HEIGHT,
                transform: `translateY(${index * DETAIL_ROW_HEIGHT}px)`,
              }}
              onClick={() => onOpen(file.path, base, file.untracked)}
              title={file.path.path}
            >
              <span className="git-file-copy">
                <span className="git-file-name tree-file-name">
                  <span className="tree-file-stem">{name.stem}</span>
                  {name.extension ? (
                    <span className="tree-file-extension">{name.extension}</span>
                  ) : null}
                </span>
                {directory ? (
                  <span className="git-file-directory">{directory}</span>
                ) : null}
              </span>
              <small className={`git-change-summary ${tone}`}>
                <span className="git-change-marker">
                  {file.conflicted
                    ? '!'
                    : file.untracked
                      ? '?'
                      : file.staged && file.unstaged
                        ? '±'
                        : file.staged
                          ? 'S'
                          : 'M'}
                </span>{' '}
                {file.additions === undefined || file.deletions === undefined ? (
                  <span className="git-count-omitted" title="Line counts unavailable">
                    —
                  </span>
                ) : (
                  <>
                    <b>+{file.additions}</b> <i>-{file.deletions}</i>
                  </>
                )}
              </small>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function gitChangeTone(file: GitChangedFile): 'untracked' | 'modified' | 'conflict' {
  if (file.conflicted) return 'conflict'
  return file.untracked ? 'untracked' : 'modified'
}
