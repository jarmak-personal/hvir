import {
  useCallback,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type ReactElement,
} from 'react'

import type {
  SessionsTerminalDetailController,
  SessionsTerminalDetailState,
} from './sessions-terminal-detail-controller'

export function SessionsTerminalDetail({
  controller,
  state,
  origin,
  onBack,
  onReturn,
}: {
  readonly controller: SessionsTerminalDetailController
  readonly state: Exclude<SessionsTerminalDetailState, { readonly status: 'inactive' }>
  readonly origin?: { readonly x: number; readonly y: number }
  readonly onBack: () => void
  readonly onReturn: () => void
}): ReactElement {
  const closeButton = useRef<HTMLButtonElement>(null)
  const setContainer = useCallback(
    (container: HTMLDivElement | null) => controller.setContainer(container ?? undefined),
    [controller],
  )
  useLayoutEffect(() => {
    closeButton.current?.focus()
  }, [])
  const ready = state.status === 'ready'
  const originStyle = origin
    ? ({
        '--sessions-detail-origin-x': `${origin.x}px`,
        '--sessions-detail-origin-y': `${origin.y}px`,
      } as CSSProperties)
    : undefined
  return (
    <div className="sessions-detail-backdrop">
      <section
        className="sessions-terminal-detail"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sessions-detail-title"
        style={originStyle}
      >
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
            <button type="button" ref={closeButton} onClick={onBack}>
              Close
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
      </section>
    </div>
  )
}
