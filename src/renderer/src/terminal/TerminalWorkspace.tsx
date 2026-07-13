import { useEffect, useRef, useState, type ReactElement } from 'react'

import {
  basenameHostPath,
  type HostConnectionState,
  type HostPath,
  type TerminalAdapterId,
} from '../../../shared'
import { TerminalView } from './TerminalView'

type Attention = 'output' | 'bell' | 'idle'

interface TerminalSession {
  readonly id: string
  readonly adapterId: TerminalAdapterId
  readonly fallbackTitle: string
  readonly title: string
  readonly status: string
  readonly attention?: Attention
}

interface TerminalWorkspaceProps {
  readonly cwd: HostPath
  readonly connectionState: HostConnectionState
}

const IDLE_AFTER_BURST_MS = 4_000

const adapterLabels: Record<TerminalAdapterId, string> = {
  'plain-shell': 'Shell',
  'claude-code': 'Claude Code',
  codex: 'Codex',
}

const attentionPriority: Record<Attention, number> = {
  output: 1,
  bell: 2,
  idle: 3,
}

export function TerminalWorkspace({
  cwd,
  connectionState,
}: TerminalWorkspaceProps): ReactElement {
  const [sessions, setSessions] = useState<readonly TerminalSession[]>(() => [
    createSession('plain-shell', cwd),
  ])
  const [activeId, setActiveId] = useState(() => sessions[0]?.id)
  const [menuOpen, setMenuOpen] = useState(false)
  const activeIdRef = useRef(activeId)
  const appFocusedRef = useRef(document.hasFocus())
  const idleTimers = useRef(new Map<string, number>())
  activeIdRef.current = activeId

  useEffect(() => {
    const timers = idleTimers.current
    const focused = (): void => {
      appFocusedRef.current = true
    }
    const blurred = (): void => {
      appFocusedRef.current = false
    }
    window.addEventListener('focus', focused)
    window.addEventListener('blur', blurred)
    return () => {
      window.removeEventListener('focus', focused)
      window.removeEventListener('blur', blurred)
      for (const timer of timers.values()) window.clearTimeout(timer)
      timers.clear()
    }
  }, [])

  useEffect(() => {
    if (!menuOpen) return
    const close = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [menuOpen])

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
  }

  const closeSession = (id: string): void => {
    const timer = idleTimers.current.get(id)
    if (timer !== undefined) window.clearTimeout(timer)
    idleTimers.current.delete(id)
    setSessions((current) => {
      const index = current.findIndex((session) => session.id === id)
      const next = current.filter((session) => session.id !== id)
      if (activeIdRef.current === id) {
        setActiveId(next[Math.min(index, next.length - 1)]?.id)
      }
      return next
    })
  }

  const raiseAttention = (id: string, attention: Attention): void => {
    updateSession(id, (session) =>
      session.attention &&
      attentionPriority[session.attention] >= attentionPriority[attention]
        ? session
        : { ...session, attention },
    )
  }

  const recordOutput = (id: string): void => {
    const focused = activeIdRef.current === id && appFocusedRef.current
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
        if (activeIdRef.current !== id || !appFocusedRef.current) {
          raiseAttention(id, 'idle')
        }
      }, IDLE_AFTER_BURST_MS),
    )
  }

  return (
    <>
      <div className="terminal-deck" aria-label="Terminal workspace">
        {sessions.length === 0 ? (
          <div className="terminal-empty">
            <button type="button" onClick={() => addSession('plain-shell')}>
              New terminal
            </button>
          </div>
        ) : null}
        {sessions.map((session) => (
          <TerminalView
            key={session.id}
            sessionId={session.id}
            adapterId={session.adapterId}
            fallbackTitle={session.fallbackTitle}
            active={session.id === activeId}
            cwd={cwd}
            connectionState={connectionState}
            onTitle={(title) =>
              updateSession(session.id, (current) => ({ ...current, title }))
            }
            onStatus={(status) =>
              updateSession(session.id, (current) => ({ ...current, status }))
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
          <div className="terminal-new-control">
            <button
              type="button"
              className="terminal-icon-button"
              aria-label="New terminal"
              title="New terminal"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
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
                  </span>
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
    </>
  )
}

function createSession(adapterId: TerminalAdapterId, cwd: HostPath): TerminalSession {
  const fallbackTitle = `${adapterLabels[adapterId]} · ${basenameHostPath(cwd)}`
  return {
    id: crypto.randomUUID(),
    adapterId,
    fallbackTitle,
    title: fallbackTitle,
    status: 'Starting…',
  }
}
