import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react'

import type {
  GitCommitDetail,
  GitCommitSummary,
  GitRepositoryState,
  HostPath,
} from '../../../shared'
import {
  commitTreeEntryHeight,
  flattenCommitFiles,
  sumCommitFileChanges,
  type CommitChangeTotals,
  type CommitTreeEntry,
} from './commit-file-tree'
import { buildGitGraphLayout, type GitGraphRow } from './git-graph-layout'
import { gitGraphWidth, RAIL_GRAPH_LANE_METRICS } from './git-graph-lane-metrics'
import { GitGraphCell, GitGraphContinuation } from './GitGraphLanes'
import type { RailCommitDetailState } from './use-git-commit-details'
import { measureVariableRows, variableVirtualRange } from './virtual-range'

const HISTORY_COMMIT_ROW_HEIGHT = 40
const HISTORY_CHILD_ROW_HEIGHT = 22
const HISTORY_OVERSCAN = 8

interface GitHistoryViewProps {
  readonly commits: readonly GitCommitSummary[]
  readonly hasMore: boolean
  readonly error?: string
  readonly initialLoading: boolean
  readonly repositoryState?: GitRepositoryState
  readonly root: HostPath
  readonly expanded: ReadonlySet<string>
  readonly detailStates: ReadonlyMap<string, RailCommitDetailState>
  readonly collapsedDirectories: ReadonlyMap<string, ReadonlySet<string>>
  readonly onOpenGraph: (hash?: string) => void
  readonly onOpenFile: (path: HostPath, revision: string) => void
  readonly onLoadMore: () => void
  readonly onToggleCommit: (hash: string, expanded?: boolean) => void
  readonly onToggleDirectory: (hash: string, path: string) => void
}

export function GitHistoryView(props: GitHistoryViewProps): ReactElement {
  const {
    commits,
    error,
    initialLoading,
    repositoryState,
    onOpenGraph,
  } = props
  return (
    <div className="git-history">
      <button type="button" className="git-open-graph" onClick={() => onOpenGraph()}>
        Open full graph <span aria-hidden="true">→</span>
      </button>
      {error ? <div className="tree-error">History unavailable: {error}</div> : null}
      {initialLoading ? (
        <div className="git-empty">Loading history…</div>
      ) : !error && repositoryState === 'not-git' ? (
        <div className="git-empty">Not a Git repository</div>
      ) : !error && commits.length === 0 ? (
        <div className="git-empty">
          {repositoryState === 'unborn' ? 'No commits yet' : 'No history'}
        </div>
      ) : null}
      {commits.length > 0 ? <HistoryCommitList {...props} /> : null}
    </div>
  )
}

type RailHistoryItem =
  | {
      readonly kind: 'commit'
      readonly key: string
      readonly height: number
      readonly graphRow: GitGraphRow
      readonly position: number
    }
  | {
      readonly kind: 'summary'
      readonly key: string
      readonly height: number
      readonly graphRow: GitGraphRow
      readonly detail: GitCommitDetail
      readonly totals: CommitChangeTotals
    }
  | {
      readonly kind: 'state'
      readonly key: string
      readonly height: number
      readonly graphRow: GitGraphRow
      readonly text: string
      readonly title?: string
      readonly error: boolean
    }
  | {
      readonly kind: 'tree'
      readonly key: string
      readonly height: number
      readonly graphRow: GitGraphRow
      readonly commitHash: string
      readonly entry: CommitTreeEntry
    }

function HistoryCommitList({
  commits,
  hasMore,
  root,
  expanded,
  detailStates,
  collapsedDirectories,
  onOpenGraph,
  onOpenFile,
  onLoadMore,
  onToggleCommit,
  onToggleDirectory,
}: GitHistoryViewProps): ReactElement {
  const viewport = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(320)
  const rootKey = `${root.hostId}\0${root.path}`
  const commitClickTimers = useRef(new Map<string, number>())

  useEffect(() => setScrollTop(0), [rootKey])

  useEffect(
    () => () => {
      for (const timer of commitClickTimers.current.values()) window.clearTimeout(timer)
      commitClickTimers.current.clear()
    },
    [],
  )

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
    if (element.scrollHeight <= element.clientHeight + HISTORY_COMMIT_ROW_HEIGHT) {
      onLoadMore()
    }
  }, [commits.length, expanded, hasMore, onLoadMore])

  const layout = useMemo(() => buildGitGraphLayout(commits), [commits])
  const graphWidth = gitGraphWidth(layout.laneCount, RAIL_GRAPH_LANE_METRICS)
  const items = useMemo<readonly RailHistoryItem[]>(() => {
    const next: RailHistoryItem[] = []
    for (const [position, graphRow] of layout.rows.entries()) {
      const hash = graphRow.commit.hash
      next.push({
        kind: 'commit',
        key: `commit:${hash}`,
        height: HISTORY_COMMIT_ROW_HEIGHT,
        graphRow,
        position,
      })
      if (!expanded.has(hash)) continue
      const detailState = detailStates.get(hash)
      if (detailState?.status === 'error') {
        next.push({
          kind: 'state',
          key: `error:${hash}`,
          height: HISTORY_CHILD_ROW_HEIGHT,
          graphRow,
          text: 'Details unavailable',
          title: detailState.error,
          error: true,
        })
        continue
      }
      if (detailState?.status !== 'ready') {
        next.push({
          kind: 'state',
          key: `loading:${hash}`,
          height: HISTORY_CHILD_ROW_HEIGHT,
          graphRow,
          text: 'Loading changed files…',
          error: false,
        })
        continue
      }
      const detail = detailState.detail
      next.push({
        kind: 'summary',
        key: `summary:${hash}`,
        height: HISTORY_CHILD_ROW_HEIGHT,
        graphRow,
        detail,
        totals: sumCommitFileChanges(detail.files),
      })
      const collapsed = collapsedDirectories.get(hash) ?? new Set<string>()
      for (const entry of flattenCommitFiles(detail.files, root, collapsed)) {
        next.push({
          kind: 'tree',
          key:
            entry.kind === 'directory'
              ? `directory:${hash}:${entry.path}`
              : `file:${hash}:${entry.file.path.hostId}:${entry.file.path.path}`,
          height: commitTreeEntryHeight(entry),
          graphRow,
          commitHash: hash,
          entry,
        })
      }
    }
    return next
  }, [collapsedDirectories, detailStates, expanded, layout, root])
  const measurements = useMemo(
    () => measureVariableRows(items.map((item) => item.height)),
    [items],
  )
  const { start, end } = variableVirtualRange(
    measurements,
    scrollTop,
    viewportHeight,
    HISTORY_OVERSCAN,
  )

  const handleCommitKey = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    hash: string,
  ): void => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      onOpenGraph(hash)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      onToggleCommit(hash, true)
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      onToggleCommit(hash, false)
    }
  }

  return (
    <div
      ref={viewport}
      className="git-history-viewport"
      aria-label="Commit history"
      onScroll={(event) => {
        const element = event.currentTarget
        setScrollTop(element.scrollTop)
        if (
          hasMore &&
          element.scrollHeight - element.scrollTop - element.clientHeight <
            HISTORY_COMMIT_ROW_HEIGHT * 4
        ) {
          onLoadMore()
        }
      }}
    >
      <div
        className="git-history-window"
        role="list"
        aria-label="Commit history"
        style={{ height: measurements.totalHeight }}
      >
        {items.slice(start, end).map((item, offset) => {
          const index = start + offset
          const top = measurements.offsets[index] ?? 0
          if (item.kind === 'commit') {
            const commit = item.graphRow.commit
            const isExpanded = expanded.has(commit.hash)
            return (
              <div
                className="git-rail-history-row commit"
                key={item.key}
                role="listitem"
                aria-posinset={item.position + 1}
                aria-setsize={layout.rows.length}
                style={{ height: item.height, transform: `translateY(${top}px)` }}
              >
                <button
                  type="button"
                  className="git-rail-commit"
                  aria-expanded={isExpanded}
                  title={commit.subject || '(no subject)'}
                  style={{ gridTemplateColumns: `${graphWidth}px minmax(0, 1fr)` }}
                  onClick={() => {
                    if (commitClickTimers.current.has(commit.hash)) return
                    const timer = window.setTimeout(() => {
                      commitClickTimers.current.delete(commit.hash)
                      onToggleCommit(commit.hash)
                    }, 300)
                    commitClickTimers.current.set(commit.hash, timer)
                  }}
                  onDoubleClick={() => {
                    const timer = commitClickTimers.current.get(commit.hash)
                    if (timer !== undefined) window.clearTimeout(timer)
                    commitClickTimers.current.delete(commit.hash)
                    onOpenGraph(commit.hash)
                  }}
                  onKeyDown={(event) => handleCommitKey(event, commit.hash)}
                >
                  <GitGraphCell
                    row={item.graphRow}
                    width={graphWidth}
                    height={item.height}
                    metrics={RAIL_GRAPH_LANE_METRICS}
                  />
                  <span className="git-rail-commit-copy">
                    <strong>
                      <i aria-hidden="true">{isExpanded ? '▾' : '▸'}</i>
                      <span>{commit.subject || '(no subject)'}</span>
                    </strong>
                    <small>
                      {commit.shortHash} · {commit.author}
                    </small>
                  </span>
                </button>
                <button
                  type="button"
                  className="git-rail-open-full"
                  aria-label={`Open ${commit.shortHash} in full history`}
                  title="Open in full history"
                  onClick={() => onOpenGraph(commit.hash)}
                >
                  ↗
                </button>
              </div>
            )
          }
          return (
            <div
              className={`git-rail-history-row child${item.kind === 'state' && item.error ? ' error' : ''}`}
              key={item.key}
              role="presentation"
              style={{ height: item.height, transform: `translateY(${top}px)` }}
            >
              <GitGraphContinuation
                row={item.graphRow}
                width={graphWidth}
                height={item.height}
                metrics={RAIL_GRAPH_LANE_METRICS}
              />
              <RailHistoryChild
                item={item}
                onToggleDirectory={onToggleDirectory}
                onOpenFile={onOpenFile}
              />
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

function RailHistoryChild({
  item,
  onToggleDirectory,
  onOpenFile,
}: {
  readonly item: Exclude<RailHistoryItem, { readonly kind: 'commit' }>
  readonly onToggleDirectory: (hash: string, path: string) => void
  readonly onOpenFile: (path: HostPath, revision: string) => void
}): ReactElement {
  if (item.kind === 'state') {
    return (
      <span className="git-rail-history-state" title={item.title}>
        {item.text}
      </span>
    )
  }
  if (item.kind === 'summary') {
    return (
      <span className="git-rail-history-summary">
        <strong>
          {item.detail.files.length} file{item.detail.files.length === 1 ? '' : 's'}
        </strong>
        <small>
          <b>+{item.totals.additions}</b> <i>−{item.totals.deletions}</i>
        </small>
      </span>
    )
  }
  const entry = item.entry
  if (entry.kind === 'directory') {
    return (
      <button
        type="button"
        className="git-rail-history-tree directory"
        aria-expanded={entry.expanded}
        style={{ paddingLeft: 4 + entry.depth * 12 }}
        onClick={() => onToggleDirectory(item.commitHash, entry.path)}
      >
        <i aria-hidden="true">{entry.expanded ? '▾' : '▸'}</i>
        <strong>{entry.name}</strong>
      </button>
    )
  }
  return (
    <button
      type="button"
      className="git-rail-history-tree file"
      title={entry.file.path.path}
      style={{ paddingLeft: 16 + entry.depth * 12 }}
      onClick={() => onOpenFile(entry.file.path, item.commitHash)}
    >
      <span>{entry.name}</span>
      <small>
        <b>+{entry.file.additions}</b> <i>−{entry.file.deletions}</i>
      </small>
    </button>
  )
}
