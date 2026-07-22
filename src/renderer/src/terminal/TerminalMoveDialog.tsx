import { useEffect, useRef, useState, type ReactElement } from 'react'

import type { TerminalMovePlan } from '../../../shared'
import { ConfirmationDialog } from '../workbench/ConfirmationDialog'

export function TerminalMoveDialog({
  plan,
  onCancel,
  onMove,
}: {
  readonly plan: TerminalMovePlan
  readonly onCancel: () => void
  readonly onMove: () => Promise<void>
}): ReactElement {
  const busyRef = useRef(false)
  const mountedRef = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const move = (): void => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(undefined)
    void onMove()
      .catch((reason: unknown) => {
        if (mountedRef.current) setError(errorMessage(reason))
      })
      .finally(() => {
        busyRef.current = false
        if (mountedRef.current) setBusy(false)
      })
  }

  return (
    <ConfirmationDialog
      labelledBy="terminal-move-title"
      actions={[
        { label: 'Cancel', kind: 'cancel', onSelect: onCancel },
        {
          label: 'Move terminal here and open',
          kind: 'primary',
          onSelect: move,
        },
      ]}
      busy={busy}
      className="terminal-move-dialog"
    >
      <header className="terminal-move-header">
        <span className="terminal-move-kicker">
          <span className="terminal-move-live-dot" aria-hidden="true" />
          Live terminal transfer
        </span>
        <h2 id="terminal-move-title">Move this live terminal?</h2>
        <p>Rehome the terminal in another worktree without restarting its process.</p>
      </header>
      <div className="terminal-move-body">
        <div className="terminal-move-session">
          <strong>{plan.terminalTitle}</strong>
          <span>running</span>
        </div>
        <dl className="terminal-move-details" aria-label="Terminal workspace move">
          <div className="terminal-move-location terminal-move-location-source">
            <dt>From</dt>
            <dd>
              <strong>{plan.sourceWorkspaceName}</strong>
              <code title={plan.sourceRoot.path}>{plan.sourceRoot.path}</code>
            </dd>
          </div>
          <div className="terminal-move-location terminal-move-location-target">
            <dt>To</dt>
            <dd>
              <strong>{plan.targetWorkspaceName}</strong>
              <code title={plan.targetRoot.path}>{plan.targetRoot.path}</code>
            </dd>
          </div>
        </dl>
        <div className="terminal-move-continuity">
          <span className="terminal-move-continuity-mark" aria-hidden="true">
            ✓
          </span>
          <p>
            <strong>Process and conversation stay live</strong>
            <span>
              The supervised process is not restarted. Its original launch directory does
              not change.
            </span>
          </p>
        </div>
        {plan.webPaneIds.length > 0 ? (
          <div className="terminal-move-warning" role="status">
            <span className="terminal-move-warning-mark" aria-hidden="true">
              !
            </span>
            <p>
              <strong>
                {plan.webPaneIds.length} workspace-authorized web pane
                {plan.webPaneIds.length === 1 ? '' : 's'} will close.
              </strong>
              <span>Browser state is not migrated.</span>
            </p>
          </div>
        ) : null}
        {error ? <p className="dialog-error">{error}</p> : null}
      </div>
    </ConfirmationDialog>
  )
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
