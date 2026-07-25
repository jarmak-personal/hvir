import type { ReactElement } from 'react'

import { terminalAttentionLabel, type TerminalAttention } from './terminal-attention'
import type { TerminalSession } from './terminal-workspace-model'

export function TerminalRailCompact({
  hidden,
  sessions,
  activeId,
  onFocusSession,
  onRestore,
}: {
  readonly hidden: boolean
  readonly sessions: readonly TerminalSession[]
  readonly activeId?: string
  readonly onFocusSession: (id: string) => void
  readonly onRestore: () => void
}): ReactElement {
  const ready = sessions.filter((session) => session.attention === 'idle').length
  const bell = sessions.filter((session) => session.attention === 'bell').length

  return (
    <div className="terminal-rail-compact-strip" hidden={hidden}>
      <div
        className="terminal-rail-compact-rollups"
        role="status"
        aria-label={attentionSummary(ready, bell)}
      >
        {ready > 0 ? (
          <span
            className="terminal-rail-compact-rollup idle"
            aria-label={`${ready} ${ready === 1 ? 'terminal' : 'terminals'} ready`}
            title={`${ready} ${ready === 1 ? 'terminal' : 'terminals'} ready`}
          >
            <span aria-hidden="true">R</span>
            {ready}
          </span>
        ) : null}
        {bell > 0 ? (
          <span
            className="terminal-rail-compact-rollup bell"
            aria-label={`${bell} terminal ${bell === 1 ? 'bell' : 'bells'}`}
            title={`${bell} terminal ${bell === 1 ? 'bell' : 'bells'}`}
          >
            <span aria-hidden="true">B</span>
            {bell}
          </span>
        ) : null}
      </div>
      <div
        className="terminal-rail-compact-markers"
        role="list"
        aria-label="Open terminals"
      >
        {sessions.map((session) => {
          const state = session.attention ?? 'neutral'
          const active = session.id === activeId
          const label = markerLabel(session.title, state, active)
          return (
            <div
              key={session.id}
              className="terminal-rail-compact-marker-item"
              role="listitem"
            >
              <button
                type="button"
                className={`terminal-rail-compact-marker ${state}${active ? ' active' : ''}`}
                data-terminal-session={session.id}
                data-terminal-state={state}
                aria-current={active ? 'true' : undefined}
                aria-label={label}
                title={label}
                onClick={() => onFocusSession(session.id)}
              >
                <span aria-hidden="true">{markerText(state)}</span>
              </button>
            </div>
          )
        })}
      </div>
      <button
        type="button"
        className="terminal-rail-restore"
        aria-label="Restore terminal rail"
        title="Restore terminal rail"
        onClick={onRestore}
      >
        <svg aria-hidden="true" viewBox="0 0 16 16">
          <path d="M11.5 3 7 8l4.5 5M7.5 3 3 8l4.5 5" />
        </svg>
      </button>
    </div>
  )
}

function attentionSummary(ready: number, bell: number): string {
  if (ready === 0 && bell === 0) return 'No terminals need attention'
  return [
    ready > 0 ? `${ready} ready` : undefined,
    bell > 0 ? `${bell} ${bell === 1 ? 'bell' : 'bells'}` : undefined,
  ]
    .filter((label): label is string => Boolean(label))
    .join(', ')
}

type CompactTerminalState = TerminalAttention | 'neutral'

function markerLabel(
  title: string,
  state: CompactTerminalState,
  active: boolean,
): string {
  const stateLabel = state === 'neutral' ? 'Neutral' : terminalAttentionLabel(state)
  return `${title}, ${stateLabel}${active ? ', active terminal' : ''}`
}

function markerText(state: CompactTerminalState): string {
  if (state === 'working') return '…'
  if (state === 'idle') return 'R'
  if (state === 'bell') return 'B'
  return '–'
}
