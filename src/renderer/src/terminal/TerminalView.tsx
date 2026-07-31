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
import type { TerminalLinkActivation, TerminalTypography } from './terminal-pane'
import { useTerminalPaneController } from './use-terminal-pane-controller'
import type { FreshTerminalStart } from './terminal-runtime-options'
import type { TerminalRuntimeRegistry } from './terminal-runtime-registry'
import { RichOutputLane } from './RichOutputLane'

interface TerminalViewProps {
  readonly sessionId: string
  readonly profileId: HarnessProfileId
  readonly launchRevision: number
  readonly riskAcknowledged: boolean
  readonly supportsResume: boolean
  readonly capabilities: HarnessProviderCapabilities
  readonly fallbackTitle: string
  readonly harnessSessionId?: string
  readonly identityStatus?: TerminalIdentityStatus
  readonly resumeOnStart: boolean
  readonly startMode: 'interactive' | 'bulk'
  readonly position: number
  readonly slot: 'primary' | 'secondary'
  readonly presented: boolean
  readonly visible: boolean
  readonly active: boolean
  readonly modifiedKeyProtocol: HarnessModifiedKeyProtocol
  readonly metaEnterAliasesControl: boolean
  readonly themeOverride: TerminalThemeOverride
  readonly typography: TerminalTypography
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

export function TerminalView(props: TerminalViewProps): ReactElement | null {
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
  const controller = useTerminalPaneController(
    { ...props, presentation: visible ? 'visible' : 'hidden' },
    props.runtimes,
    props.presented,
  )
  const {
    containerRef,
    title,
    status,
    exited,
    richOutput,
    restart,
    startFresh,
    setRichOutputEnabled,
    focus,
  } = controller
  const canRecoverHarness = supportsResume && Boolean(harnessSessionId)

  if (!props.presented) return null

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
      <RichOutputLane
        snapshot={richOutput}
        visible={visible}
        onToggle={setRichOutputEnabled}
        onActivateLink={(link) => {
          if (link.kind === 'file') props.onLink({ kind: 'file', target: link.target })
          else window.open(link.target, '_blank', 'noopener,noreferrer')
        }}
        disclosureTarget={(link) =>
          link.kind === 'file'
            ? `${props.workspaceRoot.hostId}:${link.target}`
            : link.target
        }
        fontFamily={props.typography.fontFamily}
        fontSize={props.typography.fontSize}
      />
      <div
        className="terminal-container"
        data-terminal-theme={effectiveTheme}
        ref={containerRef}
        tabIndex={-1}
        onFocus={(event) => {
          if (event.target === event.currentTarget) focus()
        }}
        onMouseDown={focus}
      />
    </section>
  )
}
