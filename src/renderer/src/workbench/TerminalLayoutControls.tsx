import type { ReactElement } from 'react'

import { focusActiveTerminalAfterLayout } from './active-terminal-focus'
import type { TerminalLayoutMode } from './workspace-pane-state'

interface TerminalLayoutControlsProps {
  readonly mode: TerminalLayoutMode
  readonly onMode: (mode: TerminalLayoutMode) => void
}

export function TerminalLayoutControls({
  mode,
  onMode,
}: TerminalLayoutControlsProps): ReactElement {
  const terminalLabel = mode === 'maximized' ? 'Restore split view' : 'Maximize terminal'
  const viewerLabel =
    mode === 'collapsed' ? 'Restore split view' : 'Maximize viewer and minimize terminal'
  const applyMode = (next: TerminalLayoutMode): void => {
    onMode(next)
    focusActiveTerminalAfterLayout()
  }

  return (
    <div className="terminal-mode-controls" role="group" aria-label="Terminal layout">
      <button
        type="button"
        className="terminal-focus-toggle"
        data-resizer-action
        aria-label={terminalLabel}
        aria-pressed={mode === 'maximized'}
        title={terminalLabel}
        onDoubleClick={(event) => event.stopPropagation()}
        onClick={() => applyMode(mode === 'maximized' ? 'restored' : 'maximized')}
      >
        <svg aria-hidden="true" viewBox="0 0 16 16">
          <path
            d={
              mode === 'maximized'
                ? 'M3 5.5 8 10l5-4.5'
                : 'M3 11.5 8 7l5 4.5M3 7.5 8 3l5 4.5'
            }
          />
        </svg>
      </button>
      <button
        type="button"
        className="terminal-collapse-toggle"
        data-resizer-action
        aria-label={viewerLabel}
        aria-pressed={mode === 'collapsed'}
        title={viewerLabel}
        onDoubleClick={(event) => event.stopPropagation()}
        onClick={() => applyMode(mode === 'collapsed' ? 'restored' : 'collapsed')}
      >
        <svg aria-hidden="true" viewBox="0 0 16 16">
          <path
            d={
              mode === 'collapsed'
                ? 'M3 10.5 8 6l5 4.5'
                : 'M3 4.5 8 9l5-4.5M3 8.5 8 13l5-4.5'
            }
          />
        </svg>
      </button>
    </div>
  )
}
