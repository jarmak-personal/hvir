import type { ReactElement } from 'react'

import type {
  HarnessProfile,
  HarnessProfileProbe,
  HarnessProviderDescriptor,
  HarnessProviderId,
  WorkspaceState,
} from '../../../shared'
import { terminalAttentionLabel } from './terminal-attention'
import {
  compactHarnessCapabilityLabel,
  type HarnessLaunchMenuState,
} from './harness-launch-menu'
import { TerminalContextMeter } from './TerminalContextMeter'
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
  terminalTheme,
  recoveryReady,
  available,
  menuOpen,
  moveMenuOpen,
  moveTargets,
  launchMenuEntries,
  checkingHiddenProfiles,
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
  onResumeAll,
  onFocusSession,
  onMoveSession,
  onCloseSession,
}: {
  readonly label: string
  readonly visible: boolean
  readonly terminalTheme: string
  readonly recoveryReady: boolean
  readonly available: boolean
  readonly menuOpen: boolean
  readonly moveMenuOpen: boolean
  readonly moveTargets: readonly WorkspaceState[]
  readonly launchMenuEntries: readonly TerminalLaunchMenuEntry[]
  readonly checkingHiddenProfiles: boolean
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
  readonly onResumeAll: () => void
  readonly onFocusSession: (id: string) => void
  readonly onMoveSession: (id: string) => void
  readonly onCloseSession: (id: string) => void
}): ReactElement {
  const { menuRef: launchMenuRef, menuStyle: launchMenuStyle } =
    useTerminalLaunchMenuLayout(menuOpen)
  const dormantCount = sessions.filter((session) => session.dormant).length

  return (
    <aside
      className="terminal-rail"
      aria-label={`Open terminals in ${label}`}
      data-terminal-theme={terminalTheme}
      data-diagnostic-capture="terminal"
      hidden={!visible}
    >
      <header className="terminal-rail-header">
        <span>Terminals</span>
        <div className="terminal-header-actions">
          {dormantCount > 0 ? (
            <button
              type="button"
              className="terminal-resume-all-button"
              aria-label={`Resume all now, start ${dormantCount} dormant ${dormantCount === 1 ? 'terminal' : 'terminals'}`}
              title={`Start ${dormantCount} dormant ${dormantCount === 1 ? 'terminal' : 'terminals'} with bounded per-host concurrency`}
              disabled={!recoveryReady || !available}
              onClick={onResumeAll}
            >
              Resume all now · {dormantCount}
            </button>
          ) : null}
          <div className="terminal-move-control">
            <button
              type="button"
              className={`terminal-icon-button terminal-workspace-move-button${moveTargets.some((target) => target.newlyDiscovered) ? ' has-new-target' : ''}`}
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
                    <button type="button" role="menuitem" onClick={onDismissNewTargets}>
                      Dismiss new-worktree indicator
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="terminal-icon-button terminal-split-button"
            aria-label="Split terminal"
            title="Open a shell in the other terminal split"
            disabled={!recoveryReady || !available}
            onClick={onSplit}
          >
            ◫
          </button>
          <button
            type="button"
            className="terminal-icon-button terminal-settings-button"
            aria-label="Open settings"
            title="Settings"
            onClick={onOpenSettings}
          >
            ⚙
          </button>
          <div className="terminal-new-control">
            <button
              type="button"
              className="terminal-icon-button"
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
                {launchMenuEntries.flatMap(({ profile, provider, state }) => {
                  if (!state.visible) return []
                  const capability = compactHarnessCapabilityLabel(
                    provider?.default === true,
                    state.probe?.capabilities ?? provider?.capabilities,
                  )
                  const details = [
                    provider && provider.displayName !== profile.displayName
                      ? provider.displayName
                      : undefined,
                    capability,
                    state.checking ? 'Checking…' : undefined,
                  ].filter((value): value is string => Boolean(value))
                  return (
                    <button
                      key={profile.id}
                      type="button"
                      role="menuitem"
                      title={launchMenuDescription(profile, provider, state.probe)}
                      onClick={() => onAddSession(profile)}
                    >
                      <span>
                        <strong>{profile.displayName}</strong>
                        {profile.risk === 'standard' ? null : (
                          <em className={`harness-risk ${profile.risk}`}>
                            {riskLabel(profile.risk)}
                          </em>
                        )}
                      </span>
                      {details.length > 0 ? <small>{details.join(' · ')}</small> : null}
                    </button>
                  )
                })}
                {checkingHiddenProfiles ? (
                  <div className="terminal-new-menu-checking" role="status">
                    Checking configured harnesses…
                  </div>
                ) : null}
                <div className="terminal-new-menu-actions">
                  <button type="button" role="menuitem" onClick={onAddHarness}>
                    Add a harness…
                  </button>
                  <button type="button" role="menuitem" onClick={onRefreshProbes}>
                    Refresh availability
                  </button>
                  <button type="button" role="menuitem" onClick={onOpenHarnessSettings}>
                    Configure harnesses…
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </header>
      <div className="terminal-list" role="list">
        {sessions.map((session) => {
          const provider = providerDescriptor(providers, session.providerId)
          const contextPresentation = provider?.capabilities.contextPresentation
          return (
            <div
              key={session.id}
              className={`terminal-list-row${session.id === activeId ? ' active' : ''}${session.dormant ? ' dormant' : ''}`}
              data-terminal-dormant={session.dormant ? 'true' : undefined}
              role="listitem"
            >
              <button
                type="button"
                className="terminal-list-main"
                data-terminal-session={session.id}
                onClick={() => onFocusSession(session.id)}
              >
                <span className="terminal-list-copy">
                  <span className="terminal-list-title">{session.title}</span>
                  <span className="terminal-list-meta">
                    <span
                      className={`terminal-list-profile${profileRiskClass(profiles, session.profileId)}`}
                      title={profileRiskTitle(profiles, session.profileId)}
                      aria-label={profileRiskAriaLabel(profiles, session.profileId)}
                    >
                      {profileDisplayName(profiles, session.profileId)}
                    </span>{' '}
                    · {session.status}
                    {identityLabel(session.identityStatus)}
                  </span>
                  {contextPresentation === 'count' ||
                  contextPresentation === 'pressure' ? (
                    <TerminalContextMeter
                      telemetry={session.telemetry}
                      countOnly={contextPresentation === 'count'}
                    />
                  ) : null}
                </span>
                {session.attention ? (
                  <span
                    className={`terminal-attention-badge ${session.attention}`}
                    aria-label={terminalAttentionLabel(session.attention)}
                    title={terminalAttentionLabel(session.attention)}
                  >
                    {session.attention === 'output'
                      ? 'new'
                      : session.attention === 'bell'
                        ? 'bell'
                        : 'ready'}
                  </span>
                ) : null}
              </button>
              {split ? (
                <button
                  type="button"
                  className="terminal-move-button"
                  aria-label={`Move ${session.title} to ${session.pane === 'primary' ? 'right' : 'left'} split`}
                  title={`Move to ${session.pane === 'primary' ? 'right' : 'left'} split`}
                  onClick={() => onMoveSession(session.id)}
                >
                  {session.pane === 'primary' ? '→' : '←'}
                </button>
              ) : null}
              <button
                type="button"
                className="terminal-close-button"
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

function profileRiskClass(
  profiles: readonly HarnessProfile[],
  id: TerminalSession['profileId'],
): string {
  const risk = profiles.find((profile) => profile.id === id)?.risk
  return risk && risk !== 'standard' ? ` ${risk}` : ''
}

function profileRiskTitle(
  profiles: readonly HarnessProfile[],
  id: TerminalSession['profileId'],
): string | undefined {
  const risk = profiles.find((profile) => profile.id === id)?.risk
  return risk === 'elevated'
    ? 'Elevated permissions'
    : risk === 'unclassified'
      ? 'Unclassified permissions'
      : undefined
}

function profileRiskAriaLabel(
  profiles: readonly HarnessProfile[],
  id: TerminalSession['profileId'],
): string {
  const name = profileDisplayName(profiles, id)
  const risk = profileRiskTitle(profiles, id)
  return risk ? `${name}, ${risk.toLowerCase()}` : name
}

function identityLabel(status: TerminalSession['identityStatus']): string {
  if (status === 'discovering') return ' · resume pending'
  if (status === 'ambiguous' || status === 'unavailable') {
    return ' · resume unavailable'
  }
  return ''
}

function riskLabel(risk: HarnessProfile['risk']): string {
  return risk === 'elevated'
    ? 'Elevated'
    : risk === 'unclassified'
      ? 'Unclassified'
      : 'Standard'
}

function probeLabel(probe: HarnessProfileProbe | undefined): string {
  if (!probe) return 'Unchecked'
  switch (probe.status) {
    case 'available':
      return probe.version ?? 'Available'
    case 'executable-missing':
      return 'Executable missing'
    case 'version-unsupported':
      return 'Version incompatible'
    case 'capability-absent':
      return 'Capability unavailable'
    case 'authentication-required':
      return 'Authentication needed'
    case 'disconnected':
      return 'Host disconnected'
    case 'timeout':
      return 'Probe timed out'
    case 'malformed-output':
      return 'Version unknown'
    case 'probe-failed':
      return 'Probe failed'
    case 'unchecked':
      return 'Unchecked'
  }
}

function launchMenuDescription(
  profile: HarnessProfile,
  provider: HarnessProviderDescriptor | undefined,
  probe: HarnessProfileProbe | undefined,
): string {
  const capability = compactHarnessCapabilityLabel(
    provider?.default === true,
    probe?.capabilities ?? provider?.capabilities,
  )
  return [
    profile.displayName,
    provider?.displayName ?? profile.providerId,
    capability,
    probe ? probeLabel(probe) : undefined,
    probe?.detail,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' · ')
}
