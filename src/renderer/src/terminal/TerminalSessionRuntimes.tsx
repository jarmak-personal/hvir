import type { ReactElement } from 'react'

import type {
  ComposerSubmitMode,
  HarnessProviderDescriptor,
  HostConnectionState,
  HostPath,
} from '../../../shared'
import type { TerminalThemeOverride } from '../settings/settings'
import type { TerminalLinkActivation, TerminalTypography } from './terminal-pane'
import type { TerminalRuntimeRegistry } from './terminal-runtime-registry'
import type { FreshTerminalStart } from './terminal-runtime-options'
import { TerminalView } from './TerminalView'
import type { TerminalSession } from './terminal-workspace-model'

export interface TerminalSessionRuntimesProps {
  readonly sessions: readonly TerminalSession[]
  readonly providers: readonly HarnessProviderDescriptor[]
  readonly activeId?: string
  readonly primaryActiveId?: string
  readonly secondaryActiveId?: string
  readonly presented: boolean
  readonly terminalTheme: TerminalThemeOverride
  readonly terminalTypography: TerminalTypography
  readonly composerSubmitMode: ComposerSubmitMode
  readonly workspaceRoot: HostPath
  readonly connectionState: HostConnectionState
  readonly onUpdateSession: (
    id: string,
    update: (session: TerminalSession) => TerminalSession,
  ) => void
  readonly onFreshStarted: (id: string, started: FreshTerminalStart) => void
  readonly onInput: (id: string, data: string) => void
  readonly onOutput: (id: string) => void
  readonly onBell: (id: string) => void
  readonly onFocus: (id: string) => void
  readonly onLink: (session: TerminalSession, activation: TerminalLinkActivation) => void
  readonly onSplit: () => void
  readonly onOpenTerminalSettings: () => void
  readonly runtimes: TerminalRuntimeRegistry
}

/** Keeps live session bindings owned even when their workspace view is absent. */
export function TerminalSessionRuntimes({
  sessions,
  providers,
  activeId,
  primaryActiveId,
  secondaryActiveId,
  presented,
  terminalTheme,
  terminalTypography,
  composerSubmitMode,
  workspaceRoot,
  connectionState,
  onUpdateSession,
  onFreshStarted,
  onInput,
  onOutput,
  onBell,
  onFocus,
  onLink,
  onSplit,
  onOpenTerminalSettings,
  runtimes,
}: TerminalSessionRuntimesProps): ReactElement {
  return (
    <>
      {sessions.map((session, position) => {
        if (session.dormant) return null
        const provider = providers.find(
          (candidate) => candidate.id === session.providerId,
        )
        if (!provider) return null
        return (
          <TerminalView
            key={session.id}
            sessionId={session.id}
            profileId={session.profileId}
            launchRevision={session.launchRevision}
            riskAcknowledged={session.riskAcknowledged}
            supportsResume={session.capabilities.exactResume}
            fallbackTitle={session.fallbackTitle}
            harnessSessionId={session.harnessSessionId}
            resumeOnStart={session.resumeOnStart}
            startMode={session.startMode ?? 'interactive'}
            position={position}
            slot={session.pane}
            presented={presented}
            visible={
              presented &&
              session.id ===
                (session.pane === 'primary' ? primaryActiveId : secondaryActiveId)
            }
            active={presented && session.id === activeId}
            modifiedKeyProtocol={provider.terminalInput.modifiedKeyProtocol}
            metaEnterAliasesControl={provider.terminalInput.metaEnterAliasesControl}
            themeOverride={terminalTheme}
            typography={terminalTypography}
            composerSubmitMode={composerSubmitMode}
            cwd={session.cwd}
            workspaceRoot={workspaceRoot}
            runtimes={runtimes}
            connectionState={connectionState}
            onTitle={(title) =>
              onUpdateSession(session.id, (current) => ({ ...current, title }))
            }
            onStatus={(status) =>
              onUpdateSession(session.id, (current) => ({ ...current, status }))
            }
            onTelemetry={(telemetry) =>
              onUpdateSession(session.id, (current) =>
                current.telemetry === telemetry ? current : { ...current, telemetry },
              )
            }
            onIdentity={(harnessSessionId, identityStatus) =>
              onUpdateSession(session.id, (current) => ({
                ...current,
                harnessSessionId: harnessSessionId ?? current.harnessSessionId,
                identityStatus,
              }))
            }
            onStarted={() =>
              onUpdateSession(session.id, (current) =>
                current.resumeOnStart || current.startMode === 'bulk'
                  ? { ...current, resumeOnStart: false, startMode: 'interactive' }
                  : current,
              )
            }
            onFreshStarted={(started: FreshTerminalStart) =>
              onFreshStarted(session.id, started)
            }
            onCapabilities={(capabilities) =>
              onUpdateSession(session.id, (current) =>
                current.capabilities === capabilities
                  ? current
                  : { ...current, capabilities },
              )
            }
            onInput={(data) => onInput(session.id, data)}
            onOutput={() => onOutput(session.id)}
            onBell={() => onBell(session.id)}
            onFocus={() => onFocus(session.id)}
            onLink={(activation) => onLink(session, activation)}
            onSplit={onSplit}
            onOpenTerminalSettings={onOpenTerminalSettings}
          />
        )
      })}
    </>
  )
}
