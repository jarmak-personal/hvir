import { useEffect, useRef, useSyncExternalStore, type ReactElement } from 'react'

import {
  sessionsCompactionFact,
  type HostConnectionState,
  type HarnessProfile,
  type HarnessProviderDescriptor,
  type HarnessProviderId,
  type WorkspaceState,
} from '../../../shared'
import { ExtensionTerminalItems } from '../extensions/ExtensionTerminalItems'
import { CompactionMarkers } from '../harness/CompactionMarkers'
import { SessionDetailsPopover } from '../harness/SessionDetailsPopover'
import { sessionDetailsModel } from '../harness/session-details-model'
import { useSessionDetailsPopover } from '../harness/use-session-details-popover'
import { useSessionsDetailsUsage } from '../harness/use-session-details-usage'
import type { SessionsProjectionCoordinator } from '../sessions/sessions-projection-coordinator'
import { useSessionsForeground } from '../sessions/use-sessions-foreground'
import { terminalAttentionBadgeText, terminalAttentionLabel } from './terminal-attention'
import {
  compactHarnessCapabilityLabel,
  launchAvailabilityLabel,
  type HarnessLaunchMenuState,
} from './harness-launch-menu'
import { TerminalContextMeter } from './TerminalContextMeter'
import { TerminalRailCompact } from './TerminalRailCompact'
import type { TerminalSession } from './terminal-workspace-model'
import { useTerminalLaunchMenuLayout } from './use-terminal-launch-menu-layout'

export interface TerminalLaunchMenuEntry {
  readonly profile: HarnessProfile
  readonly provider?: HarnessProviderDescriptor
  readonly state: HarnessLaunchMenuState
}

export function TerminalRail({
  label,
  visible,
  compact,
  onCompact,
  terminalTheme,
  recoveryReady,
  available,
  menuOpen,
  sessionsProjection,
  connectionState = 'connected',
  moveMenuOpen,
  moveTargets,
  launchMenuEntries,
  split,
  sessions,
  activeId,
  providers,
  profiles,
  onSplit,
  onOpenSettings,
  onToggleMenu,
  onToggleMoveMenu,
  onPlanMove,
  onDismissNewTargets,
  onAddSession,
  onAddHarness,
  onRefreshProbes,
  onOpenHarnessSettings,
  onFocusSession,
  onMoveSession,
  onCloseSession,
}: {
  readonly label: string
  readonly visible: boolean
  readonly compact: boolean
  readonly onCompact: (compact: boolean) => void
  readonly terminalTheme: string
  readonly recoveryReady: boolean
  readonly available: boolean
  readonly menuOpen: boolean
  readonly sessionsProjection: SessionsProjectionCoordinator
  readonly connectionState?: HostConnectionState
  readonly moveMenuOpen: boolean
  readonly moveTargets: readonly WorkspaceState[]
  readonly launchMenuEntries: readonly TerminalLaunchMenuEntry[]
  readonly split: boolean
  readonly sessions: readonly TerminalSession[]
  readonly activeId?: string
  readonly providers: readonly HarnessProviderDescriptor[]
  readonly profiles: readonly HarnessProfile[]
  readonly onSplit: () => void
  readonly onOpenSettings: () => void
  readonly onToggleMenu: () => void
  readonly onToggleMoveMenu: () => void
  readonly onPlanMove: (target: WorkspaceState) => void
  readonly onDismissNewTargets: () => void
  readonly onAddSession: (profile: HarnessProfile) => void
  readonly onAddHarness: () => void
  readonly onRefreshProbes: () => void
  readonly onOpenHarnessSettings: () => void
  readonly onFocusSession: (id: string) => void
  readonly onMoveSession: (id: string) => void
  readonly onCloseSession: (id: string) => void
}): ReactElement {
  const rail = useRef<HTMLElement>(null)
  const details = useSessionDetailsPopover(label, () => {
    rail.current?.querySelector<HTMLButtonElement>('.terminal-list-main')?.focus()
  })
  const detailsRequest = details.request
  const dismissDetails = details.dismiss
  const foreground = useSessionsForeground()
  const projection = useSyncExternalStore(
    sessionsProjection.subscribe,
    sessionsProjection.snapshot,
    sessionsProjection.snapshot,
  )
  const surfaceActive = visible && !compact && foreground
  const detailsActive = surfaceActive && detailsRequest !== undefined
  useEffect(() => {
    if (!surfaceActive) dismissDetails(false)
  }, [dismissDetails, surfaceActive])
  const detailsRow =
    projection.status === 'available' && detailsRequest
      ? projection.rows.find(
          (candidate) => String(candidate.handle) === detailsRequest.target,
        )
      : undefined
  const detailsUsage = useSessionsDetailsUsage(detailsRow, projection, detailsActive)
  useEffect(() => {
    if (detailsActive) return sessionsProjection.acquire()
  }, [detailsActive, sessionsProjection])
  useEffect(() => {
    if (!detailsRequest) return
    if (projection.status === 'available' && !detailsRow) {
      dismissDetails(false)
      return
    }
    if (projection.status !== 'unavailable') return
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled && sessionsProjection.snapshot().status === 'unavailable') {
        dismissDetails(false)
      }
    })
    return () => {
      cancelled = true
    }
  }, [detailsRequest, detailsRow, dismissDetails, projection.status, sessionsProjection])
  const detailsModel = detailsRow
    ? sessionDetailsModel(detailsRow, detailsUsage)
    : detailsRequest && projection.status === 'available'
      ? null
      : undefined
  const { menuRef: launchMenuRef, menuStyle: launchMenuStyle } =
    useTerminalLaunchMenuLayout(menuOpen)
  const applyCompact = (next: boolean): void => {
    if (next && menuOpen) onToggleMenu()
    if (next && moveMenuOpen) onToggleMoveMenu()
    onCompact(next)
  }

  return (
    <aside
      ref={rail}
      className="terminal-rail hvir-panel"
      aria-label={`Open terminals in ${label}`}
      data-terminal-theme={terminalTheme}
      data-diagnostic-capture="terminal"
      hidden={!visible}
    >
      <header className="terminal-rail-header hvir-panel" hidden={compact}>
        <span>Terminals</span>
        <div className="terminal-header-actions">
          <ExtensionTerminalItems placement="header" active={surfaceActive} />
          <button
            type="button"
            className="terminal-icon-button terminal-rail-collapse hvir-button hvir-panel"
            aria-label="Collapse terminal rail"
            title="Collapse terminal rail"
            onClick={() => applyCompact(true)}
          >
            <svg aria-hidden="true" viewBox="0 0 16 16">
              <path d="M4.5 3 9 8l-4.5 5M8.5 3 13 8l-4.5 5" />
            </svg>
          </button>
          <div className="terminal-move-control">
            <button
              type="button"
              className={
                `terminal-icon-button terminal-workspace-move-button${moveTargets.some((target) => target.newlyDiscovered) ? ' has-new-target' : ''}` +
                ' hvir-button'
              }
              aria-label={
                moveTargets.some((target) => target.newlyDiscovered)
                  ? 'Move terminal, new worktree available'
                  : 'Move terminal to another worktree'
              }
              title="Move active terminal to another worktree"
              aria-haspopup="menu"
              aria-expanded={moveMenuOpen}
              disabled={
                !recoveryReady || !available || !activeId || moveTargets.length === 0
              }
              onClick={onToggleMoveMenu}
            >
              ⇱
              {moveTargets.some((target) => target.newlyDiscovered) ? (
                <span className="terminal-new-worktree-badge">new</span>
              ) : null}
            </button>
            {moveMenuOpen && activeId ? (
              <div className="terminal-move-menu" role="menu">
                <p>
                  Move{' '}
                  <strong>
                    {sessions.find((session) => session.id === activeId)?.title}
                  </strong>{' '}
                  from {label}
                </p>
                {moveTargets.map((target) => (
                  <button
                    key={target.id}
                    type="button"
                    role="menuitem"
                    onClick={() => onPlanMove(target)}
                    className="hvir-button"
                  >
                    <span>
                      <strong>{target.name}</strong>
                      {target.newlyDiscovered ? <em>New</em> : null}
                    </span>
                    <small>{target.root.path}</small>
                  </button>
                ))}
                {moveTargets.some((target) => target.newlyDiscovered) ? (
                  <div className="terminal-move-menu-actions">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={onDismissNewTargets}
                      className="hvir-button"
                    >
                      Dismiss new-worktree indicator
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="terminal-icon-button terminal-split-button hvir-button"
            aria-label="Split terminal"
            title="Open a shell in the other terminal split"
            disabled={!recoveryReady || !available}
            onClick={onSplit}
          >
            ◫
          </button>
          <button
            type="button"
            className="terminal-icon-button terminal-settings-button hvir-button"
            aria-label="Open settings"
            title="Settings"
            onClick={onOpenSettings}
          >
            ⚙
          </button>
          <div className="terminal-new-control">
            <button
              type="button"
              className="terminal-icon-button hvir-button"
              aria-label="New terminal"
              title="New terminal"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              disabled={!recoveryReady || !available}
              onClick={onToggleMenu}
            >
              +
            </button>
            {menuOpen ? (
              <div
                ref={launchMenuRef}
                className="terminal-new-menu"
                role="menu"
                style={launchMenuStyle}
              >
                {launchMenuEntries.map(({ profile, provider, state }) => {
                  const capability = compactHarnessCapabilityLabel(
                    provider?.default === true,
                    state.probe?.capabilities ?? provider?.capabilities,
                  )
                  const details = [
                    provider && provider.displayName !== profile.displayName
                      ? provider.displayName
                      : undefined,
                    capability,
                    profile.builtIn ? undefined : launchAvailabilityLabel(state),
                  ].filter((value): value is string => Boolean(value))
                  return (
                    <button
                      key={profile.id}
                      type="button"
                      role="menuitem"
                      data-harness-availability={state.availability}
                      title={launchMenuDescription(profile, provider, state)}
                      onClick={() => onAddSession(profile)}
                      className="hvir-button"
                    >
                      <span>
                        <strong>{profile.displayName}</strong>
                      </span>
                      {details.length > 0 ? <small>{details.join(' · ')}</small> : null}
                    </button>
                  )
                })}
                <div className="terminal-new-menu-actions">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={onAddHarness}
                    className="hvir-button"
                  >
                    Add a harness…
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={onRefreshProbes}
                    className="hvir-button"
                  >
                    Refresh availability
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={onOpenHarnessSettings}
                    className="hvir-button"
                  >
                    Configure harnesses…
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </header>
      <div className="terminal-list" role="list" hidden={compact}>
        {sessions.map((session) => {
          const provider = providerDescriptor(providers, session.providerId)
          const contextPresentation = provider?.capabilities.contextPresentation
          const showsContext =
            contextPresentation === 'count' || contextPresentation === 'pressure'
          const compactionFact = sessionsCompactionFact(
            session.capabilities.compactionObservation === true,
            session.dormant !== true,
            session.telemetry,
            session.providerId,
            connectionState,
          )
          return (
            <div
              key={session.id}
              className={
                `terminal-list-row${session.id === activeId ? ' active' : ''}${session.dormant ? ' dormant' : ''}` +
                ' hvir-row'
              }
              data-terminal-dormant={session.dormant ? 'true' : undefined}
              role="listitem"
              onContextMenu={(event) => details.openFromPointer(event, session.id)}
            >
              <button
                type="button"
                className="terminal-list-main hvir-button"
                data-terminal-session={session.id}
                onClick={() => onFocusSession(session.id)}
                onKeyDown={(event) => details.openFromKeyboard(event, session.id)}
              >
                <span className="terminal-list-copy">
                  <span className="terminal-list-title">{session.title}</span>
                  <span className="terminal-list-meta">
                    <span className="terminal-list-profile">
                      {profileDisplayName(profiles, session.profileId)}
                    </span>{' '}
                    · {session.status}
                    {identityLabel(session.identityStatus)}
                  </span>
                  {showsContext ? (
                    <>
                      <TerminalContextMeter
                        telemetry={session.telemetry}
                        countOnly={contextPresentation === 'count'}
                        pressurePolicy={provider?.capabilities.contextPressure}
                      />
                      {session.capabilities.compactionObservation ? (
                        <CompactionMarkers fact={compactionFact} />
                      ) : null}
                    </>
                  ) : null}
                </span>
                {session.attention ? (
                  <span
                    className={`terminal-attention-badge ${session.attention}`}
                    aria-label={terminalAttentionLabel(session.attention)}
                    title={terminalAttentionLabel(session.attention)}
                  >
                    {terminalAttentionBadgeText(session.attention)}
                  </span>
                ) : null}
              </button>
              <ExtensionTerminalItems
                placement="session"
                terminalId={session.id}
                active={surfaceActive}
              />
              {split ? (
                <button
                  type="button"
                  className="terminal-move-button hvir-button"
                  aria-label={`Move ${session.title} to ${session.pane === 'primary' ? 'right' : 'left'} split`}
                  title={`Move to ${session.pane === 'primary' ? 'right' : 'left'} split`}
                  onClick={() => onMoveSession(session.id)}
                >
                  {session.pane === 'primary' ? '→' : '←'}
                </button>
              ) : null}
              <button
                type="button"
                className="terminal-close-button hvir-button"
                aria-label={`Close ${session.title}`}
                title="Close terminal"
                onClick={() => onCloseSession(session.id)}
              >
                ×
              </button>
            </div>
          )
        })}
      </div>
      <TerminalRailCompact
        hidden={!compact}
        sessions={sessions}
        activeId={activeId}
        onFocusSession={onFocusSession}
        onRestore={() => applyCompact(false)}
      />
      <SessionDetailsPopover controller={details} details={detailsModel} />
    </aside>
  )
}

function providerDescriptor(
  providers: readonly HarnessProviderDescriptor[],
  id: HarnessProviderId,
): HarnessProviderDescriptor | undefined {
  return providers.find((provider) => provider.id === id)
}

function profileDisplayName(
  profiles: readonly HarnessProfile[],
  id: TerminalSession['profileId'],
): string {
  return profiles.find((profile) => profile.id === id)?.displayName ?? `Missing (${id})`
}

function identityLabel(status: TerminalSession['identityStatus']): string {
  if (status === 'discovering') return ' · resume pending'
  if (status === 'ambiguous' || status === 'unavailable') {
    return ' · resume unavailable'
  }
  return ''
}

function launchMenuDescription(
  profile: HarnessProfile,
  provider: HarnessProviderDescriptor | undefined,
  state: HarnessLaunchMenuState,
): string {
  const capability = compactHarnessCapabilityLabel(
    provider?.default === true,
    state.probe?.capabilities ?? provider?.capabilities,
  )
  return [
    profile.displayName,
    provider?.displayName ?? profile.providerId,
    capability,
    profile.builtIn ? undefined : launchAvailabilityLabel(state),
    state.probe?.detail,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' · ')
}
