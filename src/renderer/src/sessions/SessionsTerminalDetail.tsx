import { useCallback, type ReactElement } from 'react'

import type {
  SessionsTerminalDetailController,
  SessionsTerminalDetailState,
} from './sessions-terminal-detail-controller'

export function SessionsTerminalDetail({
  controller,
  state,
  onBack,
  onReturn,
}: {
  readonly controller: SessionsTerminalDetailController
  readonly state: Exclude<SessionsTerminalDetailState, { readonly status: 'inactive' }>
  readonly onBack: () => void
  readonly onReturn: () => void
}): ReactElement {
  const setContainer = useCallback(
    (container: HTMLDivElement | null) => controller.setContainer(container ?? undefined),
    [controller],
  )
  const ready = state.status === 'ready'
  return (
    <main className="sessions-terminal-detail" aria-labelledby="sessions-detail-title">
      <header className="sessions-detail-header">
        <div>
          <p className="sessions-eyebrow">Live terminal</p>
          <h1 id="sessions-detail-title">{state.context.title}</h1>
          <p>
            {state.context.projectName} <span aria-hidden="true">/</span>{' '}
            {state.context.workspaceName} · {state.context.hostLabel} ·{' '}
            {state.context.providerName}
          </p>
        </div>
        <div className="sessions-detail-actions">
          <button type="button" onClick={onBack}>
            Back to Sessions
          </button>
          <button type="button" onClick={onReturn}>
            Return to current workspace
          </button>
        </div>
      </header>
      {state.message ? (
        <p className="sessions-detail-status" role="status">
          {state.message}
        </p>
      ) : state.status === 'resolving' ? (
        <p className="sessions-detail-status" role="status">
          Attaching the exact live terminal…
        </p>
      ) : null}
      <section
        className={`sessions-detail-terminal${ready ? ' ready' : ''}`}
        aria-label={`${state.context.title} terminal`}
      >
        <div
          className="terminal-container sessions-detail-terminal-container"
          aria-hidden={!ready}
          ref={setContainer}
          tabIndex={-1}
        />
        {!ready ? (
          <div className="sessions-detail-terminal-placeholder" aria-hidden="true" />
        ) : null}
      </section>
    </main>
  )
}
