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
  type DiffBase,
  type GitCommitDetail,
  type GitCommitFile,
  type GitCommitSummary,
  type GitRepositoryState,
  type HostConnectionState,
  type HostPath,
} from '../../../shared'
import { buildGitGraphLayout, type GitGraphRow } from './git-graph-layout'
import { virtualRange } from './virtual-range'

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
const GRAPH_LANE_WIDTH = 18
const GRAPH_LANE_PADDING = 9
const FILE_ROW_HEIGHT = 28
const GRAPH_COLORS = [
  '#69a7ff',
  '#dc8cff',
  '#5ed6a0',
  '#ffb45d',
  '#f2779f',
  '#6fd4e8',
] as const

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
  const detailGeneration = useRef(0)

  useEffect(() => {
    if (connectionState !== 'connected') return
    let cancelled = false
    const requestGeneration = ++generation.current
    loadingMore.current = false
    setCommits([])
    setCursor(undefined)
    setHasMore(false)
    setRepositoryState(undefined)
    setError(undefined)
    setInitialLoading(true)
    void window.hvir.invoke('git:history', { root, limit: 100, allRefs: true }).then(
      (page) => {
        if (cancelled || requestGeneration !== generation.current) return
        setCommits(page.commits)
        setCursor(page.nextCursor)
        setHasMore(page.hasMore)
        setRepositoryState(page.repositoryState)
        setInitialLoading(false)
      },
      (reason: unknown) => {
        if (cancelled || requestGeneration !== generation.current) return
        setError(reason instanceof Error ? reason.message : String(reason))
        setInitialLoading(false)
      },
    )
    return () => {
      cancelled = true
    }
  }, [connectionState, refreshVersion, root])

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
      detailGeneration.current += 1
      setDetail(undefined)
      setDetailLoading(false)
      setDetailError(undefined)
      return
    }
    let cancelled = false
    const requestGeneration = ++detailGeneration.current
    setDetail(undefined)
    setDetailLoading(true)
    setDetailError(undefined)
    void window.hvir.invoke('git:commit-detail', { root, hash: selectedHash }).then(
      (result) => {
        if (cancelled || requestGeneration !== detailGeneration.current) return
        setDetail(result)
        setDetailLoading(false)
      },
      (reason: unknown) => {
        if (cancelled || requestGeneration !== detailGeneration.current) return
        setDetailError(reason instanceof Error ? reason.message : String(reason))
        setDetailLoading(false)
      },
    )
    return () => {
      cancelled = true
    }
  }, [inspectorOpen, root, selectedHash])

  const layout = useMemo(() => buildGitGraphLayout(commits), [commits])
  const graphWidth =
    Math.max(2, layout.laneCount) * GRAPH_LANE_WIDTH + GRAPH_LANE_PADDING * 2
  const { start, end } = virtualRange(
    layout.rows.length,
    GRAPH_ROW_HEIGHT,
    scrollTop,
    viewportHeight,
    GRAPH_OVERSCAN,
  )
  const selectedIndex = commits.findIndex((commit) => commit.hash === selectedHash)

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
            <div className="git-graph-columns" style={{ paddingLeft: graphWidth }}>
              <span>Commit</span>
              <span>Author</span>
              <span>Date</span>
              <span>Hash</span>
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
                        gridTemplateColumns: `${graphWidth}px minmax(180px, 1fr) minmax(100px, 0.28fr) 92px 70px`,
                      }}
                      onClick={() => {
                        selectCommit(row.commit.hash)
                        viewport.current?.focus()
                      }}
                    >
                      <GraphCell row={row} width={graphWidth} />
                      <span className="git-graph-subject">
                        <i className="git-graph-disclosure" aria-hidden="true">
                          {selected && inspectorOpen ? '▾' : '▸'}
                        </i>
                        <span>{row.commit.subject || '(no subject)'}</span>
                        <RefLabels refs={row.commit.refs} />
                      </span>
                      <span className="git-graph-author">{row.commit.author}</span>
                      <time title={row.commit.authoredAt}>
                        {formatCommitDate(row.commit.authoredAt)}
                      </time>
                      <code>{row.commit.shortHash}</code>
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

function GraphCell({ row, width }: { row: GitGraphRow; width: number }): ReactElement {
  const centerY = GRAPH_ROW_HEIGHT / 2
  const laneX = (lane: number): number =>
    GRAPH_LANE_PADDING + lane * GRAPH_LANE_WIDTH + GRAPH_LANE_WIDTH / 2
  const curve = (fromLane: number, toLane: number, incoming: boolean): string => {
    const fromX = laneX(fromLane)
    const toX = laneX(toLane)
    if (incoming) {
      return `M ${fromX} 0 C ${fromX} ${centerY * 0.55}, ${toX} ${centerY * 0.55}, ${toX} ${centerY}`
    }
    return `M ${fromX} ${centerY} C ${fromX} ${centerY * 1.45}, ${toX} ${centerY * 1.45}, ${toX} ${GRAPH_ROW_HEIGHT}`
  }
  return (
    <svg
      className="git-graph-lanes"
      width={width}
      height={GRAPH_ROW_HEIGHT}
      viewBox={`0 0 ${width} ${GRAPH_ROW_HEIGHT}`}
      aria-hidden="true"
    >
      {row.passthrough.map((line) => (
        <line
          key={`pass-${line.lane}`}
          x1={laneX(line.lane)}
          x2={laneX(line.lane)}
          y1={0}
          y2={GRAPH_ROW_HEIGHT}
          stroke={graphColor(line.color)}
        />
      ))}
      {row.segments.map((segment, index) => (
        <path
          key={`${segment.incoming ? 'in' : 'out'}-${segment.fromLane}-${segment.toLane}-${index}`}
          d={curve(segment.fromLane, segment.toLane, segment.incoming)}
          stroke={graphColor(segment.color)}
        />
      ))}
      <circle
        cx={laneX(row.lane)}
        cy={centerY}
        r={4}
        fill="#15181e"
        stroke={graphColor(row.color)}
        strokeWidth={2.5}
      />
    </svg>
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
  loading,
  error,
  root,
  onClose,
  onOpen,
}: {
  readonly detail?: GitCommitDetail
  readonly loading: boolean
  readonly error?: string
  readonly root: HostPath
  readonly onClose: () => void
  readonly onOpen: (path: HostPath, base: DiffBase, revision?: string) => void
}): ReactElement {
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
          <div className="git-inspector-summary">
            <h2>{detail.subject || '(no subject)'}</h2>
            <RefLabels refs={detail.refs} />
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
            {detail.message !== detail.subject ? <pre>{detail.message}</pre> : null}
          </div>
          <CommitFileTree detail={detail} root={root} onOpen={onOpen} />
        </>
      ) : null}
    </aside>
  )
}

type CommitTreeEntry =
  | {
      readonly kind: 'directory'
      readonly path: string
      readonly name: string
      readonly depth: number
      readonly expanded: boolean
    }
  | {
      readonly kind: 'file'
      readonly file: GitCommitFile
      readonly name: string
      readonly depth: number
    }

interface CommitTreeNode {
  readonly directories: Map<string, CommitTreeNode>
  readonly files: GitCommitFile[]
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
  const { start, end } = virtualRange(
    entries.length,
    FILE_ROW_HEIGHT,
    scrollTop,
    height,
    5,
  )
  const totals = detail.files.reduce(
    (sum, file) => ({
      additions: sum.additions + file.additions,
      deletions: sum.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  )

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
        <div style={{ height: entries.length * FILE_ROW_HEIGHT }}>
          {entries.slice(start, end).map((entry, offset) => {
            const index = start + offset
            if (entry.kind === 'directory') {
              return (
                <button
                  type="button"
                  role="treeitem"
                  aria-expanded={entry.expanded}
                  className="git-commit-tree-row directory"
                  key={`directory:${entry.path}`}
                  style={{
                    height: FILE_ROW_HEIGHT,
                    paddingLeft: 10 + entry.depth * 16,
                    transform: `translateY(${index * FILE_ROW_HEIGHT}px)`,
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
                  height: FILE_ROW_HEIGHT,
                  paddingLeft: 24 + entry.depth * 16,
                  transform: `translateY(${index * FILE_ROW_HEIGHT}px)`,
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

function flattenCommitFiles(
  files: readonly GitCommitFile[],
  root: HostPath,
  collapsed: ReadonlySet<string>,
): readonly CommitTreeEntry[] {
  const tree: CommitTreeNode = { directories: new Map(), files: [] }
  for (const file of files) {
    const path = displayGitPath(file.path, root)
    const parts = path.split('/').filter(Boolean)
    let node = tree
    for (const directory of parts.slice(0, -1)) {
      let child = node.directories.get(directory)
      if (!child) {
        child = { directories: new Map(), files: [] }
        node.directories.set(directory, child)
      }
      node = child
    }
    node.files.push(file)
  }

  const entries: CommitTreeEntry[] = []
  const walk = (node: CommitTreeNode, depth: number, parentPath: string): void => {
    const directories = [...node.directories.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )
    for (const [name, child] of directories) {
      const path = parentPath ? `${parentPath}/${name}` : name
      const expanded = !collapsed.has(path)
      entries.push({ kind: 'directory', path, name, depth, expanded })
      if (expanded) walk(child, depth + 1, path)
    }
    for (const file of [...node.files].sort((a, b) =>
      a.path.path.localeCompare(b.path.path),
    )) {
      entries.push({
        kind: 'file',
        file,
        name: displayGitPath(file.path, root).split('/').at(-1) ?? file.path.path,
        depth,
      })
    }
  }
  walk(tree, 0, '')
  return entries
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

function displayGitPath(path: HostPath, root: HostPath): string {
  if (path.hostId !== root.hostId) return path.path
  const prefix = root.path === '/' ? '/' : `${root.path}/`
  return path.path.startsWith(prefix) ? path.path.slice(prefix.length) : path.path
}

function graphColor(index: number): string {
  return GRAPH_COLORS[index % GRAPH_COLORS.length] ?? GRAPH_COLORS[0]
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
