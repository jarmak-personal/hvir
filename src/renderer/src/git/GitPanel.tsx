import { useEffect, useRef, useState, type ReactElement } from 'react'

import {
  basenameHostPath,
  type DiffBase,
  type GitChanges,
  type GitCommitSummary,
  type GitCommitDetail,
  type GitRepositoryState,
  type HostPath,
  type HostConnectionState,
} from '../../../shared'
import { virtualRange } from './virtual-range'

interface GitPanelProps {
  readonly root: HostPath
  readonly refreshVersion: number
  readonly historyRefreshVersion: number
  readonly onOpen: (path: HostPath, base: DiffBase, revision?: string) => void
  readonly onChangedCount: (count: number) => void
  readonly connectionState?: HostConnectionState
  readonly hidden?: boolean
}

export function GitPanel({
  root,
  refreshVersion,
  historyRefreshVersion,
  onOpen,
  onChangedCount,
  connectionState = 'connected',
  hidden = false,
}: GitPanelProps): ReactElement {
  const [view, setView] = useState<'changes' | 'history'>('changes')
  const [changes, setChanges] = useState<GitChanges>()
  const [commits, setCommits] = useState<readonly GitCommitSummary[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [historyCursor, setHistoryCursor] = useState<string>()
  const [changesError, setChangesError] = useState<string>()
  const [historyError, setHistoryError] = useState<string>()
  const [detailError, setDetailError] = useState<{
    readonly hash: string
    readonly message: string
  }>()
  const [detail, setDetail] = useState<GitCommitDetail>()
  const [changesLoading, setChangesLoading] = useState(false)
  const [historyInitialLoading, setHistoryInitialLoading] = useState(false)
  const [historyRepositoryState, setHistoryRepositoryState] =
    useState<GitRepositoryState>()
  const [detailLoadingHash, setDetailLoadingHash] = useState<string>()
  const historyLoading = useRef(false)
  const historyGeneration = useRef(0)
  const detailGeneration = useRef(0)

  useEffect(() => {
    setChanges(undefined)
    setCommits([])
    setHasMore(false)
    setHistoryCursor(undefined)
    setDetail(undefined)
    setDetailLoadingHash(undefined)
    setChangesLoading(false)
    setHistoryInitialLoading(false)
    setHistoryRepositoryState(undefined)
    setChangesError(undefined)
    setHistoryError(undefined)
    setDetailError(undefined)
    onChangedCount(0)
    historyGeneration.current += 1
    detailGeneration.current += 1
  }, [connectionState, onChangedCount, root.hostId, root.path])

  useEffect(() => {
    if (connectionState !== 'connected') return
    let cancelled = false
    setChangesLoading(true)
    setChangesError(undefined)
    void window.hvir.invoke('git:changes', { root }).then(
      (result) => {
        if (!cancelled) {
          setChanges(result)
          setChangesLoading(false)
          setChangesError(undefined)
          onChangedCount(result.workingTree.length)
        }
      },
      (reason: unknown) => {
        if (!cancelled) {
          setChanges(undefined)
          setChangesLoading(false)
          onChangedCount(0)
          setChangesError(reason instanceof Error ? reason.message : String(reason))
        }
      },
    )
    return () => {
      cancelled = true
    }
  }, [connectionState, onChangedCount, refreshVersion, root])

  const loadHistory = (): void => {
    if (
      connectionState !== 'connected' ||
      historyLoading.current ||
      !hasMore ||
      !historyCursor
    )
      return
    historyLoading.current = true
    setHistoryError(undefined)
    const generation = historyGeneration.current
    const cursor = historyCursor
    void window.hvir
      .invoke('git:history', { root, cursor, limit: 50 })
      .then(
        (page) => {
          if (generation !== historyGeneration.current) return
          setCommits((current) => {
            const seen = new Set(current.map((commit) => commit.hash))
            return [
              ...current,
              ...page.commits.filter((commit) => !seen.has(commit.hash)),
            ]
          })
          setHasMore(page.hasMore)
          setHistoryCursor(page.nextCursor)
          setHistoryRepositoryState(page.repositoryState)
          setHistoryError(undefined)
        },
        (reason: unknown) => {
          if (generation === historyGeneration.current) {
            setHistoryError(reason instanceof Error ? reason.message : String(reason))
          }
        },
      )
      .finally(() => {
        if (generation === historyGeneration.current) historyLoading.current = false
      })
  }

  useEffect(() => {
    if (view !== 'history' || connectionState !== 'connected') return
    let cancelled = false
    const generation = ++historyGeneration.current
    detailGeneration.current += 1
    historyLoading.current = false
    setCommits([])
    setHasMore(false)
    setHistoryCursor(undefined)
    setHistoryRepositoryState(undefined)
    setDetail(undefined)
    setDetailLoadingHash(undefined)
    setHistoryInitialLoading(true)
    setHistoryError(undefined)
    setDetailError(undefined)
    void window.hvir.invoke('git:history', { root, limit: 50 }).then(
      (page) => {
        if (!cancelled && generation === historyGeneration.current) {
          setCommits(page.commits)
          setHasMore(page.hasMore)
          setHistoryCursor(page.nextCursor)
          setHistoryRepositoryState(page.repositoryState)
          setHistoryError(undefined)
          setHistoryInitialLoading(false)
        }
      },
      (reason: unknown) => {
        if (!cancelled) {
          setHasMore(false)
          setHistoryCursor(undefined)
          setHistoryInitialLoading(false)
          setHistoryError(reason instanceof Error ? reason.message : String(reason))
        }
      },
    )
    return () => {
      cancelled = true
    }
  }, [connectionState, historyRefreshVersion, root, view])

  const toggleCommitDetail = (commit: GitCommitSummary): void => {
    const generation = ++detailGeneration.current
    if (detail?.hash === commit.hash || detailLoadingHash === commit.hash) {
      setDetail(undefined)
      setDetailLoadingHash(undefined)
      return
    }
    setDetail(undefined)
    setDetailLoadingHash(commit.hash)
    setDetailError(undefined)
    void window.hvir.invoke('git:commit-detail', { root, hash: commit.hash }).then(
      (result) => {
        if (generation !== detailGeneration.current) return
        setDetail(result)
        setDetailLoadingHash(undefined)
        setDetailError(undefined)
      },
      (reason: unknown) => {
        if (generation !== detailGeneration.current) return
        setDetailLoadingHash(undefined)
        setDetailError({
          hash: commit.hash,
          message: reason instanceof Error ? reason.message : String(reason),
        })
      },
    )
  }

  return (
    <section className="rail-section git-panel" aria-label="Git" hidden={hidden}>
      <header className="panel-header">
        <span className="panel-meta">{basenameHostPath(root)}</span>
      </header>
      <div className="git-tabs">
        <button
          type="button"
          className={view === 'changes' ? 'active' : ''}
          disabled={connectionState !== 'connected'}
          onClick={() => setView('changes')}
        >
          Changes {changes ? `(${changes.workingTree.length})` : ''}
        </button>
        <button
          type="button"
          className={view === 'history' ? 'active' : ''}
          disabled={connectionState !== 'connected'}
          onClick={() => setView('history')}
        >
          History
        </button>
      </div>
      <div
        className={`tree-scroll git-scroll${view === 'history' ? ' history-active' : ''}`}
      >
        {connectionState !== 'connected' ? (
          <div className="git-empty">Reconnect to inspect Git.</div>
        ) : view === 'changes' ? (
          <>
            {changesError ? (
              <div className="tree-error">Changes unavailable: {changesError}</div>
            ) : !changes && changesLoading ? (
              <div className="git-empty">Loading changes…</div>
            ) : changes?.repositoryState === 'not-git' ? (
              <div className="git-empty">Not a Git repository</div>
            ) : changes &&
              changes.workingTree.length === 0 &&
              changes.branchPoint.length === 0 ? (
              <div className="git-empty">
                {changes.repositoryState === 'unborn'
                  ? 'No commits yet · working tree clean'
                  : 'Working tree clean'}
              </div>
            ) : (
              <>
                <ChangeGroup
                  title="Working tree"
                  files={changes?.workingTree ?? []}
                  base="head"
                  root={root}
                  onOpen={onOpen}
                />
                {changes?.branchPointAvailable ? (
                  <ChangeGroup
                    title="Branch point"
                    files={changes.branchPoint}
                    base="branch-point"
                    root={root}
                    onOpen={onOpen}
                  />
                ) : changes ? (
                  <div
                    className="git-empty git-branch-unavailable"
                    title={changes.branchPointUnavailableReason}
                  >
                    Branch point unavailable
                  </div>
                ) : null}
              </>
            )}
          </>
        ) : (
          <div className="git-history">
            {historyError ? (
              <div className="tree-error">History unavailable: {historyError}</div>
            ) : null}
            {historyInitialLoading ? (
              <div className="git-empty">Loading history…</div>
            ) : !historyError && historyRepositoryState === 'not-git' ? (
              <div className="git-empty">Not a Git repository</div>
            ) : !historyError && commits.length === 0 ? (
              <div className="git-empty">
                {historyRepositoryState === 'unborn' ? 'No commits yet' : 'No history'}
              </div>
            ) : null}
            {detailLoadingHash ? (
              <div className="git-detail-loading">Loading commit…</div>
            ) : null}
            {detailError ? (
              <div className="tree-error git-detail-error">
                Commit unavailable: {detailError.message}
              </div>
            ) : null}
            {detail ? (
              <CommitDetailPanel detail={detail} root={root} onOpen={onOpen} />
            ) : null}
            {commits.length > 0 ? (
              <HistoryCommitList
                commits={commits}
                selectedHash={detail?.hash ?? detailLoadingHash ?? detailError?.hash}
                expandedHash={detail?.hash}
                hasMore={hasMore}
                onSelect={toggleCommitDetail}
                onLoadMore={loadHistory}
              />
            ) : null}
          </div>
        )}
      </div>
    </section>
  )
}

const HISTORY_ROW_HEIGHT = 48
const HISTORY_OVERSCAN = 8
const DETAIL_ROW_HEIGHT = 28

function HistoryCommitList({
  commits,
  selectedHash,
  expandedHash,
  hasMore,
  onSelect,
  onLoadMore,
}: {
  readonly commits: readonly GitCommitSummary[]
  readonly selectedHash?: string
  readonly expandedHash?: string
  readonly hasMore: boolean
  readonly onSelect: (commit: GitCommitSummary) => void
  readonly onLoadMore: () => void
}): ReactElement {
  const viewport = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(320)

  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const update = (): void => setViewportHeight(element.clientHeight)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const element = viewport.current
    if (!element || !hasMore) return
    if (element.scrollHeight <= element.clientHeight + HISTORY_ROW_HEIGHT) {
      onLoadMore()
    }
  }, [commits.length, hasMore, onLoadMore])

  const { start, end } = virtualRange(
    commits.length,
    HISTORY_ROW_HEIGHT,
    scrollTop,
    viewportHeight,
    HISTORY_OVERSCAN,
  )

  return (
    <div
      ref={viewport}
      className="git-history-viewport"
      role="list"
      aria-label="Commit history"
      onScroll={(event) => {
        const element = event.currentTarget
        setScrollTop(element.scrollTop)
        if (
          hasMore &&
          element.scrollHeight - element.scrollTop - element.clientHeight <
            HISTORY_ROW_HEIGHT * 4
        ) {
          onLoadMore()
        }
      }}
    >
      <div
        className="git-history-window"
        style={{ height: commits.length * HISTORY_ROW_HEIGHT }}
      >
        {commits.slice(start, end).map((commit, offset) => {
          const index = start + offset
          const selected = selectedHash === commit.hash
          return (
            <div
              className="git-commit-entry"
              key={commit.hash}
              role="listitem"
              aria-posinset={index + 1}
              aria-setsize={hasMore ? -1 : commits.length}
              style={{
                height: HISTORY_ROW_HEIGHT,
                transform: `translateY(${index * HISTORY_ROW_HEIGHT}px)`,
              }}
            >
              <button
                type="button"
                className={`git-commit${selected ? ' active' : ''}`}
                aria-current={selected || undefined}
                aria-expanded={selected ? expandedHash === commit.hash : undefined}
                aria-controls={
                  expandedHash === commit.hash
                    ? `git-commit-detail-${commit.hash}`
                    : undefined
                }
                onClick={() => onSelect(commit)}
              >
                <strong>{commit.subject || '(no subject)'}</strong>
                <span>
                  {commit.shortHash} · {commit.author}
                </span>
              </button>
            </div>
          )
        })}
      </div>
      {hasMore ? (
        <button type="button" className="git-load-more" onClick={onLoadMore}>
          Load more
        </button>
      ) : null}
    </div>
  )
}

function CommitDetailPanel({
  detail,
  root,
  onOpen,
}: {
  readonly detail: GitCommitDetail
  readonly root: HostPath
  readonly onOpen: (path: HostPath, base: DiffBase, revision?: string) => void
}): ReactElement {
  return (
    <div className="git-commit-detail" id={`git-commit-detail-${detail.hash}`}>
      <p>{detail.message}</p>
      <VirtualCommitFiles detail={detail} root={root} onOpen={onOpen} />
    </div>
  )
}

function VirtualCommitFiles({
  detail,
  root,
  onOpen,
}: {
  readonly detail: GitCommitDetail
  readonly root: HostPath
  readonly onOpen: (path: HostPath, base: DiffBase, revision?: string) => void
}): ReactElement {
  const [scrollTop, setScrollTop] = useState(0)
  const height = Math.min(196, Math.max(DETAIL_ROW_HEIGHT, detail.files.length * 28))
  const { start, end } = virtualRange(
    detail.files.length,
    DETAIL_ROW_HEIGHT,
    scrollTop,
    height,
    3,
  )
  return (
    <div
      className="git-detail-files"
      style={{ height }}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div
        className="git-detail-files-window"
        style={{ height: detail.files.length * DETAIL_ROW_HEIGHT }}
      >
        {detail.files.slice(start, end).map((file, offset) => {
          const index = start + offset
          return (
            <button
              type="button"
              className="git-file"
              key={`${file.path.hostId}:${file.path.path}`}
              style={{
                height: DETAIL_ROW_HEIGHT,
                transform: `translateY(${index * DETAIL_ROW_HEIGHT}px)`,
              }}
              onClick={() => onOpen(file.path, 'head', detail.hash)}
            >
              <span>{displayGitPath(file.path, root)}</span>
              <small>
                <b>+{file.additions}</b> <i>-{file.deletions}</i>
              </small>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function ChangeGroup({
  title,
  files,
  base,
  root,
  onOpen,
}: {
  readonly title: string
  readonly files: GitChanges['workingTree']
  readonly base: DiffBase
  readonly root: HostPath
  readonly onOpen: (path: HostPath, base: DiffBase, revision?: string) => void
}): ReactElement {
  return (
    <div className="git-group">
      <h3>
        {title}
        <span>{files.length}</span>
      </h3>
      <VirtualChangeFiles files={files} base={base} root={root} onOpen={onOpen} />
    </div>
  )
}

function VirtualChangeFiles({
  files,
  base,
  root,
  onOpen,
}: {
  readonly files: GitChanges['workingTree']
  readonly base: DiffBase
  readonly root: HostPath
  readonly onOpen: (path: HostPath, base: DiffBase, revision?: string) => void
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
          return (
            <button
              type="button"
              className="git-file"
              key={`${file.path.hostId}:${file.path.path}`}
              style={{
                height: DETAIL_ROW_HEIGHT,
                transform: `translateY(${index * DETAIL_ROW_HEIGHT}px)`,
              }}
              onClick={() => onOpen(file.path, base)}
              title={file.path.path}
            >
              <span>{displayGitPath(file.path, root)}</span>
              <small>
                {file.conflicted
                  ? '!'
                  : file.untracked
                    ? '?'
                    : file.staged && file.unstaged
                      ? '±'
                      : file.staged
                        ? 'S'
                        : 'M'}{' '}
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

function displayGitPath(path: HostPath, root: HostPath): string {
  if (path.hostId !== root.hostId) return path.path
  const prefix = root.path === '/' ? '/' : `${root.path}/`
  return path.path.startsWith(prefix) ? path.path.slice(prefix.length) : path.path
}
