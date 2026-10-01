import { useCallback, useRef, type CSSProperties, type ReactElement } from 'react'

import type { SessionsProjectionRow, SessionsProjectionSnapshot } from '../../../shared'
import type { SessionsCommandPort } from './sessions-command-port'
import { useSessionsMove } from './use-sessions-move'
import { TerminalMoveDialog } from '../terminal/TerminalMoveDialog'
import { useModalKeyboard } from '../workbench/use-modal-keyboard'
import type {
  SessionsTerminalDetailController,
  SessionsTerminalDetailState,
} from './sessions-terminal-detail-controller'

export function SessionsTerminalDetail({
  controller,
  commands,
  row,
  snapshot,
  foreground,
  state,
  origin,
  onBack,
  onOpenWorkspace,
}: {
  readonly commands?: SessionsCommandPort
  readonly row?: SessionsProjectionRow
  readonly snapshot: SessionsProjectionSnapshot
  readonly foreground: boolean
  readonly controller: SessionsTerminalDetailController
  readonly state: Exclude<SessionsTerminalDetailState, { readonly status: 'inactive' }>
  readonly origin?: {
    readonly top: number
    readonly right: number
    readonly bottom: number
    readonly left: number
  }
  readonly onBack: () => void
  readonly onOpenWorkspace: () => void
}): ReactElement {
  const dialog = useRef<HTMLElement>(null)
  const moving = useSessionsMove(commands, row, snapshot, foreground)
  useModalKeyboard(dialog, onBack, true, !moving.pending && !moving.targets)
  const setContainer = useCallback(
    (container: HTMLDivElement | null) => controller.setContainer(container ?? undefined),
    [controller],
  )
  const ready = state.status === 'ready'
  const originStyle = origin
    ? ({
        '--sessions-detail-origin-top': `${origin.top}px`,
        '--sessions-detail-origin-right': `calc(100vw - ${origin.right}px)`,
        '--sessions-detail-origin-bottom': `calc(100vh - ${origin.bottom}px)`,
        '--sessions-detail-origin-left': `${origin.left}px`,
      } as CSSProperties)
    : undefined
  return (
    <div className="sessions-detail-backdrop" style={originStyle}>
      <section
        ref={dialog}
        className="sessions-terminal-detail"
        role="dialog"
        tabIndex={-1}
        aria-modal={moving.pending ? undefined : true}
        aria-hidden={moving.pending ? true : undefined}
        inert={moving.pending ? true : undefined}
        aria-labelledby="sessions-detail-title"
      >
        <header className="sessions-detail-header">
          <div>
            <h1 id="sessions-detail-title">{state.context.title}</h1>
            <p>
              {state.context.projectName} <span aria-hidden="true">/</span>{' '}
              {state.context.workspaceName} · {state.context.hostLabel} ·{' '}
              {state.context.providerName}
            </p>
          </div>
          <div className="sessions-detail-actions">
            {commands && row?.lifecycle === 'live' ? (
              <div className="sessions-change-workspace">
                <button
                  type="button"
                  disabled={!foreground || !ready || moving.busy}
                  onClick={moving.open}
                >
                  Change workspace
                </button>
                {moving.targets ? (
                  <div className="terminal-move-menu" role="menu">
                    {moving.targets.map((target) => (
                      <button
                        type="button"
                        role="menuitem"
                        key={target.id}
                        onClick={() => moving.plan(target.id)}
                      >
                        {target.name}
                      </button>
                    ))}
                    <button type="button" role="menuitem" onClick={moving.cancel}>
                      Cancel
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
            <button type="button" autoFocus onClick={onBack}>
              Close
            </button>
            <button type="button" onClick={onOpenWorkspace}>
              Go to workspace
            </button>
          </div>
        </header>
        {moving.feedback ? <p role="status">{moving.feedback}</p> : null}
        <p className="sessions-detail-status" role="status">
          {state.message ??
            (state.status === 'resolving' ? 'Attaching the exact live terminal…' : '')}
        </p>
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
      {moving.pending ? (
        <TerminalMoveDialog
          plan={moving.pending.plan}
          actionLabel="Change workspace"
          onCancel={moving.cancel}
          onMove={moving.confirm}
        />
      ) : null}
    </div>
  )
}
