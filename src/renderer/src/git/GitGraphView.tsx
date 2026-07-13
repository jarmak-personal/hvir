import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react'

import {
  basenameHostPath,
  joinHostPath,
  type DiffBase,
  type GitCommitDetail,
  type GitCommitSummary,
  type GitRepositoryState,
  type HostConnectionState,
  type HostPath,
} from '../../../shared'
import { buildGitGraphLayout } from './git-graph-layout'
import { FULL_GRAPH_LANE_METRICS, gitGraphWidth } from './git-graph-lane-metrics'
import { GitGraphCell } from './GitGraphLanes'
import {
  commitTreeEntryHeight,
  flattenCommitFiles,
  sumCommitFileChanges,
} from './commit-file-tree'
import { loadCommitDetail } from './commit-detail-client'
import { commitMessageBody } from './commit-message'
import { measureVariableRows, variableVirtualRange, virtualRange } from './virtual-range'
import { MarkdownFragment } from '../viewer/MarkdownFragment'

interface GitGraphViewProps {
  readonly root: HostPath
  readonly refreshVersion: number
  readonly connectionState: HostConnectionState
  readonly requestedHash?: string
  readonly requestSerial: number
  readonly onOpen: (path: HostPath, base: DiffBase, revision?: string) => void
}

const GRAPH_ROW_HEIGHT = 40
const GRAPH_OVERSCAN = 10

export function GitGraphView({
  root,
  refreshVersion,
  connectionState,
  requestedHash,
  requestSerial,
  onOpen,
}: GitGraphViewProps): ReactElement {
  const [commits, setCommits] = useState<readonly GitCommitSummary[]>([])
  const [cursor, setCursor] = useState<string>()
  const [hasMore, setHasMore] = useState(false)
  const [repositoryState, setRepositoryState] = useState<GitRepositoryState>()
  const [initialLoading, setInitialLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [selectedHash, setSelectedHash] = useState<string>()
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [detail, setDetail] = useState<GitCommitDetail>()
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string>()
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(420)
  const viewport = useRef<HTMLDivElement>(null)
  const loadingMore = useRef(false)
  const generation = useRef(0)
  const commitsValue = useRef<readonly GitCommitSummary[]>([])
  const refreshControl = useRef({ running: false, queued: false })
  const refreshContext = useRef({ root, connectionState })
  commitsValue.current = commits
  refreshContext.current = { root, connectionState }

  const requestRefresh = useCallback((): void => {
    const control = refreshControl.current
    control.queued = true
    if (control.running) return
    control.running = true
    const drain = async (): Promise<void> => {
      while (control.queued) {
        control.queued = false
        const context = refreshContext.current
        if (context.connectionState !== 'connected') continue
        const requestRoot = context.root
        const requestKey = `${requestRoot.hostId}\0${requestRoot.path}`
        const requestGeneration = ++generation.current
        loadingMore.current = false
        if (commitsValue.current.length === 0) setInitialLoading(true)
        setError(undefined)
        try {
          const page = await window.hvir.invoke('git:history', {
            root: requestRoot,
            limit: 100,
            allRefs: true,
          })
          const latest = refreshContext.current
          if (
            requestGeneration !== generation.current ||
            `${latest.root.hostId}\0${latest.root.path}` !== requestKey ||
            latest.connectionState !== 'connected'
          )
            continue
          commitsValue.current = page.commits
          setCommits(page.commits)
          setCursor(page.nextCursor)
          setHasMore(page.hasMore)
          setRepositoryState(page.repositoryState)
          setInitialLoading(false)
        } catch (reason) {
          const latest = refreshContext.current
          if (
            requestGeneration !== generation.current ||
            `${latest.root.hostId}\0${latest.root.path}` !== requestKey
          )
            continue
          setError(reason instanceof Error ? reason.message : String(reason))
          setInitialLoading(false)
        }
      }
      control.running = false
    }
    void drain()
  }, [])

  useEffect(() => {
    const control = refreshControl.current
    control.queued = false
    generation.current += 1
    loadingMore.current = false
    commitsValue.current = []
    setCommits([])
    setCursor(undefined)
    setHasMore(false)
    setRepositoryState(undefined)
    setError(undefined)
    setInitialLoading(false)
    setSelectedHash(undefined)
    setInspectorOpen(false)
    return () => {
      control.queued = false
      generation.current += 1
    }
  }, [connectionState, root.hostId, root.path])

  useEffect(() => {
    if (connectionState === 'connected') requestRefresh()
  }, [connectionState, refreshVersion, requestRefresh, root.hostId, root.path])

  const loadMore = useCallback((): void => {
    if (connectionState !== 'connected' || loadingMore.current || !hasMore || !cursor) {
      return
    }
    loadingMore.current = true
    const requestGeneration = generation.current
    const requestCursor = cursor
    void window.hvir
      .invoke('git:history', {
        root,
        limit: 100,
        cursor: requestCursor,
        allRefs: true,
      })
      .then(
        (page) => {
          if (requestGeneration !== generation.current) return
          setCommits((current) => {
            const seen = new Set(current.map((commit) => commit.hash))
            return [
              ...current,
              ...page.commits.filter((commit) => !seen.has(commit.hash)),
            ]
          })
          setCursor(page.nextCursor)
          setHasMore(page.hasMore)
          setRepositoryState(page.repositoryState)
          setError(undefined)
        },
        (reason: unknown) => {
          if (requestGeneration === generation.current) {
            setError(reason instanceof Error ? reason.message : String(reason))
          }
        },
      )
      .finally(() => {
        if (requestGeneration === generation.current) loadingMore.current = false
      })
  }, [connectionState, cursor, hasMore, root])

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
    if (requestedHash) {
      setSelectedHash(requestedHash)
      setInspectorOpen(true)
    }
  }, [requestSerial, requestedHash])

  useEffect(() => {
    if (!selectedHash && commits[0]) setSelectedHash(commits[0].hash)
  }, [commits, selectedHash])

  useEffect(() => {
    if (
      requestedHash &&
      !commits.some((commit) => commit.hash === requestedHash) &&
      hasMore
    ) {
      loadMore()
    }
  }, [commits, hasMore, loadMore, requestedHash])

  useEffect(() => {
    if (!selectedHash || !inspectorOpen) {
      setDetail(undefined)
      setDetailLoading(false)
      setDetailError(undefined)
      return
    }
    let cancelled = false
    setDetail(undefined)
    setDetailLoading(true)
    setDetailError(undefined)
    void loadCommitDetail(root, selectedHash).then(
      (result) => {
        if (cancelled) return
        setDetail(result)
        setDetailLoading(false)
      },
      (reason: unknown) => {
        if (cancelled) return
        setDetailError(reason instanceof Error ? reason.message : String(reason))
        setDetailLoading(false)
      },
    )
    return () => {
      cancelled = true
    }
  }, [inspectorOpen, root, selectedHash])

  const layout = useMemo(() => buildGitGraphLayout(commits), [commits])
  const graphWidth = gitGraphWidth(layout.laneCount, FULL_GRAPH_LANE_METRICS)
  const { start, end } = virtualRange(
    layout.rows.length,
    GRAPH_ROW_HEIGHT,
    scrollTop,
    viewportHeight,
    GRAPH_OVERSCAN,
  )
  const selectedIndex = commits.findIndex((commit) => commit.hash === selectedHash)
  const selectedCommit = selectedIndex < 0 ? undefined : commits[selectedIndex]

  const selectCommit = (hash: string, open = true): void => {
    setSelectedHash(hash)
    if (open) setInspectorOpen(true)
  }

  const scrollToIndex = (index: number): void => {
    const element = viewport.current
    if (!element || index < 0) return
    const top = index * GRAPH_ROW_HEIGHT
    const bottom = top + GRAPH_ROW_HEIGHT
    if (top < element.scrollTop) element.scrollTop = top
    else if (bottom > element.scrollTop + element.clientHeight) {
      element.scrollTop = bottom - element.clientHeight
    }
  }

  const handleKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (commits.length === 0) return
    let nextIndex = selectedIndex < 0 ? 0 : selectedIndex
    if (event.key === 'ArrowDown') nextIndex = Math.min(commits.length - 1, nextIndex + 1)
    else if (event.key === 'ArrowUp') nextIndex = Math.max(0, nextIndex - 1)
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = commits.length - 1
    else if (event.key === 'ArrowRight' || event.key === 'Enter') {
      if (selectedHash) setInspectorOpen(true)
      event.preventDefault()
      return
    } else if (event.key === 'ArrowLeft' || event.key === 'Escape') {
      setInspectorOpen(false)
      event.preventDefault()
      return
    } else return
    const commit = commits[nextIndex]
    if (!commit) return
    event.preventDefault()
    selectCommit(commit.hash, inspectorOpen)
    scrollToIndex(nextIndex)
  }

  return (
    <section className="git-graph-view" aria-label="Git history graph">
      <header className="git-graph-toolbar">
        <div>
          <strong>Git history</strong>
          <span>{basenameHostPath(root)}</span>
        </div>
        <span className="git-graph-count">
          {commits.length.toLocaleString()}
          {hasMore ? '+' : ''} commits
        </span>
      </header>
      {connectionState !== 'connected' ? (
        <GraphEmpty text="Reconnect to inspect Git history." />
      ) : initialLoading ? (
        <GraphEmpty text="Loading repository graph…" />
      ) : error && commits.length === 0 ? (
        <GraphEmpty text={`History unavailable: ${error}`} error />
      ) : repositoryState === 'not-git' ? (
        <GraphEmpty text="Not a Git repository" />
      ) : repositoryState === 'unborn' || commits.length === 0 ? (
        <GraphEmpty text="No commits yet" />
      ) : (
        <div className={`git-graph-workspace${inspectorOpen ? ' inspector-open' : ''}`}>
          <div className="git-graph-table-shell">
            <div
              className={`git-graph-columns${inspectorOpen ? ' details-open' : ''}`}
              style={{ paddingLeft: graphWidth }}
            >
              <span>Commit</span>
              {!inspectorOpen ? (
                <>
                  <span>Author</span>
                  <span>Date</span>
                  <span>Hash</span>
                </>
              ) : null}
            </div>
            {error ? (
              <div className="git-graph-banner">Refresh failed: {error}</div>
            ) : null}
            <div
              ref={viewport}
              className="git-graph-viewport"
              role="listbox"
              tabIndex={0}
              aria-label="Repository commits"
              aria-activedescendant={
                selectedHash ? `git-graph-commit-${selectedHash}` : undefined
              }
              onKeyDown={handleKeyboard}
              onScroll={(event) => {
                const element = event.currentTarget
                setScrollTop(element.scrollTop)
                if (
                  hasMore &&
                  element.scrollHeight - element.scrollTop - element.clientHeight <
                    GRAPH_ROW_HEIGHT * 8
                ) {
                  loadMore()
                }
              }}
            >
              <div
                className="git-graph-window"
                style={{ height: layout.rows.length * GRAPH_ROW_HEIGHT }}
              >
                {layout.rows.slice(start, end).map((row, offset) => {
                  const index = start + offset
                  const selected = row.commit.hash === selectedHash
                  return (
                    <button
                      type="button"
                      id={`git-graph-commit-${row.commit.hash}`}
                      className={`git-graph-row${selected ? ' active' : ''}`}
                      key={row.commit.hash}
                      role="option"
                      aria-selected={selected}
                      aria-expanded={selected && inspectorOpen}
                      style={{
                        height: GRAPH_ROW_HEIGHT,
                        transform: `translateY(${index * GRAPH_ROW_HEIGHT}px)`,
                        gridTemplateColumns: inspectorOpen
                          ? `${graphWidth}px minmax(180px, 1fr)`
                          : `${graphWidth}px minmax(180px, 1fr) minmax(100px, 0.28fr) 92px 70px`,
                      }}
                      onClick={() => {
                        selectCommit(row.commit.hash)
                        viewport.current?.focus()
                      }}
                    >
                      <GitGraphCell
                        row={row}
                        width={graphWidth}
                        height={GRAPH_ROW_HEIGHT}
                        metrics={FULL_GRAPH_LANE_METRICS}
                      />
                      <span className="git-graph-subject">
                        <i className="git-graph-disclosure" aria-hidden="true">
                          {selected && inspectorOpen ? '▾' : '▸'}
                        </i>
                        <span>{row.commit.subject || '(no subject)'}</span>
                        <RefLabels refs={row.commit.refs} />
                      </span>
                      {!inspectorOpen ? (
                        <>
                          <span className="git-graph-author">{row.commit.author}</span>
                          <time title={row.commit.authoredAt}>
                            {formatCommitDate(row.commit.authoredAt)}
                          </time>
                          <code>{row.commit.shortHash}</code>
                        </>
                      ) : null}
                    </button>
                  )
                })}
              </div>
              {hasMore ? (
                <button type="button" className="git-graph-load-more" onClick={loadMore}>
                  Load more
                </button>
              ) : null}
            </div>
          </div>
          {inspectorOpen ? (
            <CommitInspector
              detail={detail}
              refs={selectedCommit?.refs}
              loading={detailLoading}
              error={detailError}
              root={root}
              onClose={() => setInspectorOpen(false)}
              onOpen={onOpen}
            />
          ) : null}
        </div>
      )}
    </section>
  )
}

function RefLabels({ refs }: { readonly refs: readonly string[] }): ReactElement | null {
  if (refs.length === 0) return null
  return (
    <span className="git-ref-list">
      {refs.map((ref) => (
        <span
          className={`git-ref${ref.startsWith('tag: ') ? ' tag' : ''}${ref.startsWith('HEAD') ? ' head' : ''}`}
          key={ref}
          title={ref}
        >
          {ref.replace(/^tag: /, '')}
        </span>
      ))}
    </span>
  )
}

function CommitInspector({
  detail,
  refs,
  loading,
  error,
  root,
  onClose,
  onOpen,
}: {
  readonly detail?: GitCommitDetail
  readonly refs?: readonly string[]
  readonly loading: boolean
  readonly error?: string
  readonly root: HostPath
  readonly onClose: () => void
  readonly onOpen: (path: HostPath, base: DiffBase, revision?: string) => void
}): ReactElement {
  const messageBody = detail ? commitMessageBody(detail) : ''
  return (
    <aside className="git-commit-inspector" aria-label="Commit details">
      <header>
        <strong>Commit details</strong>
        <button type="button" aria-label="Close commit details" onClick={onClose}>
          ×
        </button>
      </header>
      {loading ? <GraphEmpty text="Loading commit…" /> : null}
      {error ? <GraphEmpty text={`Commit unavailable: ${error}`} error /> : null}
      {detail ? (
        <>
          <div className={`git-inspector-summary${messageBody ? ' has-message' : ''}`}>
            <h2>{detail.subject || '(no subject)'}</h2>
            <RefLabels refs={refs ?? detail.refs} />
            <dl>
              <div>
                <dt>Author</dt>
                <dd>{detail.author}</dd>
              </div>
              <div>
                <dt>Date</dt>
                <dd>{formatCommitDate(detail.authoredAt, true)}</dd>
              </div>
              <div>
                <dt>Commit</dt>
                <dd title={detail.hash}>{detail.shortHash}</dd>
              </div>
            </dl>
          </div>
          {messageBody ? (
            <CommitMessage
              path={joinHostPath(root, '.hvir-commit-message.md')}
              content={messageBody}
              onOpenPath={(path) => onOpen(path, 'head', detail.hash)}
            />
          ) : null}
          <CommitFileTree detail={detail} root={root} onOpen={onOpen} />
        </>
      ) : null}
    </aside>
  )
}

function CommitMessage({
  path,
  content,
  onOpenPath,
}: {
  readonly path: HostPath
  readonly content: string
  readonly onOpenPath: (path: HostPath) => void
}): ReactElement {
  const viewport = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const [hasMore, setHasMore] = useState(false)
  const updateOverflow = useCallback((): void => {
    const element = viewport.current
    if (!element) return
    const more = element.scrollHeight - element.scrollTop - element.clientHeight > 1
    setHasMore((current) => (current === more ? current : more))
  }, [])

  useEffect(() => {
    const element = viewport.current
    const contentElement = body.current
    if (!element || !contentElement) return
    updateOverflow()
    const observer = new ResizeObserver(updateOverflow)
    observer.observe(element)
    observer.observe(contentElement)
    return () => observer.disconnect()
  }, [content, updateOverflow])

  return (
    <div className={`git-commit-message-region${hasMore ? ' has-more' : ''}`}>
      <div
        ref={viewport}
        className="git-commit-message-scroll"
        role="region"
        aria-label="Commit message"
        tabIndex={0}
        onScroll={updateOverflow}
      >
        <div ref={body}>
          <MarkdownFragment
            path={path}
            content={content}
            className="git-commit-message"
            onOpenPath={onOpenPath}
          />
        </div>
      </div>
      {hasMore ? (
        <span className="git-commit-message-more" title="More commit message below">
          ↓
        </span>
      ) : null}
    </div>
  )
}

function CommitFileTree({
  detail,
  root,
  onOpen,
}: {
  readonly detail: GitCommitDetail
  readonly root: HostPath
  readonly onOpen: (path: HostPath, base: DiffBase, revision?: string) => void
}): ReactElement {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(320)
  const viewport = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setCollapsed(new Set())
    setScrollTop(0)
  }, [detail.hash])

  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const update = (): void => setHeight(element.clientHeight)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const entries = useMemo(
    () => flattenCommitFiles(detail.files, root, collapsed),
    [collapsed, detail.files, root],
  )
  const measurements = useMemo(
    () => measureVariableRows(entries.map(commitTreeEntryHeight)),
    [entries],
  )
  const { start, end } = variableVirtualRange(measurements, scrollTop, height, 5)
  const totals = useMemo(() => sumCommitFileChanges(detail.files), [detail.files])

  return (
    <section className="git-inspector-files">
      <header>
        <strong>
          {detail.files.length} file{detail.files.length === 1 ? '' : 's'}
        </strong>
        <span>
          <b>+{totals.additions}</b> <i>−{totals.deletions}</i>
        </span>
      </header>
      <div
        ref={viewport}
        className="git-commit-file-tree"
        role="tree"
        aria-label="Files changed in commit"
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        <div style={{ height: measurements.totalHeight }}>
          {entries.slice(start, end).map((entry, offset) => {
            const index = start + offset
            const rowHeight = commitTreeEntryHeight(entry)
            const top = measurements.offsets[index] ?? 0
            if (entry.kind === 'directory') {
              return (
                <button
                  type="button"
                  role="treeitem"
                  aria-expanded={entry.expanded}
                  className="git-commit-tree-row directory"
                  key={`directory:${entry.path}`}
                  style={{
                    height: rowHeight,
                    paddingLeft: 10 + entry.depth * 16,
                    transform: `translateY(${top}px)`,
                  }}
                  onClick={() =>
                    setCollapsed((current) => {
                      const next = new Set(current)
                      if (next.has(entry.path)) next.delete(entry.path)
                      else next.add(entry.path)
                      return next
                    })
                  }
                >
                  <span aria-hidden="true">{entry.expanded ? '▾' : '▸'}</span>
                  <strong>{entry.name}</strong>
                </button>
              )
            }
            return (
              <button
                type="button"
                role="treeitem"
                className="git-commit-tree-row file"
                key={`file:${entry.file.path.hostId}:${entry.file.path.path}`}
                title={entry.file.path.path}
                style={{
                  height: rowHeight,
                  paddingLeft: 24 + entry.depth * 16,
                  transform: `translateY(${top}px)`,
                }}
                onClick={() => onOpen(entry.file.path, 'head', detail.hash)}
              >
                <span>{entry.name}</span>
                <small>
                  <b>+{entry.file.additions}</b> <i>−{entry.file.deletions}</i>
                </small>
              </button>
            )
          })}
        </div>
      </div>
    </section>
  )
}

function GraphEmpty({
  text,
  error = false,
}: {
  text: string
  error?: boolean
}): ReactElement {
  return <div className={`git-graph-empty${error ? ' error' : ''}`}>{text}</div>
}

function formatCommitDate(value: string, long = false): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    ...(long ? { year: 'numeric', hour: 'numeric', minute: '2-digit' } : {}),
  }).format(date)
}
