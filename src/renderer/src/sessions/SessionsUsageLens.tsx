import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react'

import type { SessionsProjectionSnapshot, SessionsTerminalHandle } from '../../../shared'
import { SESSIONS_OVERVIEW_PAGE_SIZE } from './sessions-overview-model'
import {
  SessionsUsageCoordinator,
  createSessionsUsageMainPort,
} from './sessions-usage-coordinator'
import {
  SESSIONS_USAGE_WINDOWS,
  type SessionsUsageMode,
  type SessionsUsageRankedRow,
  type SessionsUsageWindow,
} from './sessions-usage-model'
import {
  compactState,
  counterLabel,
  coverageLabel,
  cumulativeLabel,
  durationLabel,
  freshnessLabel,
  hasPositiveCategories,
  primaryUsage,
  recentLabel,
  relativeAge,
  usageStatus,
  usageValue,
} from './sessions-usage-presentation'

export function SessionsUsageLens({
  projection,
  rows,
  foreground,
  selected,
  onSelect,
}: {
  readonly projection: SessionsProjectionSnapshot
  readonly rows: readonly SessionsProjectionSnapshot['rows'][number][]
  readonly foreground: boolean
  readonly selected?: SessionsTerminalHandle
  readonly onSelect: (handle: SessionsTerminalHandle | undefined) => void
}): ReactElement {
  const coordinator = useRef<SessionsUsageCoordinator | undefined>(undefined)
  coordinator.current ??= new SessionsUsageCoordinator(
    createSessionsUsageMainPort(window.hvir),
  )
  const source = coordinator.current
  const projectionRef = useRef(projection)
  projectionRef.current = projection
  const usage = useSyncExternalStore(source.subscribe, source.snapshot, source.snapshot)
  const [mode, setMode] = useState<SessionsUsageMode>('recent')
  const [windowMs, setWindowMs] = useState<SessionsUsageWindow>(SESSIONS_USAGE_WINDOWS[1])
  const [pageIndex, setPageIndex] = useState(0)
  const rowElements = useRef(new Map<SessionsTerminalHandle, HTMLElement>())
  const pendingFocus = useRef<SessionsTerminalHandle | undefined>(undefined)

  useEffect(
    () => source.configure(projection, rows, mode, windowMs),
    [mode, projection, rows, source, windowMs],
  )
  useEffect(() => {
    if (!foreground || projection.status !== 'available') return
    return source.acquire(projectionRef.current)
  }, [foreground, projection.demandGeneration, projection.status, source])
  // The acquisition cleanup owns every live Usage resource. Keep the render-owned
  // coordinator reusable when React Strict Mode replays setup after cleanup;
  // useSyncExternalStore removes its listener and the ref becomes unreachable on unmount.

  const entries = usage.ranking
  const handles = entries.map((entry) => entry.row.handle)
  const pageCount = Math.max(1, Math.ceil(entries.length / SESSIONS_OVERVIEW_PAGE_SIZE))
  const boundedPage = Math.min(pageIndex, pageCount - 1)
  const pageStart = boundedPage * SESSIONS_OVERVIEW_PAGE_SIZE
  const pageRows = entries.slice(pageStart, pageStart + SESSIONS_OVERVIEW_PAGE_SIZE)
  useEffect(() => {
    if (boundedPage !== pageIndex) setPageIndex(boundedPage)
  }, [boundedPage, pageIndex])
  useEffect(() => {
    const selectedIndex = selected ? handles.indexOf(selected) : -1
    if (selectedIndex >= 0) {
      const selectedPage = Math.floor(selectedIndex / SESSIONS_OVERVIEW_PAGE_SIZE)
      if (selectedPage !== boundedPage) {
        if (document.activeElement === document.body) pendingFocus.current = selected
        setPageIndex(selectedPage)
      }
      return
    }
    onSelect(handles[0])
  }, [boundedPage, handles, onSelect, selected])
  useEffect(() => {
    const handle = pendingFocus.current
    if (!handle || !pageRows.some((entry) => entry.row.handle === handle)) return
    pendingFocus.current = undefined
    rowElements.current.get(handle)?.focus()
  }, [pageRows])

  const maxRankValue = Math.max(1, ...entries.map((entry) => entry.rankValue ?? 0))
  const selectMode = (nextMode: SessionsUsageMode): void => {
    if (nextMode === mode) return
    source.configure(projectionRef.current, rows, nextMode, windowMs)
    setMode(nextMode)
  }
  const showPage = (next: number): void => {
    const bounded = Math.min(Math.max(next, 0), pageCount - 1)
    const target = entries[bounded * SESSIONS_OVERVIEW_PAGE_SIZE]
    setPageIndex(bounded)
    if (!target) return
    onSelect(target.row.handle)
    pendingFocus.current = target.row.handle
  }
  const moveFocus = (
    event: ReactKeyboardEvent<HTMLElement>,
    handle: SessionsTerminalHandle,
  ): void => {
    if (event.target !== event.currentTarget) return
    const index = handles.indexOf(handle)
    const nextIndex =
      event.key === 'ArrowDown'
        ? Math.min(index + 1, handles.length - 1)
        : event.key === 'ArrowUp'
          ? Math.max(index - 1, 0)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? handles.length - 1
              : undefined
    if (nextIndex === undefined) return
    event.preventDefault()
    const nextHandle = handles[nextIndex]
    if (!nextHandle) return
    onSelect(nextHandle)
    const nextPage = Math.floor(nextIndex / SESSIONS_OVERVIEW_PAGE_SIZE)
    if (nextPage === boundedPage) rowElements.current.get(nextHandle)?.focus()
    else {
      pendingFocus.current = nextHandle
      setPageIndex(nextPage)
    }
  }

  return (
    <section className="sessions-usage" aria-labelledby="sessions-usage-title">
      <header className="sessions-usage-header">
        <div>
          <h2 id="sessions-usage-title">Token usage</h2>
          <p>{usageStatus(usage.status, usage.sampledAt, mode, entries)}</p>
        </div>
        <div className="sessions-usage-modes" aria-label="Usage view">
          <button
            type="button"
            aria-pressed={mode === 'recent'}
            onClick={() => selectMode('recent')}
          >
            Recent
          </button>
          <button
            type="button"
            aria-pressed={mode === 'session-total'}
            onClick={() => selectMode('session-total')}
          >
            Session total
          </button>
        </div>
      </header>
      {mode === 'recent' ? (
        <fieldset className="sessions-usage-windows">
          <legend>Recent window</legend>
          {SESSIONS_USAGE_WINDOWS.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={windowMs === value}
              onClick={() => setWindowMs(value)}
            >
              {durationLabel(value)}
            </button>
          ))}
        </fieldset>
      ) : null}
      {!foreground ? (
        <section className="sessions-notice">
          <h2>Updates paused</h2>
          <p>Focus hvir to begin a fresh Usage baseline.</p>
        </section>
      ) : projection.status === 'pending' ? (
        <section className="sessions-notice">
          <h2>Loading sessions</h2>
          <p>Usage will begin after the current Sessions projection is available.</p>
        </section>
      ) : projection.status === 'unavailable' ? (
        <section className="sessions-notice">
          <h2>Usage unavailable</h2>
          <p>The current Sessions projection could not be read.</p>
        </section>
      ) : rows.length === 0 ? (
        <section className="sessions-notice">
          <h2>No sessions match</h2>
          <p>The active Sessions filter has no matching rows.</p>
        </section>
      ) : (
        <>
          <nav className="sessions-pagination" aria-label="Usage pages">
            <p>
              Showing {pageStart + 1}–
              {Math.min(pageStart + pageRows.length, entries.length)} of {entries.length}{' '}
              sessions
            </p>
            <div>
              <button
                type="button"
                disabled={boundedPage === 0}
                onClick={() => showPage(boundedPage - 1)}
              >
                Previous page
              </button>
              <span>
                Page {boundedPage + 1} of {pageCount}
              </span>
              <button
                type="button"
                disabled={boundedPage + 1 >= pageCount}
                onClick={() => showPage(boundedPage + 1)}
              >
                Next page
              </button>
            </div>
          </nav>
          <ul className="sessions-usage-ranking" aria-label="Session token usage">
            {pageRows.map((entry) => (
              <li
                key={entry.row.handle}
                className={[
                  selected === entry.row.handle ? 'selected' : undefined,
                  entry.rank === undefined ? 'compact' : undefined,
                ]
                  .filter(Boolean)
                  .join(' ')}
                aria-current={selected === entry.row.handle ? 'true' : undefined}
                tabIndex={selected === entry.row.handle ? 0 : -1}
                ref={(element) => {
                  if (element) rowElements.current.set(entry.row.handle, element)
                  else rowElements.current.delete(entry.row.handle)
                }}
                onFocus={() => onSelect(entry.row.handle)}
                onClick={() => onSelect(entry.row.handle)}
                onKeyDown={(event) => moveFocus(event, entry.row.handle)}
              >
                <UsageRankRow
                  entry={entry}
                  mode={mode}
                  windowMs={windowMs}
                  maxRankValue={maxRankValue}
                  sampledAt={usage.sampledAt}
                />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

function UsageRankRow({
  entry,
  mode,
  windowMs,
  maxRankValue,
  sampledAt,
}: {
  readonly entry: SessionsUsageRankedRow
  readonly mode: SessionsUsageMode
  readonly windowMs: SessionsUsageWindow
  readonly maxRankValue: number
  readonly sampledAt: number
}): ReactElement {
  const value = mode === 'recent' ? entry.recent.value : usageValue(entry.usage)
  const primary = primaryUsage(entry, mode, windowMs)
  const categories = [
    ['fresh-input', value.freshInputTokens],
    ['cache-read', value.cacheReadInputTokens],
    ['cache-write', value.cacheWriteInputTokens],
    ['output', value.outputTokens],
  ] as const
  return (
    <article>
      <header>
        <div className="sessions-usage-rank">
          {entry.rank === undefined ? 'Not ranked' : `Rank ${entry.rank}`}
        </div>
        <div>
          <h3>{entry.row.title}</h3>
          <p>
            {entry.row.project.name} / {entry.row.workspace.name} ·{' '}
            {entry.row.provider.name}
          </p>
        </div>
        <strong>
          <span aria-hidden="true">{primary.compact}</span>
          <span className="sessions-visually-hidden">{primary.accessible}</span>
        </strong>
      </header>
      {primary.barScale ? (
        <div
          className={`sessions-usage-bar ${primary.barScale}`}
          data-scale={primary.barScale}
          aria-hidden="true"
        >
          {categories.map(([name, categoryValue]) => (
            <span
              key={name}
              className={name}
              style={{
                width: `${
                  categoryValue === undefined
                    ? 0
                    : (categoryValue /
                        (primary.barScale === 'ranked'
                          ? maxRankValue
                          : primary.barValue)) *
                      100
                }%`,
              }}
            />
          ))}
        </div>
      ) : null}
      {entry.rank === undefined ? (
        <p className="sessions-usage-compact-state">
          {compactState(entry, mode, windowMs, sampledAt)}
        </p>
      ) : (
        <dl>
          <UsageFact label="Recent" value={recentLabel(entry, windowMs)} />
          <UsageFact label="Session total" value={cumulativeLabel(entry.usage)} />
          <UsageFact
            label="Coverage"
            value={`${coverageLabel(entry.recent.coverage)} · ${entry.recent.coveragePercent}% of ${durationLabel(windowMs)}`}
          />
          <UsageFact
            label="Cumulative freshness"
            value={freshnessLabel(entry.usage, sampledAt)}
          />
          <UsageFact
            label="Last activity"
            value={
              entry.recent.lastActivityAt === undefined
                ? 'No positive observed change'
                : relativeAge(entry.recent.lastActivityAt, sampledAt)
            }
          />
        </dl>
      )}
      {hasPositiveCategories(value) ? (
        <details>
          <summary>Token categories</summary>
          <dl className="sessions-usage-categories">
            <UsageFact
              className="fresh-input"
              label="Fresh input"
              value={counterLabel(value.freshInputTokens)}
            />
            <UsageFact
              className="cache-read"
              label="Cache read"
              value={counterLabel(value.cacheReadInputTokens)}
            />
            <UsageFact
              className="cache-write"
              label="Cache write"
              value={counterLabel(value.cacheWriteInputTokens)}
            />
            <UsageFact
              className="output"
              label="Output"
              value={counterLabel(value.outputTokens)}
            />
            <UsageFact
              label="Reasoning (part of output)"
              value={counterLabel(value.reasoningTokens)}
            />
          </dl>
        </details>
      ) : null}
    </article>
  )
}

function UsageFact({
  label,
  value,
  className,
}: {
  readonly label: string
  readonly value: string
  readonly className?: string
}): ReactElement {
  return (
    <div className={className}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}
