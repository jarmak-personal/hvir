import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react'

import type {
  ProjectState,
  SessionsLivePtyQualifier,
  SessionsOpenUnavailableReason,
  SessionsProjectionRow,
  SessionsTerminalHandle,
  SessionsWorkspaceQualifier,
} from '../../../shared'
import { SessionsOverviewCard } from './SessionsOverviewCard'
import { SessionsCollectionToolbar, type SessionsLens } from './SessionsCollectionToolbar'
import { SessionsTerminalDetail } from './SessionsTerminalDetail'
import { SessionsUsageLens } from './SessionsUsageLens'
import {
  SessionsProjectionCoordinator,
  createSessionsMainObservationPort,
} from './sessions-projection-coordinator'
import type { SessionsRendererObservationPort } from './sessions-renderer-observation'
import {
  sessionsTerminalSurfaceAvailable,
  type SessionsTerminalSurfacePort,
} from './sessions-terminal-surface'
import { useSessionsForeground } from './use-sessions-foreground'
import { useSessionsTerminalDetail } from './use-sessions-terminal-detail'
import {
  DEFAULT_SESSIONS_OVERVIEW_POLICY,
  SESSIONS_OVERVIEW_PAGE_SIZE,
  sessionsOverviewFocusFallback,
  sessionsOverviewGroups,
  sessionsOverviewMatchesFilter,
  sessionsOverviewPage,
  sessionsOverviewPolicyLabel,
  sessionsOverviewRows,
  type SessionsOverviewPolicy,
} from './sessions-overview-model'

interface SessionsOverviewProps {
  readonly observation: SessionsRendererObservationPort
  readonly surface: SessionsTerminalSurfacePort
  readonly onReturn: () => void
  readonly onOpened: (state: ProjectState) => void
  readonly onFocusOpened: (
    handle: SessionsTerminalHandle,
    workspaceQualifier: SessionsWorkspaceQualifier,
    livePty: SessionsLivePtyQualifier,
  ) => Promise<boolean>
  readonly onOpenFailed: (message: string) => void
}

export function SessionsOverview({
  observation,
  surface,
  onReturn,
  onOpened,
  onFocusOpened,
  onOpenFailed,
}: SessionsOverviewProps): ReactElement {
  const coordinator = useRef<SessionsProjectionCoordinator | undefined>(undefined)
  coordinator.current ??= new SessionsProjectionCoordinator(
    createSessionsMainObservationPort(window.hvir),
    observation,
  )
  const source = coordinator.current
  const foreground = useSessionsForeground()
  const snapshot = useSyncExternalStore(
    source.subscribe,
    source.snapshot,
    source.snapshot,
  )
  const { controller: detail, state: detailState } = useSessionsTerminalDetail({
    surface,
    snapshot,
    foreground,
  })
  const [policy, setPolicy] = useState<SessionsOverviewPolicy>(
    DEFAULT_SESSIONS_OVERVIEW_POLICY,
  )
  const [lens, setLens] = useState<SessionsLens>('overview')
  const [selected, setSelected] = useState<SessionsTerminalHandle>()
  const [feedback, setFeedback] = useState<string>()
  const [opening, setOpening] = useState<SessionsTerminalHandle>()
  const [pageIndex, setPageIndex] = useState(0)
  const previousOrder = useRef<readonly SessionsTerminalHandle[]>([])
  const pendingFocus = useRef<SessionsTerminalHandle | undefined>(undefined)
  const rowElements = useRef(new Map<SessionsTerminalHandle, HTMLElement>())
  const collectionControl = useRef<HTMLButtonElement>(null)
  const openGeneration = useRef(0)

  useEffect(() => {
    if (!foreground) return
    const release = source.acquire()
    return release
  }, [foreground, source])
  useEffect(() => {
    if (foreground) return
    openGeneration.current += 1
    previousOrder.current = []
    rowElements.current.clear()
    setSelected(undefined)
    setOpening(undefined)
    setFeedback(undefined)
    setPageIndex(0)
  }, [foreground])
  useEffect(
    () => () => {
      openGeneration.current += 1
    },
    [],
  )

  const allGroups = useMemo(
    () => sessionsOverviewGroups(snapshot.rows, policy),
    [policy, snapshot.rows],
  )
  const rows = useMemo(() => sessionsOverviewRows(allGroups), [allGroups])
  const usageRows = useMemo(
    () =>
      snapshot.rows.filter((row) => sessionsOverviewMatchesFilter(row, policy.filter)),
    [policy.filter, snapshot.rows],
  )
  const handles = useMemo(() => rows.map((row) => row.handle), [rows])
  const page = useMemo(
    () => sessionsOverviewPage(allGroups, pageIndex),
    [allGroups, pageIndex],
  )
  useEffect(() => {
    if (page.pageIndex !== pageIndex) setPageIndex(page.pageIndex)
  }, [page.pageIndex, pageIndex])
  useEffect(() => {
    const selectedDisappeared = selected !== undefined && !handles.includes(selected)
    const next = sessionsOverviewFocusFallback(previousOrder.current, handles, selected)
    previousOrder.current = handles
    const nextIndex = next ? handles.indexOf(next) : -1
    if (nextIndex >= 0) {
      const nextPage = Math.floor(nextIndex / SESSIONS_OVERVIEW_PAGE_SIZE)
      if (nextPage !== pageIndex) setPageIndex(nextPage)
    }
    if (next !== selected) {
      setSelected(next)
    }
    if (selectedDisappeared && document.activeElement === document.body) {
      if (next) pendingFocus.current = next
      else collectionControl.current?.focus()
    }
  }, [handles, pageIndex, selected])
  useEffect(() => {
    const handle = pendingFocus.current
    if (!handle || !page.rows.some((row) => row.handle === handle)) return
    pendingFocus.current = undefined
    rowElements.current.get(handle)?.focus()
  }, [page.rows])
  useLayoutEffect(() => {
    if (detailState.status !== 'inactive') return
    const handle = pendingFocus.current
    if (!handle) return
    pendingFocus.current = undefined
    rowElements.current.get(handle)?.focus()
  }, [detailState.status])

  const updatePolicy = <K extends keyof SessionsOverviewPolicy>(
    key: K,
    value: SessionsOverviewPolicy[K],
  ): void => {
    setPolicy((current) => ({ ...current, [key]: value }))
    setSelected(undefined)
    setPageIndex(0)
    setFeedback(undefined)
  }

  const open = useCallback(
    async (row: SessionsProjectionRow): Promise<void> => {
      if (opening) return
      const captured = source.snapshot()
      const generation = (openGeneration.current += 1)
      setOpening(row.handle)
      setFeedback('Opening exact terminal…')
      try {
        const result = await window.hvir.invoke('sessions:open', {
          demandGeneration: captured.demandGeneration,
          sourceRevision: captured.sourceRevision,
          handle: row.handle,
          projectId: row.project.id,
          workspaceId: row.workspace.id,
          workspaceQualifier: row.workspace.qualifier,
          livePty: row.livePty,
        })
        if (generation !== openGeneration.current) return
        if (result.outcome === 'unavailable') {
          setFeedback(
            openUnavailableMessage(
              source.snapshot().revision !== captured.revision
                ? 'stale-projection'
                : result.reason,
            ),
          )
          return
        }
        onOpened(result.state)
        const focused = await onFocusOpened(
          result.handle,
          result.workspaceQualifier,
          result.livePty,
        )
        if (!focused)
          onOpenFailed('The exact terminal changed before it could receive focus')
      } catch {
        if (generation === openGeneration.current) {
          setFeedback('The exact terminal could not be opened')
        }
      } finally {
        if (generation === openGeneration.current) setOpening(undefined)
      }
    },
    [onFocusOpened, onOpenFailed, onOpened, opening, source],
  )

  const moveFocus = (
    event: ReactKeyboardEvent<HTMLElement>,
    row: SessionsProjectionRow,
  ): void => {
    if (event.target !== event.currentTarget) return
    const index = handles.indexOf(row.handle)
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
    const next = handles[nextIndex]
    if (!next) return
    setSelected(next)
    const nextPage = Math.floor(nextIndex / SESSIONS_OVERVIEW_PAGE_SIZE)
    if (nextPage === page.pageIndex) rowElements.current.get(next)?.focus()
    else {
      pendingFocus.current = next
      setPageIndex(nextPage)
    }
  }

  const showPage = (nextPage: number): void => {
    const next = sessionsOverviewPage(allGroups, nextPage)
    const target = next.rows[0]
    setPageIndex(next.pageIndex)
    if (!target) return
    setSelected(target.handle)
    pendingFocus.current = target.handle
  }

  const policyLabel = sessionsOverviewPolicyLabel(policy)
  if (detailState.status !== 'inactive') {
    return (
      <SessionsTerminalDetail
        controller={detail}
        state={detailState}
        onBack={() => {
          pendingFocus.current = detail.selectedHandle()
          detail.close()
        }}
        onReturn={() => {
          detail.close()
          onReturn()
        }}
      />
    )
  }
  return (
    <main className="sessions-overview" aria-labelledby="sessions-title">
      <header className="sessions-overview-header">
        <div>
          <p className="sessions-eyebrow">Application sessions</p>
          <h1 id="sessions-title">Sessions</h1>
          <p>Live and retained hvir terminals across every registered workspace.</p>
        </div>
        <button type="button" className="sessions-return" onClick={onReturn}>
          Return to current workspace
        </button>
      </header>
      <SessionsCollectionToolbar
        lens={lens}
        policy={policy}
        collectionControl={collectionControl}
        onLens={(value) => {
          setLens(value)
          setFeedback(undefined)
        }}
        onFilter={(value) => updatePolicy('filter', value)}
        onGroup={(value) => updatePolicy('group', value)}
        onSort={(value) => updatePolicy('sort', value)}
      />
      {feedback ? (
        <p className="sessions-feedback" role="status">
          {feedback}
        </p>
      ) : null}
      {lens === 'usage' ? (
        <SessionsUsageLens
          projection={snapshot}
          rows={usageRows}
          foreground={foreground}
          selected={selected}
          onSelect={setSelected}
        />
      ) : !foreground ? (
        <OverviewNotice title="Updates paused" detail="Focus hvir to refresh Sessions." />
      ) : snapshot.status === 'pending' ? (
        <OverviewNotice
          title="Loading sessions"
          detail="Reading the current hvir-owned session projection."
        />
      ) : snapshot.status === 'unavailable' ? (
        <OverviewNotice
          title="Sessions unavailable"
          detail="The current projection could not be read."
          action={
            <button type="button" onClick={() => source.retry()}>
              Retry
            </button>
          }
        />
      ) : snapshot.status === 'available' && snapshot.rows.length === 0 ? (
        <OverviewNotice
          title="No hvir sessions"
          detail="Start a terminal from a workspace to see it here."
        />
      ) : snapshot.status === 'available' && rows.length === 0 ? (
        <OverviewNotice
          title="No sessions match"
          detail={policyLabel}
          action={
            <button
              type="button"
              onClick={() => {
                setPolicy(DEFAULT_SESSIONS_OVERVIEW_POLICY)
                setSelected(undefined)
                setPageIndex(0)
                setFeedback(undefined)
              }}
            >
              Reset filters
            </button>
          }
        />
      ) : (
        <>
          <nav className="sessions-pagination" aria-label="Sessions pages">
            <p aria-live="polite">
              Showing {page.start + 1}–{page.end} of {page.totalRows} sessions
            </p>
            <div>
              <button
                type="button"
                disabled={page.pageIndex === 0}
                onClick={() => showPage(page.pageIndex - 1)}
              >
                Previous page
              </button>
              <span>
                Page {page.pageIndex + 1} of {page.pageCount}
              </span>
              <button
                type="button"
                disabled={page.pageIndex + 1 >= page.pageCount}
                onClick={() => showPage(page.pageIndex + 1)}
              >
                Next page
              </button>
            </div>
          </nav>
          <div className="sessions-groups" role="list" aria-label="hvir sessions">
            {page.groups.map((group) => (
              <section className="sessions-group" key={group.key}>
                {group.label ? <h2>{group.label}</h2> : null}
                <div className="sessions-grid">
                  {group.rows.map((row) => {
                    const isSelected = selected === row.handle
                    return (
                      <article
                        key={row.handle}
                        className={`session-card${isSelected ? ' selected' : ''}`}
                        role="listitem"
                        aria-current={isSelected ? 'true' : undefined}
                        aria-label={`${row.title}, ${row.provider.name}, ${row.project.name}, ${row.workspace.name}`}
                        tabIndex={isSelected ? 0 : -1}
                        ref={(element) => {
                          if (element) rowElements.current.set(row.handle, element)
                          else rowElements.current.delete(row.handle)
                        }}
                        onFocus={() => setSelected(row.handle)}
                        onClick={() => setSelected(row.handle)}
                        onKeyDown={(event) => {
                          if (
                            event.key === 'Enter' &&
                            event.target === event.currentTarget
                          ) {
                            event.preventDefault()
                            void open(row)
                            return
                          }
                          moveFocus(event, row)
                        }}
                      >
                        <SessionsOverviewCard
                          row={row}
                          opening={opening === row.handle}
                          onOpen={() => void open(row)}
                          onInteract={
                            sessionsTerminalSurfaceAvailable(row, surface)
                              ? () => detail.open(row, source.snapshot(), foreground)
                              : undefined
                          }
                        />
                      </article>
                    )
                  })}
                </div>
              </section>
            ))}
          </div>
        </>
      )}
    </main>
  )
}

function OverviewNotice({
  title,
  detail,
  action,
}: {
  readonly title: string
  readonly detail: string
  readonly action?: ReactElement
}): ReactElement {
  return (
    <section className="sessions-notice">
      <h2>{title}</h2>
      <p>{detail}</p>
      {action}
    </section>
  )
}

function openUnavailableMessage(reason: SessionsOpenUnavailableReason): string {
  switch (reason) {
    case 'stale-projection':
      return 'Sessions changed. Review the refreshed row before opening it.'
    case 'session-unavailable':
      return 'This session is no longer available.'
    case 'workspace-unavailable':
      return 'The owning workspace is not available.'
    case 'connection-unavailable':
      return 'The host is disconnected. Reconnect from the workspace before opening it.'
    case 'terminal-unavailable':
      return 'This session does not have the same live terminal anymore.'
  }
}
