import type { CSSProperties, ReactElement, RefObject } from 'react'

import type {
  ComposerSubmitMode,
  HarnessProviderDescriptor,
  HostConnectionState,
  HostPath,
} from '../../../shared'
import { PaneResizer } from '../layout/PaneResizer'
import type { TerminalThemeOverride } from '../settings/settings'
import type { TerminalLinkActivation } from './terminal-pane'
import { TerminalView } from './TerminalView'
import type { TerminalSession } from './terminal-workspace-model'

export function TerminalDeck({
  deckRef,
  label,
  visible,
  available,
  ready,
  sessions,
  providers,
  activeId,
  primaryActiveId,
  secondaryActiveId,
  split,
  primaryWidth,
  terminalTheme,
  composerSubmitMode,
  workspaceRoot,
  connectionState,
  onCreateDefault,
  onUpdateSession,
  onInput,
  onOutput,
  onBell,
  onFocus,
  onLink,
  onSetPrimaryWidth,
  onResetPrimaryWidth,
}: {
  readonly deckRef: RefObject<HTMLDivElement | null>
  readonly label: string
  readonly visible: boolean
  readonly available: boolean
  readonly ready: boolean
  readonly sessions: readonly TerminalSession[]
  readonly providers: readonly HarnessProviderDescriptor[]
  readonly activeId?: string
  readonly primaryActiveId?: string
  readonly secondaryActiveId?: string
  readonly split: boolean
  readonly primaryWidth?: number
  readonly terminalTheme: TerminalThemeOverride
  readonly composerSubmitMode: ComposerSubmitMode
  readonly workspaceRoot: HostPath
  readonly connectionState: HostConnectionState
  readonly onCreateDefault?: () => void
  readonly onUpdateSession: (
    id: string,
    update: (session: TerminalSession) => TerminalSession,
  ) => void
  readonly onInput: (id: string, data: string) => void
  readonly onOutput: (id: string) => void
  readonly onBell: (id: string) => void
  readonly onFocus: (id: string) => void
  readonly onLink: (session: TerminalSession, activation: TerminalLinkActivation) => void
  readonly onSetPrimaryWidth: (width: number) => void
  readonly onResetPrimaryWidth: () => void
}): ReactElement {
  const style = primaryWidth
    ? ({ '--terminal-primary-track': `${primaryWidth}px` } as CSSProperties)
    : undefined
  return (
    <div
      className={`terminal-deck${split ? ' split' : ''}`}
      ref={deckRef}
      style={style}
      aria-label={`${label} terminal workspace`}
      hidden={!visible}
    >
      {ready && sessions.length === 0 ? (
        <div className="terminal-empty">
          {available && onCreateDefault ? (
            <button type="button" onClick={onCreateDefault}>
              New terminal
            </button>
          ) : (
            <span>No retained terminals</span>
          )}
        </div>
      ) : null}
      {sessions.map((session, position) => {
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
            position={position}
            slot={session.pane}
            visible={
              visible &&
              session.id ===
                (session.pane === 'primary' ? primaryActiveId : secondaryActiveId)
            }
            active={visible && session.id === activeId}
            modifiedKeyProtocol={provider.terminalInput.modifiedKeyProtocol}
            metaEnterAliasesControl={
              provider.terminalInput.metaEnterAliasesControl
            }
            themeOverride={terminalTheme}
            composerSubmitMode={composerSubmitMode}
            cwd={workspaceRoot}
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
                current.resumeOnStart ? { ...current, resumeOnStart: false } : current,
              )
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
          />
        )
      })}
      {split ? (
        <PaneResizer
          orientation="vertical"
          className="terminal-split-resizer"
          label="Resize split terminals"
          onDrag={(clientX) => {
            const left = deckRef.current?.getBoundingClientRect().left ?? 0
            onSetPrimaryWidth(clientX - left)
          }}
          onNudge={(delta) => {
            const primary = deckRef.current?.querySelector<HTMLElement>(
              '[data-terminal-slot="primary"].visible',
            )
            if (primary) {
              onSetPrimaryWidth(primary.getBoundingClientRect().width + delta)
            }
          }}
          onReset={onResetPrimaryWidth}
        />
      ) : null}
    </div>
  )
}
