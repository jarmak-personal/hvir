import { useEffect, useRef, useState, type ReactElement } from 'react'

import type { TerminalMovePlan } from '../../../shared'

export function TerminalMoveDialog({
  plan,
  onCancel,
  onMove,
}: {
  readonly plan: TerminalMovePlan
  readonly onCancel: () => void
  readonly onMove: () => Promise<void>
}): ReactElement {
  const dialogRef = useRef<HTMLElement>(null)
  const cancelRef = useRef(onCancel)
  const busyRef = useRef(false)
  const mountedRef = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  cancelRef.current = onCancel

  useEffect(() => {
    mountedRef.current = true
    const frame = window.requestAnimationFrame(() => dialogRef.current?.focus())
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (!busyRef.current) cancelRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled)',
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
      mountedRef.current = false
      window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', keydown)
    }
  }, [])

  return (
    <div className="modal-backdrop">
      <section
        className="project-dialog terminal-move-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="terminal-move-title"
        tabIndex={-1}
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
                The supervised process is not restarted. Its original launch directory
                does not change.
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
        <div className="dialog-actions terminal-move-actions">
          <button type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button
            className="terminal-move-submit"
            type="button"
            disabled={busy}
            onClick={() => {
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
            }}
          >
            Move terminal here and open
          </button>
        </div>
      </section>
    </div>
  )
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
