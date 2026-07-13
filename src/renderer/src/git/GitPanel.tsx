import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'

import {
  basenameHostPath,
  type DiffBase,
  type GitChanges,
  type GitCommitSummary,
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
  readonly onOpenGraph: (hash?: string) => void
  readonly onChangedCount: (count: number) => void
  readonly connectionState?: HostConnectionState
  readonly hidden?: boolean
  readonly historyPaused?: boolean
}

export function GitPanel({
  root,
  refreshVersion,
  historyRefreshVersion,
  onOpen,
  onOpenGraph,
  onChangedCount,
  connectionState = 'connected',
  hidden = false,
  historyPaused = false,
}: GitPanelProps): ReactElement {
  const [view, setView] = useState<'changes' | 'history'>('changes')
  const [changes, setChanges] = useState<GitChanges>()
  const [commits, setCommits] = useState<readonly GitCommitSummary[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [historyCursor, setHistoryCursor] = useState<string>()
  const [changesError, setChangesError] = useState<string>()
  const [historyError, setHistoryError] = useState<string>()
  const [changesLoading, setChangesLoading] = useState(false)
  const [historyInitialLoading, setHistoryInitialLoading] = useState(false)
  const [historyRepositoryState, setHistoryRepositoryState] =
    useState<GitRepositoryState>()
  const historyLoading = useRef(false)
  const historyGeneration = useRef(0)
  const changesValue = useRef<GitChanges | undefined>(undefined)
  const changesControl = useRef({ running: false, queued: false, generation: 0 })
  const changesContext = useRef({ root, connectionState, onChangedCount })
  changesContext.current = { root, connectionState, onChangedCount }

  const requestChanges = useCallback((): void => {
    const control = changesControl.current
    control.queued = true
    if (control.running) return
    control.running = true
    const drain = async (): Promise<void> => {
      while (control.queued) {
        control.queued = false
        const context = changesContext.current
        if (context.connectionState !== 'connected') continue
        const requestRoot = context.root
        const requestKey = `${requestRoot.hostId}\0${requestRoot.path}`
        const requestGeneration = control.generation
        if (!changesValue.current) setChangesLoading(true)
        setChangesError(undefined)
        try {
          const result = await window.hvir.invoke('git:changes', { root: requestRoot })
          const latest = changesContext.current
          if (
            requestGeneration !== control.generation ||
            `${latest.root.hostId}\0${latest.root.path}` !== requestKey ||
            latest.connectionState !== 'connected'
          )
            continue
          changesValue.current = result
          setChanges(result)
          setChangesLoading(false)
          setChangesError(undefined)
          latest.onChangedCount(result.workingTree.length)
        } catch (reason) {
          const latest = changesContext.current
          if (
            requestGeneration !== control.generation ||
            `${latest.root.hostId}\0${latest.root.path}` !== requestKey
          )
            continue
          setChangesLoading(false)
          if (!changesValue.current) latest.onChangedCount(0)
          setChangesError(reason instanceof Error ? reason.message : String(reason))
        }
      }
      control.running = false
    }
    void drain()
  }, [])

  useEffect(() => {
    const control = changesControl.current
    control.generation += 1
    control.queued = false
    changesValue.current = undefined
    setChanges(undefined)
    setCommits([])
    setHasMore(false)
    setHistoryCursor(undefined)
    setChangesLoading(false)
    setHistoryInitialLoading(false)
    setHistoryRepositoryState(undefined)
    setChangesError(undefined)
    setHistoryError(undefined)
    onChangedCount(0)
    historyGeneration.current += 1
    return () => {
      control.generation += 1
    }
  }, [connectionState, onChangedCount, root.hostId, root.path])

  useEffect(() => {
    if (connectionState !== 'connected') return
    requestChanges()
  }, [connectionState, refreshVersion, requestChanges, root.hostId, root.path])

  const loadHistory = (): void => {
    if (
      connectionState !== 'connected' ||
      historyPaused ||
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
    if (view !== 'history' || connectionState !== 'connected' || historyPaused) return
    let cancelled = false
    const generation = ++historyGeneration.current
    historyLoading.current = false
    setCommits([])
    setHasMore(false)
    setHistoryCursor(undefined)
    setHistoryRepositoryState(undefined)
    setHistoryInitialLoading(true)
    setHistoryError(undefined)
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
  }, [connectionState, historyPaused, historyRefreshVersion, root, view])

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
            ) : null}
            {!changes && changesLoading ? (
              <div className="git-empty">Loading changes…</div>
            ) : !changes ? null : changes.repositoryState === 'not-git' ? (
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
            <button
              type="button"
              className="git-open-graph"
              onClick={() => onOpenGraph()}
            >
              Open full graph <span aria-hidden="true">→</span>
            </button>
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
            {commits.length > 0 ? (
              <HistoryCommitList
                commits={commits}
                hasMore={hasMore}
                onSelect={(commit) => onOpenGraph(commit.hash)}
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
  hasMore,
  onSelect,
  onLoadMore,
}: {
  readonly commits: readonly GitCommitSummary[]
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
                className="git-commit"
                title="Open in full history graph"
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
