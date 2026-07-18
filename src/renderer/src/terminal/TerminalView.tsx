import type { ReactElement } from 'react'

import type {
  HarnessTelemetry,
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
  readonly themeOverride: TerminalThemeOverride
  readonly cwd: HostPath
  readonly connectionState: HostConnectionState
  readonly onTitle: (title: string) => void
  readonly onStatus: (status: string) => void
  readonly onTelemetry: (telemetry: HarnessTelemetry | undefined) => void
  readonly onIdentity: (
    harnessSessionId: string | undefined,
    status: TerminalIdentityStatus,
  ) => void
  readonly onStarted: () => void
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
  const controller = useTerminalPaneController(props)
  const { workspaceRoot, containerRef, title, status, exited, restart, focus } =
    controller

  return (
    <section
      className={`terminal-panel terminal-surface${visible ? ' visible' : ''}${active ? ' active' : ''}`}
      data-terminal-slot={slot}
      aria-label={title}
      aria-hidden={!visible}
      data-terminal-session={sessionId}
      data-terminal-status={status}
    >
      {connectionState === 'connected' && exited ? (
        <button
          type="button"
          className="terminal-restart"
          aria-label={`${supportsResume && harnessSessionId ? 'Resume' : 'Restart'} ${title}`}
          onClick={restart}
        >
          {supportsResume && harnessSessionId ? 'Resume' : 'Restart'}
        </button>
      ) : null}
      <div
        key={`${workspaceRoot.hostId}:${workspaceRoot.path}:${connectionState}`}
        className="terminal-container"
        data-terminal-theme={effectiveTheme}
        ref={containerRef}
        onMouseDown={focus}
      />
    </section>
  )
}
