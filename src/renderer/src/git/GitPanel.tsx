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
  type GitChangedFile,
  type GitChanges,
  type GitBranchModel,
  type GitCommitDetail,
  type GitCommitSummary,
  type GitRepositoryState,
  type HostPath,
  type HostConnectionState,
} from '../../../shared'
import {
  commitTreeEntryHeight,
  displayGitParentPath,
  flattenCommitFiles,
  sumCommitFileChanges,
  type CommitChangeTotals,
  type CommitTreeEntry,
} from './commit-file-tree'
import { loadCommitDetail } from './commit-detail-client'
import { buildGitGraphLayout, type GitGraphRow } from './git-graph-layout'
import { gitGraphWidth, RAIL_GRAPH_LANE_METRICS } from './git-graph-lane-metrics'
import { GitGraphCell, GitGraphContinuation } from './GitGraphLanes'
import { splitFileName } from '../tree/file-name'
import { measureVariableRows, variableVirtualRange, virtualRange } from './virtual-range'

interface GitPanelProps {
  readonly root: HostPath
  readonly refreshVersion: number
  readonly historyRefreshVersion: number
  readonly onOpenChange: (path: HostPath, base: DiffBase, untracked?: boolean) => void
  readonly onOpenHistory: (path: HostPath, revision: string) => void
  readonly onOpenGraph: (hash?: string) => void
  readonly onChanges: (changes: GitChanges | undefined) => void
  readonly connectionState?: HostConnectionState
  readonly hidden?: boolean
  readonly historyPaused?: boolean
  readonly hasDirtyViewerTabs: boolean
  readonly onSwitchBranch: (branch: string) => Promise<void>
}

export function GitPanel({
  root,
  refreshVersion,
  historyRefreshVersion,
  onOpenChange,
  onOpenHistory,
  onOpenGraph,
  onChanges,
  connectionState = 'connected',
  hidden = false,
  historyPaused = false,
  hasDirtyViewerTabs,
  onSwitchBranch,
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
  const [branchModel, setBranchModel] = useState<GitBranchModel>()
  const [branchError, setBranchError] = useState<string>()
  const [branchSwitching, setBranchSwitching] = useState(false)
  const [branchRefresh, setBranchRefresh] = useState(0)
  const historyLoading = useRef(false)
  const historyGeneration = useRef(0)
  const changesValue = useRef<GitChanges | undefined>(undefined)
  const changesControl = useRef({ running: false, queued: false, generation: 0 })
  const changesContext = useRef({ root, connectionState, onChanges })
  changesContext.current = { root, connectionState, onChanges }

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
          latest.onChanges(result)
        } catch (reason) {
          const latest = changesContext.current
          if (
            requestGeneration !== control.generation ||
            `${latest.root.hostId}\0${latest.root.path}` !== requestKey
          )
            continue
          setChangesLoading(false)
          if (!changesValue.current) latest.onChanges(undefined)
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
    onChanges(undefined)
    historyGeneration.current += 1
    return () => {
      control.generation += 1
    }
  }, [connectionState, onChanges, root.hostId, root.path])

  useEffect(() => {
    let cancelled = false
    setBranchModel(undefined)
    setBranchError(undefined)
    if (connectionState !== 'connected') return () => undefined
    void window.hvir.invoke('git:branches', { root }).then(
      (model) => {
        if (!cancelled) setBranchModel(model)
      },
      (reason: unknown) => {
        if (!cancelled)
          setBranchError(reason instanceof Error ? reason.message : String(reason))
      },
    )
    return () => {
      cancelled = true
    }
  }, [branchRefresh, connectionState, historyRefreshVersion, root])

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

  const branchBlockReason =
    connectionState !== 'connected'
      ? 'Reconnect before switching branches'
      : hasDirtyViewerTabs
        ? 'Save or close unsaved viewer tabs before switching'
        : !changes
          ? 'Checking working tree…'
          : changes.workingTree.length > 0
            ? 'Commit or stash working tree changes before switching'
            : undefined
  const hasAlternativeBranch = branchModel?.branches.some((branch) => !branch.current)

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
      {branchModel?.repositoryState !== 'not-git' || branchError ? (
        <div className="git-branch-control">
          <label htmlFor="git-branch-select">Branch</label>
          <select
            id="git-branch-select"
            value={branchModel?.current ?? '__detached__'}
            disabled={!branchModel || branchSwitching || !hasAlternativeBranch}
            title={branchError ?? branchBlockReason ?? 'Switch existing local branch'}
            onChange={(event) => {
              const branch = event.currentTarget.value
              if (!branchModel?.branches.some((candidate) => candidate.name === branch)) {
                return
              }
              setBranchSwitching(true)
              setBranchError(undefined)
              void onSwitchBranch(branch)
                .then(
                  () => setBranchRefresh((version) => version + 1),
                  (reason: unknown) =>
                    setBranchError(
                      reason instanceof Error ? reason.message : String(reason),
                    ),
                )
                .finally(() => setBranchSwitching(false))
            }}
          >
            {!branchModel?.current ? (
              <option value="__detached__" disabled>
                {branchModel?.detached && branchModel.head
                  ? `Detached at ${branchModel.head.slice(0, 8)}`
                  : 'No branch'}
              </option>
            ) : null}
            {branchModel?.branches.map((branch) => {
              const occupiedElsewhere =
                branch.worktree &&
                (branch.worktree.hostId !== root.hostId ||
                  branch.worktree.path !== root.path)
              return (
                <option
                  key={branch.name}
                  value={branch.name}
                  disabled={Boolean(
                    occupiedElsewhere || (!branch.current && branchBlockReason),
                  )}
                >
                  {branch.name}
                  {occupiedElsewhere ? ` — in ${branch.worktree?.path}` : ''}
                </option>
              )
            })}
          </select>
          {branchSwitching ? (
            <small>Switching…</small>
          ) : branchError ? (
            <small className="error">{branchError}</small>
          ) : branchBlockReason && branchModel ? (
            <small>{branchBlockReason}</small>
          ) : null}
        </div>
      ) : null}
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
                  root={root}
                  base="head"
                  onOpen={onOpenChange}
                />
                {changes?.branchPointAvailable ? (
                  changes.branchPoint.length > 0 ? (
                    <ChangeGroup
                      key={`${root.hostId}:${root.path}:branch-point`}
                      title="Branch point"
                      files={changes.branchPoint}
                      root={root}
                      base="branch-point"
                      onOpen={onOpenChange}
                      collapsible
                    />
                  ) : null
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
                root={root}
                onOpenGraph={onOpenGraph}
                onOpenFile={onOpenHistory}
                onLoadMore={loadHistory}
              />
            ) : null}
          </div>
        )}
      </div>
    </section>
  )
}

const HISTORY_COMMIT_ROW_HEIGHT = 40
const HISTORY_CHILD_ROW_HEIGHT = 22
const HISTORY_OVERSCAN = 8
const DETAIL_ROW_HEIGHT = 28

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

type RailCommitDetailState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly detail: GitCommitDetail }
  | { readonly status: 'error'; readonly error: string }

function HistoryCommitList({
  commits,
  hasMore,
  root,
  onOpenGraph,
  onOpenFile,
  onLoadMore,
}: {
  readonly commits: readonly GitCommitSummary[]
  readonly hasMore: boolean
  readonly root: HostPath
  readonly onOpenGraph: (hash?: string) => void
  readonly onOpenFile: (path: HostPath, revision: string) => void
  readonly onLoadMore: () => void
}): ReactElement {
  const viewport = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(320)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [detailStates, setDetailStates] = useState<
    ReadonlyMap<string, RailCommitDetailState>
  >(new Map())
  const [collapsedDirectories, setCollapsedDirectories] = useState<
    ReadonlyMap<string, ReadonlySet<string>>
  >(new Map())
  const rootKey = `${root.hostId}\0${root.path}`
  const activeRootKey = useRef(rootKey)
  const commitClickTimers = useRef(new Map<string, number>())
  activeRootKey.current = rootKey

  useEffect(() => {
    setExpanded(new Set())
    setDetailStates(new Map())
    setCollapsedDirectories(new Map())
    setScrollTop(0)
  }, [rootKey])

  useEffect(
    () => () => {
      for (const timer of commitClickTimers.current.values()) window.clearTimeout(timer)
      commitClickTimers.current.clear()
    },
    [],
  )

  const requestDetail = useCallback(
    (hash: string): void => {
      const currentState = detailStates.get(hash)
      if (currentState?.status === 'loading' || currentState?.status === 'ready') return
      const requestRootKey = rootKey
      setDetailStates((current) => new Map(current).set(hash, { status: 'loading' }))
      void loadCommitDetail(root, hash).then(
        (detail) => {
          if (activeRootKey.current !== requestRootKey) return
          setDetailStates((current) =>
            new Map(current).set(hash, { status: 'ready', detail }),
          )
        },
        (reason: unknown) => {
          if (activeRootKey.current !== requestRootKey) return
          setDetailStates((current) =>
            new Map(current).set(hash, {
              status: 'error',
              error: reason instanceof Error ? reason.message : String(reason),
            }),
          )
        },
      )
    },
    [detailStates, root, rootKey],
  )

  const toggleCommit = (hash: string, nextExpanded?: boolean): void => {
    const shouldExpand = nextExpanded ?? !expanded.has(hash)
    if (shouldExpand === expanded.has(hash)) return
    setExpanded((current) => {
      const next = new Set(current)
      if (shouldExpand) next.add(hash)
      else next.delete(hash)
      return next
    })
    if (shouldExpand && detailStates.get(hash)?.status !== 'ready') requestDetail(hash)
  }

  const toggleDirectory = (hash: string, path: string): void => {
    setCollapsedDirectories((current) => {
      const next = new Map(current)
      const paths = new Set(next.get(hash) ?? [])
      if (paths.has(path)) paths.delete(path)
      else paths.add(path)
      next.set(hash, paths)
      return next
    })
  }

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
      toggleCommit(hash, true)
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      toggleCommit(hash, false)
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
                      toggleCommit(commit.hash)
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
                onToggleDirectory={toggleDirectory}
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
