import type { Dispatch, ReactElement, SetStateAction } from 'react'

import type { HostPath } from '../../../shared'
import type { TerminalPreferences } from '../settings/settings'
import { useAppTheme } from '../theme'
import { harnessLaunchMenuState } from './harness-launch-menu'
import { profileProbe } from './terminal-probe-policy'
import { TerminalRail } from './TerminalRail'
import { TerminalWorkspaceDialogs } from './TerminalWorkspaceDialogs'
import { terminalWorkspaceSplit, type TerminalWorkspaceModel } from './terminal-workspace-model'
import type { useTerminalProfiles } from './use-terminal-profiles'
import type { useTerminalRecovery } from './use-terminal-recovery'
import type { useTerminalSessionCommands } from './use-terminal-session-commands'
import type { useTerminalWorkspaceMove } from './use-terminal-workspace-move'

export function TerminalWorkspaceControls({
  label,
  workspaceRoot,
  available,
  railCompact,
  onRailCompact,
  menuOpen,
  setMenuOpen,
  model,
  profileState,
  recovery,
  commands,
  moving,
  preferences,
  onOpenSettings,
  onOpenHarnessSettings,
  onAddHarness,
}: {
  readonly label: string
  readonly workspaceRoot: HostPath
  readonly available: boolean
  readonly railCompact: boolean
  readonly onRailCompact: (compact: boolean) => void
  readonly menuOpen: boolean
  readonly setMenuOpen: Dispatch<SetStateAction<boolean>>
  readonly model: TerminalWorkspaceModel
  readonly profileState: ReturnType<typeof useTerminalProfiles>
  readonly recovery: ReturnType<typeof useTerminalRecovery>
  readonly commands: ReturnType<typeof useTerminalSessionCommands>
  readonly moving: ReturnType<typeof useTerminalWorkspaceMove>
  readonly preferences: TerminalPreferences
  readonly onOpenSettings: () => void
  readonly onOpenHarnessSettings: () => void
  readonly onAddHarness: () => void
}): ReactElement {
  const appTheme = useAppTheme()
  const effectiveTerminalTheme =
    preferences.terminalTheme === 'app' ? appTheme : preferences.terminalTheme
  const { sessions, activeId } = model
  const { providers, profiles, probes, pendingProbeIds, acceptProfiles, refreshProbes } =
    profileState
  const {
    ready: recoveryReady,
    probesReady: recoveryProbesReady,
    candidates: recoveryCandidates,
    defaultProvider,
    defaultProfile,
    dismiss: dismissRecovery,
    skip: skipRecovery,
    resume: resumeRecovery,
    rebind: rebindRecovery,
  } = recovery
  const launchMenuEntries = profiles.map((profile) => {
    const probe = profileProbe(probes, profile)
    return {
      profile,
      provider: providers.find((candidate) => candidate.id === profile.providerId),
      state: harnessLaunchMenuState(profile, probe, pendingProbeIds.has(profile.id)),
    }
  })

  return (
    <>
      <TerminalRail
        label={label}
        visible
        compact={railCompact}
        onCompact={onRailCompact}
        terminalTheme={effectiveTerminalTheme}
        recoveryReady={recoveryReady}
        available={available}
        menuOpen={menuOpen}
        moveMenuOpen={moving.menuOpen}
        moveTargets={moving.moveTargets}
        launchMenuEntries={launchMenuEntries}
        split={terminalWorkspaceSplit(model)}
        sessions={sessions}
        activeId={activeId}
        providers={providers}
        profiles={profiles}
        onSplit={commands.split}
        onOpenSettings={onOpenSettings}
        onToggleMenu={() => setMenuOpen((open) => !open)}
        onToggleMoveMenu={() => {
          setMenuOpen(false)
          moving.toggleMenu()
        }}
        onPlanMove={moving.plan}
        onDismissNewTargets={moving.dismissNewTargets}
        onAddSession={(profile) => commands.add(profile.id)}
        onAddHarness={() => {
          setMenuOpen(false)
          onAddHarness()
        }}
        onRefreshProbes={() => refreshProbes(true)}
        onOpenHarnessSettings={() => {
          setMenuOpen(false)
          onOpenHarnessSettings()
        }}
        onFocusSession={commands.focus}
        onMoveSession={commands.moveToOtherPane}
        onCloseSession={commands.close}
      />
      <TerminalWorkspaceDialogs
        visible
        risk={
          commands.pendingRiskProfile
            ? {
                profile: commands.pendingRiskProfile,
                providers,
                root: workspaceRoot,
                acceptProfiles,
                launch: commands.launchAcknowledged,
                onCancel: commands.cancelRisk,
              }
            : undefined
        }
        move={
          moving.pending
            ? { plan: moving.pending, onCancel: moving.cancel, onMove: moving.confirm }
            : undefined
        }
        recovery={{
          ready: Boolean(
            recoveryCandidates.length > 0 &&
            recoveryProbesReady &&
            defaultProvider &&
            defaultProfile,
          ),
          sessions: recoveryCandidates,
          providers,
          profiles,
          probes,
          onRebind: rebindRecovery,
          onDismiss: dismissRecovery,
          onSkip: skipRecovery,
          onResume: resumeRecovery,
        }}
      />
    </>
  )
}
