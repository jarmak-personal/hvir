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
import { TerminalContextMenu } from './TerminalContextMenu'
import { terminalForkAvailability } from './terminal-fork-policy'
import { terminalThemePalette } from './terminal-theme-catalog'
import { TerminalSearch } from './TerminalSearch'
import type {
  TerminalCursorDefaults,
  TerminalLinkActivation,
  TerminalTypography,
} from './terminal-pane'
import { useTerminalPaneController } from './use-terminal-pane-controller'
import type { FreshTerminalStart } from './terminal-runtime-options'
import type { TerminalForkRequest } from './terminal-workspace-model'
import type { TerminalRuntimeRegistry } from './terminal-runtime-registry'
import { useTerminalContextMenu } from './use-terminal-context-menu'

interface TerminalViewProps {
  readonly sessionId: string
  readonly profileId: HarnessProfileId
  readonly launchRevision: number
  readonly supportsResume: boolean
  readonly capabilities: HarnessProviderCapabilities
  readonly exactForkLaunch?: true
  readonly fallbackTitle: string
  readonly harnessSessionId?: string
  readonly identityStatus?: TerminalIdentityStatus
  readonly identityDiverged?: true
  readonly forkRequest?: TerminalForkRequest
  readonly forkPending?: true
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
  readonly lightThemeId: string
  readonly darkThemeId: string
  readonly typography: TerminalTypography
  readonly cursorDefaults: TerminalCursorDefaults
  readonly ligatures: boolean
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
    identityDiverged?: true,
  ) => void
  readonly onStartFailed?: (reason: string) => void
  readonly onExit?: (exitCode: number) => void
  readonly onStarted: () => void
  readonly onFreshStarted: (started: FreshTerminalStart) => void
  readonly onCapabilities: (capabilities: HarnessProviderCapabilities) => void
  readonly onInput: (data: string) => void
  readonly onOutput: () => void
  readonly onBell: () => void
  readonly onFocus: () => void
  readonly onLink: (activation: TerminalLinkActivation) => void
  readonly onSplit: () => void
  readonly onFork: (sessionId: string) => void
  readonly onOpenTerminalSettings: () => void
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
    lightThemeId,
    darkThemeId,
    connectionState,
  } = props
  const appTheme = useAppTheme()
  const effectiveTheme: AppTheme = themeOverride === 'app' ? appTheme : themeOverride
  const terminalTheme = terminalThemePalette(effectiveTheme, lightThemeId, darkThemeId)
  const controller = useTerminalPaneController(
    {
      ...props,
      presentation: visible ? 'visible' : 'hidden',
      theme: terminalTheme,
    },
    props.runtimes,
    props.presented,
  )
  const {
    containerRef,
    live,
    title,
    status,
    exited,
    semanticRegionsAvailable,
    semanticRegion,
    restart,
    startFresh,
    previousSemanticRegion,
    nextSemanticRegion,
    searchController,
    openSearch,
    getContextMenuTarget,
    focus,
  } = controller
  const contextMenu = useTerminalContextMenu(getContextMenuTarget, visible)
  const forkAvailability = terminalForkAvailability(
    {
      capabilities: props.capabilities,
      harnessSessionId: props.harnessSessionId,
      identityStatus: props.identityStatus,
      identityDiverged: props.identityDiverged,
      forkPending: props.forkPending,
    },
    props,
    live && contextMenu.request?.target.isCurrent() === true,
  )
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
      {visible && active && semanticRegionsAvailable ? (
        <div
          className="terminal-semantic-navigation"
          role="group"
          aria-label="Transcript regions"
          onMouseDown={(event) => event.preventDefault()}
        >
          <button
            type="button"
            aria-label="Previous transcript region"
            title="Previous transcript region"
            onClick={previousSemanticRegion}
          >
            ↑
          </button>
          <span className="terminal-semantic-region" role="status" aria-live="polite">
            {semanticRegion
              ? `${regionLabel(semanticRegion.kind)} ${semanticRegion.index} of ${semanticRegion.total}`
              : 'Transcript regions'}
          </span>
          <button
            type="button"
            aria-label="Next transcript region"
            title="Next transcript region"
            onClick={nextSemanticRegion}
          >
            ↓
          </button>
        </div>
      ) : null}
      <div
        className="terminal-container"
        data-terminal-theme={effectiveTheme}
        style={{ backgroundColor: terminalTheme.background }}
        ref={containerRef}
        tabIndex={-1}
        onFocus={(event) => {
          if (event.target === event.currentTarget) focus()
        }}
        onMouseDown={focus}
        onContextMenu={contextMenu.openFromPointer}
        onKeyDownCapture={contextMenu.openFromKeyboard}
      />
      <TerminalSearch
        controller={searchController}
        canCopyRegion={semanticRegionsAvailable}
      />
      <TerminalContextMenu
        controller={contextMenu}
        onSearch={openSearch}
        onSplit={props.onSplit}
        onFork={() => props.onFork(sessionId)}
        forkAvailability={forkAvailability}
        onOpenSettings={props.onOpenTerminalSettings}
      />
    </section>
  )
}

function regionLabel(kind: 'prompt' | 'command' | 'output'): string {
  return `${kind[0]!.toUpperCase()}${kind.slice(1)}`
}
