import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'

import {
  basenameHostPath,
  type HarnessTelemetry,
  type HostConnectionState,
  type HostPath,
  type TerminalAdapterId,
  type TerminalIdentityStatus,
  type TerminalRecoverySession,
} from '../../../shared'
import {
  nextTerminalAttention,
  terminalAttentionLabel,
  terminalAttentionRollup,
  terminalIdleAttentionAfterInput,
  terminalOutputAttentionDecision,
  type TerminalAttention,
  type TerminalIdleAttentionState,
} from './terminal-attention'
import { PaneResizer } from '../layout/PaneResizer'
import type { TerminalRecoveryMode, TerminalThemeOverride } from '../settings/settings'
import { useAppTheme } from '../theme'
import {
  resolveTerminalFileTarget,
  type ResolvedTerminalFileTarget,
} from './terminal-file-link'
import { TerminalView } from './TerminalView'

interface TerminalSession {
  readonly id: string
  readonly adapterId: TerminalAdapterId
  readonly fallbackTitle: string
  readonly title: string
  readonly status: string
  readonly attention?: TerminalAttention
  readonly telemetry?: HarnessTelemetry
  readonly harnessSessionId?: string
  readonly identityStatus?: TerminalIdentityStatus
  readonly resumeOnStart: boolean
  readonly pane: TerminalSplitPane
}

type TerminalSplitPane = 'primary' | 'secondary'

interface TerminalWorkspaceProps {
  readonly cwd: HostPath
  readonly workspaceId: string
  readonly connectionState: HostConnectionState
  readonly available: boolean
  readonly visible: boolean
  readonly label: string
  readonly onRollup: (workspaceId: string, rollup: TerminalWorkspaceRollup) => void
  readonly onOpenPath: (target: ResolvedTerminalFileTarget) => void
  readonly idleThresholdMs: number
  readonly recoveryMode: TerminalRecoveryMode
  readonly terminalTheme: TerminalThemeOverride
  readonly onOpenSettings: () => void
}

export interface TerminalWorkspaceRollup {
  readonly unseen: number
  readonly actionable: number
}

const adapterLabels: Record<TerminalAdapterId, string> = {
  'plain-shell': 'Shell',
  'claude-code': 'Claude Code',
  codex: 'Codex',
}

export function TerminalWorkspace({
  cwd,
  workspaceId,
  connectionState,
  available,
  visible,
  label,
  onRollup,
  onOpenPath,
  idleThresholdMs,
  recoveryMode,
  terminalTheme,
  onOpenSettings,
}: TerminalWorkspaceProps): ReactElement {
  const appTheme = useAppTheme()
  const effectiveTerminalTheme = terminalTheme === 'app' ? appTheme : terminalTheme
  const workspaceRootRef = useRef(cwd)
  if (
    workspaceRootRef.current.hostId !== cwd.hostId ||
    workspaceRootRef.current.path !== cwd.path
  ) {
    workspaceRootRef.current = cwd
  }
  const workspaceRoot = workspaceRootRef.current
  const terminalDeckRef = useRef<HTMLDivElement>(null)
  const restoredSplitLayout = useRef(readTerminalSplitLayout(workspaceRoot))
  const [sessions, setSessions] = useState<readonly TerminalSession[]>([])
  const [activeId, setActiveId] = useState<string>()
  const [menuOpen, setMenuOpen] = useState(false)
  const [recoveryReady, setRecoveryReady] = useState(false)
  const [recoveryCandidates, setRecoveryCandidates] = useState<
    readonly TerminalRecoverySession[]
  >([])
  const recoveryModeRef = useRef(recoveryMode)
  const activeIdRef = useRef(activeId)
  const activePaneRef = useRef<TerminalSplitPane>('primary')
  const activeByPaneRef = useRef<Record<TerminalSplitPane, string | undefined>>({
    primary: undefined,
    secondary: undefined,
  })
  const sessionsRef = useRef(sessions)
  const appFocusedRef = useRef(document.hasFocus())
  const focusedTerminalRef = useRef<string | undefined>(undefined)
  const idleTimers = useRef(new Map<string, number>())
  const idleAttentionStates = useRef(new Map<string, TerminalIdleAttentionState>())
  const visibleRef = useRef(visible)
  const availableRef = useRef(available)
  const shouldCreateDefault = useRef(false)
  activeIdRef.current = activeId
  sessionsRef.current = sessions
  visibleRef.current = visible
  availableRef.current = available
  recoveryModeRef.current = recoveryMode

  useEffect(() => {
    const timers = idleTimers.current
    const focused = (): void => {
      appFocusedRef.current = true
      focusedTerminalRef.current =
        document.activeElement instanceof Element
          ? document.activeElement.closest<HTMLElement>('[data-terminal-session]')
              ?.dataset['terminalSession']
          : undefined
    }
    const blurred = (): void => {
      appFocusedRef.current = false
      focusedTerminalRef.current = undefined
    }
    const trackFocus = (event: FocusEvent): void => {
      const terminal =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>('[data-terminal-session]')
          : null
      focusedTerminalRef.current = terminal?.dataset['terminalSession']
    }
    const trackPointer = (event: PointerEvent): void => {
      if (
        event.target instanceof Element &&
        !event.target.closest('[data-terminal-session]')
      ) {
        focusedTerminalRef.current = undefined
      }
    }
    window.addEventListener('focus', focused)
    window.addEventListener('blur', blurred)
    window.addEventListener('focusin', trackFocus)
    window.addEventListener('pointerdown', trackPointer, true)
    return () => {
      window.removeEventListener('focus', focused)
      window.removeEventListener('blur', blurred)
      window.removeEventListener('focusin', trackFocus)
      window.removeEventListener('pointerdown', trackPointer, true)
      for (const timer of timers.values()) window.clearTimeout(timer)
      timers.clear()
    }
  }, [])

  useEffect(() => {
    if (!menuOpen) return
    const close = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setMenuOpen(false)
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [menuOpen])

  useEffect(() => {
    let cancelled = false
    for (const timer of idleTimers.current.values()) window.clearTimeout(timer)
    idleTimers.current.clear()
    idleAttentionStates.current.clear()
    focusedTerminalRef.current = undefined
    setRecoveryReady(false)
    setRecoveryCandidates([])
    setSessions([])
    setActiveId(undefined)
    activePaneRef.current = 'primary'
    activeByPaneRef.current = { primary: undefined, secondary: undefined }
    void window.hvir.invoke('terminal:recovery', { root: workspaceRoot }).then(
      (candidates) => {
        if (cancelled) return
        if (candidates.length === 0) {
          shouldCreateDefault.current = availableRef.current
          if (visibleRef.current && availableRef.current) {
            const session = createSession('plain-shell', workspaceRoot, 'primary')
            shouldCreateDefault.current = false
            setSessions([session])
            setActiveId(session.id)
          }
          setRecoveryReady(true)
          return
        }
        if (recoveryModeRef.current === 'auto' && visibleRef.current) {
          restoreSessions(
            candidates,
            restoredSplitLayout.current,
            setSessions,
            setActiveId,
          )
          setRecoveryReady(true)
          return
        }
        setRecoveryCandidates(candidates)
      },
      () => {
        if (cancelled) return
        if (availableRef.current) {
          const session = createSession('plain-shell', workspaceRoot, 'primary')
          setSessions([session])
          setActiveId(session.id)
        }
        setRecoveryReady(true)
      },
    )
    return () => {
      cancelled = true
    }
  }, [workspaceRoot])

  useEffect(() => {
    if (!available || !visible || sessions.length > 0) return
    if (recoveryCandidates.length > 0 && recoveryMode === 'auto') {
      restoreSessions(
        recoveryCandidates,
        restoredSplitLayout.current,
        setSessions,
        setActiveId,
      )
      setRecoveryCandidates([])
      setRecoveryReady(true)
      return
    }
    if (!recoveryReady) return
    if (!shouldCreateDefault.current || recoveryCandidates.length > 0) return
    shouldCreateDefault.current = false
    const session = createSession('plain-shell', workspaceRoot, 'primary')
    setSessions([session])
    setActiveId(session.id)
  }, [
    recoveryCandidates,
    recoveryMode,
    recoveryReady,
    available,
    sessions.length,
    visible,
    workspaceRoot,
  ])

  const layoutKey = JSON.stringify(
    sessions.map((session, position) => ({
      id: session.id,
      title: session.title,
      position,
      active: session.id === activeId,
      pane: session.pane,
    })),
  )
  useEffect(() => {
    if (!recoveryReady) return
    const layout = sessionsRef.current.map((session, position) => ({
      id: session.id,
      title: session.title,
      position,
      active: session.id === activeIdRef.current,
    }))
    void window.hvir
      .invoke('terminal:update-layout', { root: workspaceRoot, sessions: layout })
      .catch(() => undefined)
  }, [layoutKey, recoveryReady, workspaceRoot])

  useEffect(() => {
    if (!recoveryReady) return
    writeTerminalSplitLayout(workspaceRoot, {
      ...readTerminalSplitLayout(workspaceRoot),
      secondaryIds: sessions
        .filter((session) => session.pane === 'secondary')
        .map((session) => session.id),
    })
  }, [layoutKey, recoveryReady, sessions, workspaceRoot])

  useEffect(() => {
    const active = sessions.find((session) => session.id === activeId)
    if (!active) return
    activePaneRef.current = active.pane
    activeByPaneRef.current[active.pane] = active.id
  }, [activeId, sessions])

  const attentionRollup = terminalAttentionRollup(
    sessions.map((session) => session.attention),
  )
  useEffect(() => {
    onRollup(workspaceId, {
      unseen: attentionRollup.unseen,
      actionable: attentionRollup.actionable,
    })
  }, [attentionRollup.actionable, attentionRollup.unseen, onRollup, workspaceId])
  useEffect(
    () => () => onRollup(workspaceId, { unseen: 0, actionable: 0 }),
    [onRollup, workspaceId],
  )

  const updateSession = (
    id: string,
    update: (session: TerminalSession) => TerminalSession,
  ): void => {
    setSessions((current) => {
      let changed = false
      const next = current.map((session) => {
        if (session.id !== id) return session
        const updated = update(session)
        if (updated !== session) changed = true
        return updated
      })
      return changed ? next : current
    })
  }

  const focusSession = (id: string): void => {
    const timer = idleTimers.current.get(id)
    if (timer !== undefined) window.clearTimeout(timer)
    idleTimers.current.delete(id)
    focusedTerminalRef.current = id
    const pane = sessionsRef.current.find((session) => session.id === id)?.pane
    if (pane) {
      activePaneRef.current = pane
      activeByPaneRef.current[pane] = id
    }
    setActiveId(id)
    updateSession(id, (session) =>
      session.attention ? { ...session, attention: undefined } : session,
    )
  }

  const addSession = (adapterId: TerminalAdapterId): void => {
    if (!available) return
    const split = sessionsRef.current.some((session) => session.pane === 'secondary')
    const pane = split ? activePaneRef.current : 'primary'
    const session = createSession(adapterId, workspaceRoot, pane)
    setSessions((current) => [...current, session])
    activeByPaneRef.current[pane] = session.id
    setActiveId(session.id)
    setMenuOpen(false)
  }

  const splitTerminal = (): void => {
    if (!available) return
    const split = sessionsRef.current.some((session) => session.pane === 'secondary')
    const pane: TerminalSplitPane = split
      ? activePaneRef.current === 'primary'
        ? 'secondary'
        : 'primary'
      : 'secondary'
    const session = createSession('plain-shell', workspaceRoot, pane)
    activePaneRef.current = pane
    activeByPaneRef.current[pane] = session.id
    setSessions((current) => [...current, session])
    setActiveId(session.id)
  }

  const moveSessionToOtherPane = (id: string): void => {
    const session = sessionsRef.current.find((candidate) => candidate.id === id)
    if (!session) return
    const pane: TerminalSplitPane = session.pane === 'primary' ? 'secondary' : 'primary'
    if (activeByPaneRef.current[session.pane] === id) {
      activeByPaneRef.current[session.pane] = sessionsRef.current.find(
        (candidate) => candidate.pane === session.pane && candidate.id !== id,
      )?.id
    }
    activeByPaneRef.current[pane] = id
    activePaneRef.current = pane
    setSessions((current) =>
      current.map((candidate) =>
        candidate.id === id ? { ...candidate, pane } : candidate,
      ),
    )
    setActiveId(id)
  }

  const closeSession = (id: string): void => {
    const timer = idleTimers.current.get(id)
    if (timer !== undefined) window.clearTimeout(timer)
    idleTimers.current.delete(id)
    idleAttentionStates.current.delete(id)
    void window.hvir
      .invoke('terminal:forget', { root: workspaceRoot, id })
      .catch(() => undefined)
    setSessions((current) => {
      const index = current.findIndex((session) => session.id === id)
      const pane = current[index]?.pane ?? 'primary'
      const next = current.filter((session) => session.id !== id)
      const nextInPane =
        next.slice(index).find((session) => session.pane === pane) ??
        [...next].reverse().find((session) => session.pane === pane)
      if (activeByPaneRef.current[pane] === id) {
        activeByPaneRef.current[pane] = nextInPane?.id
      }
      if (activeIdRef.current === id) {
        const nextActive = nextInPane ?? next[Math.min(index, next.length - 1)]
        if (nextActive) {
          activePaneRef.current = nextActive.pane
          activeByPaneRef.current[nextActive.pane] = nextActive.id
        }
        setActiveId(nextActive?.id)
      }
      return next
    })
  }

  const raiseAttention = (id: string, attention: TerminalAttention): void => {
    const focused = focusedTerminalRef.current === id && appFocusedRef.current
    updateSession(id, (session) => {
      const nextAttention = nextTerminalAttention(session.attention, attention, focused)
      return nextAttention === session.attention
        ? session
        : { ...session, attention: nextAttention }
    })
  }

  const recordInput = (id: string, data: string): void => {
    const current = idleAttentionStates.current.get(id) ?? 'initial'
    idleAttentionStates.current.set(id, terminalIdleAttentionAfterInput(current, data))
  }

  const recordOutput = (id: string): void => {
    const focused = focusedTerminalRef.current === id && appFocusedRef.current
    const existing = idleTimers.current.get(id)
    if (existing !== undefined) window.clearTimeout(existing)
    idleTimers.current.delete(id)
    const decision = terminalOutputAttentionDecision(
      idleAttentionStates.current.get(id) ?? 'initial',
    )
    if (!decision.notify) return
    if (focused) {
      return
    }
    raiseAttention(id, 'output')
    if (!decision.scheduleIdle) return
    idleTimers.current.set(
      id,
      window.setTimeout(() => {
        idleTimers.current.delete(id)
        idleAttentionStates.current.set(id, 'settled')
        if (focusedTerminalRef.current !== id || !appFocusedRef.current) {
          raiseAttention(id, 'idle')
        }
      }, idleThresholdMs),
    )
  }

  const terminalSplit = sessions.some((session) => session.pane === 'secondary')
  const primaryActiveId =
    sessions.find(
      (session) =>
        session.pane === 'primary' && session.id === activeByPaneRef.current.primary,
    )?.id ?? sessions.find((session) => session.pane === 'primary')?.id
  const secondaryActiveId =
    sessions.find(
      (session) =>
        session.pane === 'secondary' && session.id === activeByPaneRef.current.secondary,
    )?.id ?? sessions.find((session) => session.pane === 'secondary')?.id
  activeByPaneRef.current.primary = primaryActiveId
  activeByPaneRef.current.secondary = secondaryActiveId

  const setTerminalPrimaryWidth = (width: number): void => {
    const deck = terminalDeckRef.current
    if (!deck) return
    const next = Math.min(Math.max(220, width), Math.max(220, deck.clientWidth - 225))
    deck.style.setProperty('--terminal-primary-track', `${next}px`)
    const layout = readTerminalSplitLayout(workspaceRoot)
    const updated = { ...layout, primaryWidth: next }
    restoredSplitLayout.current = updated
    writeTerminalSplitLayout(workspaceRoot, updated)
  }

  const initialDeckStyle = restoredSplitLayout.current.primaryWidth
    ? ({
        '--terminal-primary-track': `${restoredSplitLayout.current.primaryWidth}px`,
      } as CSSProperties)
    : undefined

  return (
    <>
      <div
        className={`terminal-deck${terminalSplit ? ' split' : ''}`}
        ref={terminalDeckRef}
        style={initialDeckStyle}
        aria-label={`${label} terminal workspace`}
        hidden={!visible}
      >
        {recoveryReady && sessions.length === 0 ? (
          <div className="terminal-empty">
            {available ? (
              <button type="button" onClick={() => addSession('plain-shell')}>
                New terminal
              </button>
            ) : (
              <span>No retained terminals</span>
            )}
          </div>
        ) : null}
        {sessions.map((session, position) => (
          <TerminalView
            key={session.id}
            sessionId={session.id}
            adapterId={session.adapterId}
            fallbackTitle={session.fallbackTitle}
            harnessSessionId={session.harnessSessionId}
            resumeOnStart={session.resumeOnStart}
            position={position}
            slot={session.pane}
            visible={
              visible &&
              session.id ===
                (session.pane === 'primary' ? primaryActiveId : secondaryActiveId)
            }
            active={visible && session.id === activeId}
            themeOverride={terminalTheme}
            cwd={workspaceRoot}
            connectionState={connectionState}
            onTitle={(title) =>
              updateSession(session.id, (current) => ({ ...current, title }))
            }
            onStatus={(status) =>
              updateSession(session.id, (current) => ({ ...current, status }))
            }
            onTelemetry={(telemetry) =>
              updateSession(session.id, (current) =>
                current.telemetry === telemetry ? current : { ...current, telemetry },
              )
            }
            onIdentity={(harnessSessionId, identityStatus) =>
              updateSession(session.id, (current) => ({
                ...current,
                harnessSessionId: harnessSessionId ?? current.harnessSessionId,
                identityStatus,
              }))
            }
            onStarted={() =>
              updateSession(session.id, (current) =>
                current.resumeOnStart ? { ...current, resumeOnStart: false } : current,
              )
            }
            onInput={(data) => recordInput(session.id, data)}
            onOutput={() => recordOutput(session.id)}
            onBell={() => raiseAttention(session.id, 'bell')}
            onFocus={() => focusSession(session.id)}
            onLink={(target) => {
              const resolved = resolveTerminalFileTarget(target, workspaceRoot)
              if (resolved) onOpenPath(resolved)
            }}
          />
        ))}
        {terminalSplit ? (
          <PaneResizer
            orientation="vertical"
            className="terminal-split-resizer"
            label="Resize split terminals"
            onDrag={(clientX) => {
              const left = terminalDeckRef.current?.getBoundingClientRect().left ?? 0
              setTerminalPrimaryWidth(clientX - left)
            }}
            onNudge={(delta) => {
              const primary = terminalDeckRef.current?.querySelector<HTMLElement>(
                '[data-terminal-slot="primary"].visible',
              )
              if (primary) {
                setTerminalPrimaryWidth(primary.getBoundingClientRect().width + delta)
              }
            }}
            onReset={() => {
              terminalDeckRef.current?.style.removeProperty('--terminal-primary-track')
              const layout = readTerminalSplitLayout(workspaceRoot)
              const updated = {
                ...layout,
                primaryWidth: undefined,
              }
              restoredSplitLayout.current = updated
              writeTerminalSplitLayout(workspaceRoot, updated)
            }}
          />
        ) : null}
      </div>
      <aside
        className="terminal-rail"
        aria-label={`Open terminals in ${label}`}
        data-terminal-theme={effectiveTerminalTheme}
        hidden={!visible}
      >
        <header className="terminal-rail-header">
          <span>Terminals</span>
          <div className="terminal-header-actions">
            <button
              type="button"
              className="terminal-icon-button terminal-split-button"
              aria-label="Split terminal"
              title="Open a shell in the other terminal split"
              disabled={!recoveryReady || !available}
              onClick={splitTerminal}
            >
              ◫
            </button>
            <button
              type="button"
              className="terminal-icon-button terminal-settings-button"
              aria-label="Open settings"
              title="Settings"
              onClick={onOpenSettings}
            >
              ⚙
            </button>
            <div className="terminal-new-control">
              <button
                type="button"
                className="terminal-icon-button"
                aria-label="New terminal"
                title="New terminal"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                disabled={!recoveryReady || !available}
                onClick={() => {
                  setMenuOpen((open) => !open)
                }}
              >
                +
              </button>
              {menuOpen ? (
                <div className="terminal-new-menu" role="menu">
                  {(Object.keys(adapterLabels) as TerminalAdapterId[]).map((id) => (
                    <button
                      key={id}
                      type="button"
                      role="menuitem"
                      onClick={() => addSession(id)}
                    >
                      {adapterLabels[id]}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </header>
        <div className="terminal-list" role="list">
          {sessions.map((session) => (
            <div
              key={session.id}
              className={`terminal-list-row${session.id === activeId ? ' active' : ''}`}
              role="listitem"
            >
              <button
                type="button"
                className="terminal-list-main"
                data-terminal-session={session.id}
                onClick={() => focusSession(session.id)}
              >
                <span className="terminal-list-copy">
                  <span className="terminal-list-title">{session.title}</span>
                  <span className="terminal-list-meta">
                    {adapterLabels[session.adapterId]} · {session.status}
                    {identityLabel(session.identityStatus)}
                  </span>
                  {session.adapterId !== 'plain-shell' ? (
                    <ContextMeter
                      telemetry={session.telemetry}
                      countOnly={session.adapterId === 'claude-code'}
                    />
                  ) : null}
                </span>
                {session.attention ? (
                  <span
                    className={`terminal-attention-badge ${session.attention}`}
                    aria-label={terminalAttentionLabel(session.attention)}
                    title={terminalAttentionLabel(session.attention)}
                  >
                    {session.attention === 'output'
                      ? 'new'
                      : session.attention === 'bell'
                        ? 'bell'
                        : 'ready'}
                  </span>
                ) : null}
              </button>
              {terminalSplit ? (
                <button
                  type="button"
                  className="terminal-move-button"
                  aria-label={`Move ${session.title} to ${session.pane === 'primary' ? 'right' : 'left'} split`}
                  title={`Move to ${session.pane === 'primary' ? 'right' : 'left'} split`}
                  onClick={() => moveSessionToOtherPane(session.id)}
                >
                  {session.pane === 'primary' ? '→' : '←'}
                </button>
              ) : null}
              <button
                type="button"
                className="terminal-close-button"
                aria-label={`Close ${session.title}`}
                title="Close terminal"
                onClick={() => closeSession(session.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </aside>
      {visible && recoveryCandidates.length > 0 ? (
        <TerminalRecoveryDialog
          sessions={recoveryCandidates}
          onCancel={() => {
            const session = createSession('plain-shell', workspaceRoot, 'primary')
            setSessions([session])
            setActiveId(session.id)
            setRecoveryCandidates([])
            setRecoveryReady(true)
          }}
          onResume={(ids) => {
            const selected = recoveryCandidates.filter((session) => ids.has(session.id))
            if (selected.length > 0) {
              restoreSessions(
                selected,
                restoredSplitLayout.current,
                setSessions,
                setActiveId,
              )
            } else {
              const session = createSession('plain-shell', workspaceRoot, 'primary')
              setSessions([session])
              setActiveId(session.id)
            }
            setRecoveryCandidates([])
            setRecoveryReady(true)
          }}
        />
      ) : null}
    </>
  )
}

function TerminalRecoveryDialog({
  sessions,
  onCancel,
  onResume,
}: {
  readonly sessions: readonly TerminalRecoverySession[]
  readonly onCancel: () => void
  readonly onResume: (ids: ReadonlySet<string>) => void
}): ReactElement {
  const dialogRef = useRef<HTMLElement>(null)
  const onCancelRef = useRef(onCancel)
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(sessions.map((session) => session.id)),
  )
  onCancelRef.current = onCancel

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => dialogRef.current?.focus())
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancelRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled)',
      )
      if (!focusable || focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === dialogRef.current)
      ) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    window.addEventListener('keydown', keydown)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', keydown)
    }
  }, [])

  return (
    <div className="modal-backdrop">
      <section
        className="project-dialog terminal-recovery-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="terminal-recovery-title"
        tabIndex={-1}
      >
        <h2 id="terminal-recovery-title">Restore terminals</h2>
        <div className="terminal-recovery-list">
          {sessions.map((session) => (
            <label key={session.id} className="terminal-recovery-option">
              <input
                type="checkbox"
                checked={selected.has(session.id)}
                onChange={(event) => {
                  const checked = event.currentTarget.checked
                  setSelected((current) => {
                    const next = new Set(current)
                    if (checked) next.add(session.id)
                    else next.delete(session.id)
                    return next
                  })
                }}
              />
              <span>
                <strong>{session.title}</strong>
                <small>
                  {adapterLabels[session.adapterId]} · {basenameHostPath(session.cwd)}
                  {' · '}
                  {restoreActionLabel(session)}
                </small>
              </span>
            </label>
          ))}
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            Not now
          </button>
          <button
            type="button"
            disabled={selected.size === 0}
            onClick={() => onResume(selected)}
          >
            Restore selected
          </button>
        </div>
      </section>
    </div>
  )
}

function ContextMeter({
  telemetry,
  countOnly = false,
}: {
  readonly telemetry?: HarnessTelemetry
  readonly countOnly?: boolean
}): ReactElement {
  const reportedPercent = countOnly ? undefined : telemetry?.contextUsedPercent
  const percent =
    typeof reportedPercent === 'number' && Number.isFinite(reportedPercent)
      ? Math.min(100, Math.max(0, reportedPercent))
      : undefined
  const displayPercent = percent === undefined ? undefined : Math.floor(percent)
  const hasCountOnly = telemetry !== undefined && displayPercent === undefined
  const pressure = hasCountOnly
    ? 'count-only'
    : displayPercent === undefined
      ? 'unknown'
      : displayPercent >= 70
        ? 'critical'
        : displayPercent >= 40
          ? 'warning'
          : 'normal'
  const label =
    telemetry && telemetry.contextWindowTokens !== undefined
      ? `${formatTokenCount(telemetry.contextUsedTokens)} / ${formatTokenCount(telemetry.contextWindowTokens)} context used`
      : telemetry
        ? `${formatTokenCount(telemetry.contextUsedTokens)} current context tokens; limit unavailable`
        : 'Context usage unavailable'

  return (
    <span
      className={`terminal-context ${pressure}${countOnly ? ' count-display' : ''}`}
      title={label}
    >
      {!countOnly ? (
        displayPercent === undefined ? (
          <span className="terminal-context-track" aria-hidden="true" />
        ) : (
          <span
            className="terminal-context-track"
            role="progressbar"
            aria-label="Context used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={displayPercent}
            aria-valuetext={label}
          >
            <span className="terminal-context-fill" style={{ width: `${percent}%` }} />
          </span>
        )
      ) : null}
      <span className="terminal-context-value">
        {hasCountOnly
          ? formatTokenCount(telemetry.contextUsedTokens)
          : displayPercent === undefined
            ? '--'
            : `${displayPercent}%`}
      </span>
    </span>
  )
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${trimFraction(value / 1_000_000)}m`
  if (value >= 1_000) return `${trimFraction(value / 1_000)}k`
  return String(Math.round(value))
}

function trimFraction(value: number): string {
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '')
}

function identityLabel(status: TerminalIdentityStatus | undefined): string {
  if (status === 'discovering') return ' · resume pending'
  if (status === 'ambiguous' || status === 'unavailable') {
    return ' · resume unavailable'
  }
  return ''
}

function restoreActionLabel(session: TerminalRecoverySession): string {
  if (session.adapterId === 'plain-shell') return 'New shell'
  return session.harnessSessionId ? 'Resume' : 'New session'
}

function createSession(
  adapterId: TerminalAdapterId,
  cwd: HostPath,
  pane: TerminalSplitPane,
): TerminalSession {
  const fallbackTitle = `${adapterLabels[adapterId]} · ${basenameHostPath(cwd)}`
  return {
    id: crypto.randomUUID(),
    adapterId,
    fallbackTitle,
    title: fallbackTitle,
    status: 'Starting…',
    resumeOnStart: false,
    pane,
  }
}

function restoreSessions(
  records: readonly TerminalRecoverySession[],
  splitLayout: StoredTerminalSplitLayout,
  setSessions: (sessions: readonly TerminalSession[]) => void,
  setActiveId: (id: string | undefined) => void,
): void {
  const ordered = [...records].sort(
    (left, right) => left.position - right.position || left.updatedAt - right.updatedAt,
  )
  const sessions = ordered.map<TerminalSession>((record) => {
    const resumable =
      record.adapterId !== 'plain-shell' && Boolean(record.harnessSessionId)
    return {
      id: record.id,
      adapterId: record.adapterId,
      fallbackTitle: record.title,
      title: record.title,
      status:
        record.adapterId === 'plain-shell'
          ? 'Ready to restore'
          : resumable
            ? 'Ready to resume'
            : 'Ready to restart',
      harnessSessionId: record.harnessSessionId,
      identityStatus:
        record.adapterId === 'plain-shell'
          ? 'none'
          : resumable
            ? 'identified'
            : 'unavailable',
      resumeOnStart: resumable,
      pane: splitLayout.secondaryIds.includes(record.id) ? 'secondary' : 'primary',
    }
  })
  setSessions(sessions)
  setActiveId(
    ordered.find((record) => record.active && sessions.some(({ id }) => id === record.id))
      ?.id ?? sessions[0]?.id,
  )
}

interface StoredTerminalSplitLayout {
  readonly secondaryIds: readonly string[]
  readonly primaryWidth?: number
}

function readTerminalSplitLayout(root: HostPath): StoredTerminalSplitLayout {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(terminalSplitStorageKey(root)) ?? 'null',
    )
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { secondaryIds: [] }
    }
    const record = value as Record<string, unknown>
    const ids = record['secondaryIds']
    const primaryWidth = record['primaryWidth']
    return {
      secondaryIds: Array.isArray(ids)
        ? ids
            .filter((id): id is string => typeof id === 'string' && id.length <= 80)
            .slice(0, 500)
        : [],
      primaryWidth:
        typeof primaryWidth === 'number' && Number.isFinite(primaryWidth)
          ? primaryWidth
          : undefined,
    }
  } catch {
    return { secondaryIds: [] }
  }
}

function writeTerminalSplitLayout(
  root: HostPath,
  layout: StoredTerminalSplitLayout,
): void {
  try {
    localStorage.setItem(terminalSplitStorageKey(root), JSON.stringify(layout))
  } catch {
    // Split recovery is best effort and never changes the live PTY layout.
  }
}

function terminalSplitStorageKey(root: HostPath): string {
  return `hvir:terminal-split:${root.hostId}:${root.path}`
}
