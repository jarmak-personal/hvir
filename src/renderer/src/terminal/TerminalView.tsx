import type { ReactElement } from 'react'

import type {
  ComposerSubmitMode,
  HarnessTelemetry,
  HarnessModifiedKeyProtocol,
  HarnessProfileId,
  HarnessProviderCapabilities,
  HostConnectionState,
  HostPath,
  TerminalIdentityStatus,
} from '../../../shared'
import type { TerminalThemeOverride } from '../settings/settings'
import { useAppTheme, type AppTheme } from '../theme'
import type { TerminalLinkActivation } from './terminal-pane'
import { useTerminalPaneController } from './use-terminal-pane-controller'
import type { FreshTerminalStart } from './terminal-runtime'
import type { TerminalRuntimeRegistry } from './terminal-runtime-registry'

interface TerminalViewProps {
  readonly sessionId: string
  readonly profileId: HarnessProfileId
  readonly launchRevision: number
  readonly riskAcknowledged: boolean
  readonly supportsResume: boolean
  readonly fallbackTitle: string
  readonly harnessSessionId?: string
  readonly resumeOnStart: boolean
  readonly position: number
  readonly slot: 'primary' | 'secondary'
  readonly visible: boolean
  readonly active: boolean
  readonly modifiedKeyProtocol: HarnessModifiedKeyProtocol
  readonly metaEnterAliasesControl: boolean
  readonly themeOverride: TerminalThemeOverride
  readonly composerSubmitMode: ComposerSubmitMode
  readonly cwd: HostPath
  readonly workspaceRoot: HostPath
  readonly runtimes: TerminalRuntimeRegistry
  readonly connectionState: HostConnectionState
  readonly onTitle: (title: string) => void
  readonly onStatus: (status: string) => void
  readonly onTelemetry: (telemetry: HarnessTelemetry | undefined) => void
  readonly onIdentity: (
    harnessSessionId: string | undefined,
    status: TerminalIdentityStatus,
  ) => void
  readonly onStarted: () => void
  readonly onFreshStarted: (started: FreshTerminalStart) => void
  readonly onCapabilities: (capabilities: HarnessProviderCapabilities) => void
  readonly onInput: (data: string) => void
  readonly onOutput: () => void
  readonly onBell: () => void
  readonly onFocus: () => void
  readonly onLink: (activation: TerminalLinkActivation) => void
}

export function TerminalView(props: TerminalViewProps): ReactElement {
  const {
    sessionId,
    supportsResume,
    harnessSessionId,
    slot,
    visible,
    active,
    themeOverride,
    connectionState,
  } = props
  const appTheme = useAppTheme()
  const effectiveTheme: AppTheme = themeOverride === 'app' ? appTheme : themeOverride
  const controller = useTerminalPaneController(props, props.runtimes)
  const { containerRef, title, status, exited, restart, startFresh, focus } = controller
  const canRecoverHarness = supportsResume && Boolean(harnessSessionId)

  return (
    <section
      className={`terminal-panel terminal-surface${visible ? ' visible' : ''}${active ? ' active' : ''}`}
      data-terminal-slot={slot}
      aria-label={title}
      aria-hidden={!visible}
      data-terminal-session={sessionId}
      data-terminal-status={status}
    >
      {visible && connectionState === 'connected' && exited ? (
        <div
          className="terminal-recovery-actions"
          role="group"
          aria-label={`Recovery actions for ${title}`}
        >
          <span className="terminal-recovery-status" role="status">
            {status}
          </span>
          {canRecoverHarness ? (
            <button
              type="button"
              className="terminal-start-fresh"
              aria-label={`Start fresh ${title}`}
              onClick={startFresh}
            >
              Start fresh
            </button>
          ) : null}
          <button
            type="button"
            className="terminal-restart"
            aria-label={`${canRecoverHarness ? 'Retry recovery' : 'Restart'} ${title}`}
            onClick={restart}
          >
            {canRecoverHarness ? 'Retry recovery' : 'Restart'}
          </button>
        </div>
      ) : null}
      <div
        className="terminal-container"
        data-terminal-theme={effectiveTheme}
        ref={containerRef}
        onMouseDown={focus}
      />
    </section>
  )
}
