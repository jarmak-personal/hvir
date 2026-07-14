import { useEffect, useRef, useState, type ReactElement } from 'react'

import {
  basenameHostPath,
  type HarnessTelemetry,
  type HostConnectionState,
  type HostPath,
  type TerminalAdapterId,
  type TerminalIdentityStatus,
  type TerminalRecoverySession,
} from '../../../shared'
import { nextTerminalAttention, type TerminalAttention } from './terminal-attention'
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
}

interface TerminalWorkspaceProps {
  readonly cwd: HostPath
  readonly connectionState: HostConnectionState
}

const IDLE_AFTER_BURST_MS = 4_000
const RECOVERY_MODE_KEY = 'hvir:terminal-recovery-mode'
type RecoveryMode = 'prompt' | 'auto'

const adapterLabels: Record<TerminalAdapterId, string> = {
  'plain-shell': 'Shell',
  'claude-code': 'Claude Code',
  codex: 'Codex',
}

export function TerminalWorkspace({
  cwd,
  connectionState,
}: TerminalWorkspaceProps): ReactElement {
  const [sessions, setSessions] = useState<readonly TerminalSession[]>([])
  const [activeId, setActiveId] = useState<string>()
  const [menuOpen, setMenuOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [recoveryReady, setRecoveryReady] = useState(false)
  const [recoveryCandidates, setRecoveryCandidates] = useState<
    readonly TerminalRecoverySession[]
  >([])
  const [recoveryMode, setRecoveryMode] = useState<RecoveryMode>(readRecoveryMode)
  const activeIdRef = useRef(activeId)
  const sessionsRef = useRef(sessions)
  const appFocusedRef = useRef(document.hasFocus())
  const focusedTerminalRef = useRef<string | undefined>(undefined)
  const idleTimers = useRef(new Map<string, number>())
  activeIdRef.current = activeId
  sessionsRef.current = sessions

  useEffect(() => {
    const timers = idleTimers.current
    const focused = (): void => {
      appFocusedRef.current = true
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
    if (!menuOpen && !settingsOpen) return
    const close = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setMenuOpen(false)
      setSettingsOpen(false)
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [menuOpen, settingsOpen])

  useEffect(() => {
    let cancelled = false
    setRecoveryReady(false)
    setRecoveryCandidates([])
    setSessions([])
    setActiveId(undefined)
    void window.hvir.invoke('terminal:recovery', { root: cwd }).then(
      (candidates) => {
        if (cancelled) return
        if (candidates.length === 0) {
          const session = createSession('plain-shell', cwd)
          setSessions([session])
          setActiveId(session.id)
          setRecoveryReady(true)
          return
        }
        if (readRecoveryMode() === 'auto') {
          restoreSessions(candidates, setSessions, setActiveId)
          setRecoveryReady(true)
          return
        }
        setRecoveryCandidates(candidates)
      },
      () => {
        if (cancelled) return
        const session = createSession('plain-shell', cwd)
        setSessions([session])
        setActiveId(session.id)
        setRecoveryReady(true)
      },
    )
    return () => {
      cancelled = true
    }
  }, [cwd])

  const layoutKey = JSON.stringify(
    sessions.map((session, position) => ({
      id: session.id,
      title: session.title,
      position,
      active: session.id === activeId,
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
      .invoke('terminal:update-layout', { root: cwd, sessions: layout })
      .catch(() => undefined)
  }, [cwd, layoutKey, recoveryReady])

  const actionableAttention = sessions.filter(
    (session) => session.attention === 'idle' || session.attention === 'bell',
  ).length
  useEffect(() => {
    window.hvir.send('app:attention', { count: actionableAttention })
  }, [actionableAttention])
  useEffect(() => () => window.hvir.send('app:attention', { count: 0 }), [])

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
    setActiveId(id)
    updateSession(id, (session) =>
      session.attention ? { ...session, attention: undefined } : session,
    )
  }

  const addSession = (adapterId: TerminalAdapterId): void => {
    const session = createSession(adapterId, cwd)
    setSessions((current) => [...current, session])
    setActiveId(session.id)
    setMenuOpen(false)
    setSettingsOpen(false)
  }

  const closeSession = (id: string): void => {
    const timer = idleTimers.current.get(id)
    if (timer !== undefined) window.clearTimeout(timer)
    idleTimers.current.delete(id)
    void window.hvir.invoke('terminal:forget', { root: cwd, id }).catch(() => undefined)
    setSessions((current) => {
      const index = current.findIndex((session) => session.id === id)
      const next = current.filter((session) => session.id !== id)
      if (activeIdRef.current === id) {
        setActiveId(next[Math.min(index, next.length - 1)]?.id)
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

  const recordOutput = (id: string): void => {
    const focused = focusedTerminalRef.current === id && appFocusedRef.current
    const existing = idleTimers.current.get(id)
    if (existing !== undefined) window.clearTimeout(existing)
    if (focused) {
      idleTimers.current.delete(id)
      return
    }
    raiseAttention(id, 'output')
    idleTimers.current.set(
      id,
      window.setTimeout(() => {
        idleTimers.current.delete(id)
        if (focusedTerminalRef.current !== id || !appFocusedRef.current) {
          raiseAttention(id, 'idle')
        }
      }, IDLE_AFTER_BURST_MS),
    )
  }

  return (
    <>
      <div className="terminal-deck" aria-label="Terminal workspace">
        {recoveryReady && sessions.length === 0 ? (
          <div className="terminal-empty">
            <button type="button" onClick={() => addSession('plain-shell')}>
              New terminal
            </button>
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
            active={session.id === activeId}
            cwd={cwd}
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
            onOutput={() => recordOutput(session.id)}
            onBell={() => raiseAttention(session.id, 'bell')}
            onFocus={() => focusSession(session.id)}
          />
        ))}
      </div>
      <aside className="terminal-rail" aria-label="Open terminals">
        <header className="terminal-rail-header">
          <span>Terminals</span>
          <div className="terminal-header-actions">
            <div className="terminal-new-control">
              <button
                type="button"
                className="terminal-icon-button terminal-settings-button"
                aria-label="Terminal recovery settings"
                title="Terminal recovery settings"
                aria-haspopup="menu"
                aria-expanded={settingsOpen}
                disabled={!recoveryReady}
                onClick={() => {
                  setSettingsOpen((open) => !open)
                  setMenuOpen(false)
                }}
              >
                ⚙
              </button>
              {settingsOpen ? (
                <div
                  className="terminal-new-menu terminal-settings-menu"
                  role="group"
                  aria-label="Terminal recovery settings"
                >
                  <label>
                    <input
                      type="checkbox"
                      checked={recoveryMode === 'auto'}
                      onChange={(event) => {
                        const mode: RecoveryMode = event.currentTarget.checked
                          ? 'auto'
                          : 'prompt'
                        setRecoveryMode(mode)
                        writeRecoveryMode(mode)
                      }}
                    />
                    <span>Restore automatically</span>
                  </label>
                </div>
              ) : null}
            </div>
            <div className="terminal-new-control">
              <button
                type="button"
                className="terminal-icon-button"
                aria-label="New terminal"
                title="New terminal"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                disabled={!recoveryReady}
                onClick={() => {
                  setMenuOpen((open) => !open)
                  setSettingsOpen(false)
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
                onClick={() => focusSession(session.id)}
              >
                <span
                  className={`terminal-attention${session.attention ? ` ${session.attention}` : ''}`}
                  aria-label={
                    session.attention ? `${session.attention} attention` : undefined
                  }
                />
                <span className="terminal-list-copy">
                  <span className="terminal-list-title">{session.title}</span>
                  <span className="terminal-list-meta">
                    {adapterLabels[session.adapterId]} · {session.status}
                    {identityLabel(session.identityStatus)}
                  </span>
                  {session.adapterId !== 'plain-shell' ? (
                    <ContextMeter telemetry={session.telemetry} />
                  ) : null}
                </span>
              </button>
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
      {recoveryCandidates.length > 0 ? (
        <TerminalRecoveryDialog
          sessions={recoveryCandidates}
          onCancel={() => {
            const session = createSession('plain-shell', cwd)
            setSessions([session])
            setActiveId(session.id)
            setRecoveryCandidates([])
            setRecoveryReady(true)
          }}
          onResume={(ids) => {
            const selected = recoveryCandidates.filter((session) => ids.has(session.id))
            if (selected.length > 0) {
              restoreSessions(selected, setSessions, setActiveId)
            } else {
              const session = createSession('plain-shell', cwd)
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
}: {
  readonly telemetry?: HarnessTelemetry
}): ReactElement {
  const reportedPercent = telemetry?.contextUsedPercent
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
    <span className={`terminal-context ${pressure}`} title={label}>
      {displayPercent === undefined ? (
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
      )}
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

function createSession(adapterId: TerminalAdapterId, cwd: HostPath): TerminalSession {
  const fallbackTitle = `${adapterLabels[adapterId]} · ${basenameHostPath(cwd)}`
  return {
    id: crypto.randomUUID(),
    adapterId,
    fallbackTitle,
    title: fallbackTitle,
    status: 'Starting…',
    resumeOnStart: false,
  }
}

function restoreSessions(
  records: readonly TerminalRecoverySession[],
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
    }
  })
  setSessions(sessions)
  setActiveId(
    ordered.find((record) => record.active && sessions.some(({ id }) => id === record.id))
      ?.id ?? sessions[0]?.id,
  )
}

function readRecoveryMode(): RecoveryMode {
  try {
    return localStorage.getItem(RECOVERY_MODE_KEY) === 'auto' ? 'auto' : 'prompt'
  } catch {
    return 'prompt'
  }
}

function writeRecoveryMode(mode: RecoveryMode): void {
  try {
    localStorage.setItem(RECOVERY_MODE_KEY, mode)
  } catch {
    // Storage denial leaves the documented prompt default in place.
  }
}
