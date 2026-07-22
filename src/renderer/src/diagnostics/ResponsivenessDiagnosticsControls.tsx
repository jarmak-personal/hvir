import type { ReactElement } from 'react'

import type { ResponsivenessDiagnosticsController } from './use-responsiveness-diagnostics'

export function ResponsivenessDiagnosticsIndicator({
  diagnostics,
  onOpen,
}: {
  readonly diagnostics: ResponsivenessDiagnosticsController
  readonly onOpen: () => void
}): ReactElement | null {
  if (diagnostics.state?.status !== 'active') return null
  return (
    <button
      type="button"
      className="responsiveness-diagnostics-indicator"
      aria-label={`Renderer diagnostic mode active, ${formatRemaining(diagnostics.remainingMs)} remaining`}
      title="Renderer diagnostic mode is active"
      onClick={onOpen}
    >
      DIAG {formatRemaining(diagnostics.remainingMs)}
    </button>
  )
}

export function ResponsivenessDiagnosticsPanel({
  diagnostics,
}: {
  readonly diagnostics: ResponsivenessDiagnosticsController
}): ReactElement | null {
  const state = diagnostics.state
  if (!state?.available) return null
  return (
    <section
      className="responsiveness-diagnostics-panel"
      aria-labelledby="responsiveness-diagnostics-title"
    >
      <h3 id="responsiveness-diagnostics-title">Renderer responsiveness experiment</h3>
      <p>
        Opt-in, content-free Long Tasks evidence for a reviewed report. It never changes
        workbench health or attention and stops after 15 minutes.
      </p>
      {!diagnostics.supported ? (
        <p role="status">Unavailable: this Chromium build does not expose Long Tasks.</p>
      ) : null}
      {state.status === 'active' ? (
        <>
          <p role="status">
            Diagnostic mode active · {formatRemaining(diagnostics.remainingMs)} remaining
            · {state.observationCount} observation
            {state.observationCount === 1 ? '' : 's'}
          </p>
          <div className="responsiveness-diagnostics-actions">
            <button type="button" onClick={diagnostics.stop}>
              Stop and retain evidence
            </button>
            <button type="button" onClick={diagnostics.deleteEvidence}>
              Stop and delete evidence
            </button>
          </div>
        </>
      ) : null}
      {state.status === 'complete' ? (
        <>
          <p role="status">
            Run stopped ({state.stopReason.replaceAll('-', ' ')}) · {state.aggregateCount}{' '}
            bounded aggregate{state.aggregateCount === 1 ? '' : 's'} retained for Preview.
          </p>
          <div className="responsiveness-diagnostics-actions">
            {diagnostics.supported ? (
              <button type="button" onClick={diagnostics.start}>
                Start new run
              </button>
            ) : null}
            <button type="button" onClick={diagnostics.deleteEvidence}>
              Delete evidence
            </button>
          </div>
        </>
      ) : null}
      {state.status === 'idle' && diagnostics.supported ? (
        <button type="button" onClick={diagnostics.start}>
          Start responsiveness diagnostics
        </button>
      ) : null}
    </section>
  )
}

function formatRemaining(remainingMs: number): string {
  const seconds = Math.ceil(remainingMs / 1_000)
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}
