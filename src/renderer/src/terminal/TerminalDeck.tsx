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
import type { TerminalSession } from './terminal-workspace-model'
import type { FreshTerminalStart } from './terminal-runtime-options'
import type { TerminalRuntimeRegistry } from './terminal-runtime-registry'
import { TerminalSessionRuntimes } from './TerminalSessionRuntimes'

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
  onFreshStarted,
  onInput,
  onOutput,
  onBell,
  onFocus,
  onLink,
  onSetPrimaryWidth,
  onResetPrimaryWidth,
  runtimes,
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
  readonly onFreshStarted: (id: string, started: FreshTerminalStart) => void
  readonly onInput: (id: string, data: string) => void
  readonly onOutput: (id: string) => void
  readonly onBell: (id: string) => void
  readonly onFocus: (id: string) => void
  readonly onLink: (session: TerminalSession, activation: TerminalLinkActivation) => void
  readonly onSetPrimaryWidth: (width: number) => void
  readonly onResetPrimaryWidth: () => void
  readonly runtimes: TerminalRuntimeRegistry
}): ReactElement {
  const style = primaryWidth
    ? ({ '--terminal-primary-track': `${primaryWidth}px` } as CSSProperties)
    : undefined
  const sessionRuntimes = (
    <TerminalSessionRuntimes
      sessions={sessions}
      providers={providers}
      activeId={activeId}
      primaryActiveId={primaryActiveId}
      secondaryActiveId={secondaryActiveId}
      presented={visible}
      terminalTheme={terminalTheme}
      composerSubmitMode={composerSubmitMode}
      workspaceRoot={workspaceRoot}
      connectionState={connectionState}
      onUpdateSession={onUpdateSession}
      onFreshStarted={onFreshStarted}
      onInput={onInput}
      onOutput={onOutput}
      onBell={onBell}
      onFocus={onFocus}
      onLink={onLink}
      runtimes={runtimes}
    />
  )
  if (!visible) return sessionRuntimes
  return (
    <div
      className={`terminal-deck${split ? ' split' : ''}`}
      ref={deckRef}
      style={style}
      aria-label={`${label} terminal workspace`}
      data-diagnostic-capture="terminal"
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
      {sessionRuntimes}
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
