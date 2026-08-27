import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react'

import type {
  HarnessUsageValue,
  SessionsProjectionSnapshot,
  SessionsTerminalHandle,
  SessionsUsageFact,
} from '../../../shared'
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

  const ranked = usage.ranking
  const handles = ranked.map((entry) => entry.row.handle)
  const pageCount = Math.max(1, Math.ceil(ranked.length / SESSIONS_OVERVIEW_PAGE_SIZE))
  const boundedPage = Math.min(pageIndex, pageCount - 1)
  const pageStart = boundedPage * SESSIONS_OVERVIEW_PAGE_SIZE
  const pageRows = ranked.slice(pageStart, pageStart + SESSIONS_OVERVIEW_PAGE_SIZE)
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

  const maxValue = Math.max(1, ...ranked.map((entry) => entry.rankValue ?? 0))
  const showPage = (next: number): void => {
    const bounded = Math.min(Math.max(next, 0), pageCount - 1)
    const target = ranked[bounded * SESSIONS_OVERVIEW_PAGE_SIZE]
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
          <h2 id="sessions-usage-title">Token usage ranking</h2>
          <p>{usageStatus(usage.status, usage.sampledAt)}</p>
        </div>
        <div className="sessions-usage-modes" aria-label="Usage ranking mode">
          <button
            type="button"
            aria-pressed={mode === 'recent'}
            onClick={() => setMode('recent')}
          >
            Recent
          </button>
          <button
            type="button"
            aria-pressed={mode === 'session-total'}
            onClick={() => setMode('session-total')}
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
          <nav className="sessions-pagination" aria-label="Usage ranking pages">
            <p>
              Showing {pageStart + 1}–
              {Math.min(pageStart + pageRows.length, ranked.length)} of {ranked.length}{' '}
              ranked sessions
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
          <ol className="sessions-usage-ranking" aria-label="Session token usage ranking">
            {pageRows.map((entry) => (
              <li
                key={entry.row.handle}
                className={selected === entry.row.handle ? 'selected' : undefined}
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
                  maxValue={maxValue}
                  sampledAt={usage.sampledAt}
                />
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  )
}

function UsageRankRow({
  entry,
  mode,
  windowMs,
  maxValue,
  sampledAt,
}: {
  readonly entry: SessionsUsageRankedRow
  readonly mode: SessionsUsageMode
  readonly windowMs: SessionsUsageWindow
  readonly maxValue: number
  readonly sampledAt: number
}): ReactElement {
  const value = mode === 'recent' ? entry.recent.value : usageValue(entry.usage)
  const primary = entry.rankValue
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
          <span aria-hidden="true">{usageValueCompact(primary, entry, mode)}</span>
          <span className="sessions-visually-hidden">
            {usageValueAccessible(primary, entry, mode, windowMs)}
          </span>
        </strong>
      </header>
      <div className="sessions-usage-bar" aria-hidden="true">
        {categories.map(([name, categoryValue]) => (
          <span
            key={name}
            className={name}
            style={{
              width: `${
                primary === undefined || categoryValue === undefined
                  ? 0
                  : (categoryValue / maxValue) * 100
              }%`,
            }}
          />
        ))}
      </div>
      <dl>
        <UsageFact label="Recent" value={recentLabel(entry, windowMs)} />
        <UsageFact label="Session total" value={cumulativeLabel(entry.usage)} />
        <UsageFact
          label="Coverage"
          value={`${coverageLabel(entry.recent.coverage)} · ${entry.recent.coveragePercent}% of ${durationLabel(windowMs)}`}
        />
        <UsageFact label="Freshness" value={freshnessLabel(entry.usage, sampledAt)} />
        <UsageFact
          label="Last activity"
          value={
            entry.recent.lastActivityAt === undefined
              ? 'No positive observed change'
              : relativeAge(entry.recent.lastActivityAt, sampledAt)
          }
        />
      </dl>
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

function usageValue(fact: SessionsUsageFact): HarnessUsageValue {
  return fact.status === 'exact' || fact.status === 'partial' || fact.status === 'stale'
    ? fact.value
    : {}
}

function recentLabel(entry: SessionsUsageRankedRow, windowMs: number): string {
  const total = entry.recent.value.normalizedTokenTotal
  if (total !== undefined) {
    return total === 0
      ? `No activity in ${durationLabel(windowMs)}`
      : `${total.toLocaleString()} tokens in ${durationLabel(windowMs)}`
  }
  return `${coverageLabel(entry.recent.coverage)} observation · exact total unavailable`
}

function cumulativeLabel(fact: SessionsUsageFact): string {
  if (fact.status === 'exact') {
    return `${fact.value.normalizedTokenTotal?.toLocaleString()} tokens`
  }
  if (fact.status === 'partial') return 'Partial categories · exact total unavailable'
  if (fact.status === 'stale') return 'Stale cumulative observation'
  return `${sentenceCase(fact.status)} · ${'reason' in fact ? sentenceCase(fact.reason) : 'capability state'}`
}

function freshnessLabel(fact: SessionsUsageFact, sampledAt: number): string {
  if (fact.status === 'exact' || fact.status === 'partial' || fact.status === 'stale') {
    return `${sentenceCase(fact.status)} · observed ${relativeAge(fact.observedAt, sampledAt)}`
  }
  return sentenceCase(fact.status)
}

function usageValueAccessible(
  value: number | undefined,
  entry: SessionsUsageRankedRow,
  mode: SessionsUsageMode,
  windowMs: number,
): string {
  if (value === undefined) return `${sentenceCase(entry.usage.status)} usage; not ranked`
  return `${entry.rank === undefined ? '' : `Rank ${entry.rank}; `}${value.toLocaleString()} tokens ${
    mode === 'recent' ? `in the last ${durationLabel(windowMs)}` : 'for this session'
  }`
}

function usageValueCompact(
  value: number | undefined,
  entry: SessionsUsageRankedRow,
  mode: SessionsUsageMode,
): string {
  if (value === undefined) return sentenceCase(entry.usage.status)
  if (mode === 'recent' && value === 0) return 'No activity'
  return new Intl.NumberFormat(undefined, { notation: 'compact' }).format(value)
}

function usageStatus(
  status: 'inactive' | 'pending' | 'available' | 'unavailable',
  sampledAt: number,
): string {
  if (status === 'pending') return 'Newly observing; the first exact value is a baseline.'
  if (status === 'unavailable') return 'Usage observation is currently unavailable.'
  if (status === 'inactive') return 'Usage observation is inactive.'
  return `Sampling latest cumulative observations · updated ${relativeAge(sampledAt, Date.now())}`
}

function counterLabel(value: number | undefined): string {
  return value === undefined ? 'Unavailable' : `${value.toLocaleString()} tokens`
}

function coverageLabel(value: SessionsUsageRankedRow['recent']['coverage']): string {
  switch (value) {
    case 'complete':
      return 'Complete coverage'
    case 'partial':
      return 'Partial coverage'
    case 'none':
      return 'No current coverage'
    case 'reset':
      return 'Reset boundary'
  }
}

function durationLabel(milliseconds: number): string {
  const minutes = milliseconds / 60_000
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
}

function relativeAge(then: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - then) / 1_000))
  if (seconds < 2) return 'just now'
  if (seconds < 60) return `${seconds} seconds ago`
  const minutes = Math.floor(seconds / 60)
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`
}

function sentenceCase(value: string): string {
  const spaced = value.replaceAll('-', ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}
