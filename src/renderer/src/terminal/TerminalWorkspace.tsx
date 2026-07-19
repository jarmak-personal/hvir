import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type ReactElement,
} from 'react'
import {
  type HarnessProviderDescriptor,
  type HarnessProfile,
  type HarnessProfileId,
  type HostConnectionState,
  type HostPath,
  type HarnessProviderId,
} from '../../../shared'
import { fitSplitPrimaryWidth } from '../layout/split-layout-policy'
import type { TerminalRecoveryMode, TerminalThemeOverride } from '../settings/settings'
import { useAppTheme } from '../theme'
import {
  normalizeTerminalWebTarget,
  resolveTerminalFileTarget,
  type ResolvedTerminalFileTarget,
} from './terminal-file-link'
import { HarnessRiskDialog } from './HarnessRiskDialog'
import { TerminalDeck } from './TerminalDeck'
import { TerminalRail } from './TerminalRail'
import { TerminalRecoveryDialog } from './TerminalRecoveryDialog'
import { profileRiskAcknowledged } from './terminal-profile-recovery'
import { profileProbe, terminalProbeMemory } from './terminal-probe-policy'
import {
  readTerminalSplitLayout,
  writeTerminalSplitLayout,
} from './terminal-split-persistence'
import {
  createTerminalSession,
  initialTerminalWorkspaceModel,
  nextTerminalSplitPane,
  terminalPaneActiveId,
  terminalWorkspaceReducer,
  terminalWorkspaceSplit,
  type TerminalSession,
  type TerminalWorkspaceAction,
} from './terminal-workspace-model'
import {
  useTerminalAttentionController,
  useTerminalAttentionRollup,
} from './use-terminal-attention-controller'
import { useTerminalProfiles } from './use-terminal-profiles'
import { useTerminalPersistence } from './use-terminal-persistence'
import { useTerminalRecovery } from './use-terminal-recovery'
import { harnessLaunchMenuState } from './harness-launch-menu'

interface TerminalWorkspaceProps {
  readonly cwd: HostPath
  readonly workspaceId: string
  readonly connectionState: HostConnectionState
  readonly available: boolean
  readonly visible: boolean
  readonly label: string
  readonly onRollup: (workspaceId: string, rollup: TerminalWorkspaceRollup) => void
  readonly onOpenPath: (target: ResolvedTerminalFileTarget) => void
  readonly onOpenWebLink: (activation: {
    readonly terminalId: string
    readonly workspaceRoot: HostPath
    readonly url: string
  }) => void
  readonly idleThresholdMs: number
  readonly recoveryMode: TerminalRecoveryMode
  readonly terminalTheme: TerminalThemeOverride
  readonly onOpenSettings: () => void
  readonly onOpenHarnessSettings: () => void
  readonly onAddHarness: () => void
}

export interface TerminalWorkspaceRollup {
  readonly unseen: number
  readonly actionable: number
}

export function TerminalWorkspace({
  cwd,
  workspaceId,
  connectionState,
  available,
  visible,
  label,
  onRollup,
  onOpenPath,
  onOpenWebLink,
  idleThresholdMs,
  recoveryMode,
  terminalTheme,
  onOpenSettings,
  onOpenHarnessSettings,
  onAddHarness,
}: TerminalWorkspaceProps): ReactElement {
  const appTheme = useAppTheme()
  const effectiveTerminalTheme = terminalTheme === 'app' ? appTheme : terminalTheme
  const workspaceRootRef = useRef(cwd)
  if (
    workspaceRootRef.current.hostId !== cwd.hostId ||
    workspaceRootRef.current.path !== cwd.path
  ) {
    workspaceRootRef.current = cwd
  }
  const workspaceRoot = workspaceRootRef.current
  const terminalDeckRef = useRef<HTMLDivElement>(null)
  const restoredSplitLayout = useRef(readTerminalSplitLayout(workspaceRoot))
  const [model, dispatch] = useReducer(terminalWorkspaceReducer, {
    ...initialTerminalWorkspaceModel,
    primaryWidth: restoredSplitLayout.current.primaryWidth,
  })
  const modelRef = useRef(model)
  const [menuOpen, setMenuOpen] = useState(false)
  const profileState = useTerminalProfiles({
    root: workspaceRoot,
    connectionState,
    menuOpen,
  })
  const {
    providers,
    profiles,
    probes,
    pendingProbeIds,
    acceptCatalog,
    acceptProfiles,
    acceptRecoveryProbes,
    refreshProbes,
  } = profileState
  const [pendingRiskProfile, setPendingRiskProfile] = useState<HarnessProfile>()
  const send = useCallback((action: TerminalWorkspaceAction): void => {
    modelRef.current = terminalWorkspaceReducer(modelRef.current, action)
    dispatch(action)
  }, [])
  modelRef.current = model
  const { sessions, activeId } = model
  const updateSession = useCallback(
    (id: string, update: (session: TerminalSession) => TerminalSession): void => {
      const session = modelRef.current.sessions.find((candidate) => candidate.id === id)
      if (!session) return
      const updated = update(session)
      if (updated !== session) send({ type: 'session-updated', session: updated })
    },
    [send],
  )
  const {
    reset: resetAttention,
    focusSession: focusAttentionSession,
    forgetSession: forgetAttentionSession,
    raiseAttention,
    recordInput,
    recordOutput,
  } = useTerminalAttentionController({
    idleThresholdMs,
    onUpdateSession: updateSession,
  })
  useTerminalAttentionRollup({ workspaceId, sessions, onRollup })
  const recovery = useTerminalRecovery({
    root: workspaceRoot,
    available,
    visible,
    mode: recoveryMode,
    model,
    providers,
    profiles,
    probes,
    splitLayout: restoredSplitLayout.current,
    ports: {
      acceptCatalog,
      acceptProbes: acceptRecoveryProbes,
      resetAttention,
      send,
    },
  })
  const {
    ready: recoveryReady,
    probesReady: recoveryProbesReady,
    candidates: recoveryCandidates,
    defaultProvider,
    defaultProfile,
    discard: discardRecovery,
    resume: resumeRecovery,
    rebind: rebindRecovery,
  } = recovery
  useTerminalPersistence({ root: workspaceRoot, model, ready: recoveryReady })

  useEffect(() => {
    if (!menuOpen) return
    const close = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setMenuOpen(false)
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [menuOpen])

  const focusSession = (id: string): void => {
    focusAttentionSession(id)
    send({ type: 'session-focused', id })
  }

  const addSession = (profileId: HarnessProfileId): void => {
    if (!available) return
    const profile = profiles.find((candidate) => candidate.id === profileId)
    const provider = profile
      ? providerDescriptor(providers, profile.providerId)
      : undefined
    if (!provider || !profile) return
    const riskAcknowledged = profileRiskAcknowledged(profile)
    if (!riskAcknowledged) {
      setPendingRiskProfile(profile)
      setMenuOpen(false)
      return
    }
    launchSession(profile, provider, riskAcknowledged)
  }

  const launchSession = (
    profile: HarnessProfile,
    provider: HarnessProviderDescriptor,
    riskAcknowledged: boolean,
  ): void => {
    const current = modelRef.current
    const pane = terminalWorkspaceSplit(current) ? current.activePane : 'primary'
    const session = createTerminalSession(
      crypto.randomUUID(),
      profile,
      provider,
      workspaceRoot,
      pane,
      riskAcknowledged,
      profileProbe(probes, profile)?.capabilities,
    )
    send({ type: 'session-added', session })
    setMenuOpen(false)
  }

  const splitTerminal = (): void => {
    if (!available || !defaultProvider || !defaultProfile) return
    const pane = nextTerminalSplitPane(modelRef.current)
    const session = createTerminalSession(
      crypto.randomUUID(),
      defaultProfile,
      defaultProvider,
      workspaceRoot,
      pane,
    )
    send({ type: 'session-added', session })
  }

  const moveSessionToOtherPane = (id: string): void => {
    send({ type: 'session-moved', id })
  }

  const closeSession = (id: string): void => {
    forgetAttentionSession(id)
    void window.hvir
      .invoke('terminal:forget', { root: workspaceRoot, id })
      .catch(() => undefined)
    send({ type: 'session-closed', id })
  }

  const terminalSplit = terminalWorkspaceSplit(model)
  const primaryActiveId = terminalPaneActiveId(model, 'primary')
  const secondaryActiveId = terminalPaneActiveId(model, 'secondary')

  const setTerminalPrimaryWidth = (width: number): void => {
    const deck = terminalDeckRef.current
    if (!deck) return
    const next = fitSplitPrimaryWidth(width, deck.clientWidth, 220)
    deck.style.setProperty('--terminal-primary-track', `${next}px`)
    const layout = readTerminalSplitLayout(workspaceRoot)
    const updated = { ...layout, primaryWidth: next }
    restoredSplitLayout.current = updated
    writeTerminalSplitLayout(workspaceRoot, updated)
    send({ type: 'primary-width-changed', width: next })
  }

  const resetTerminalPrimaryWidth = (): void => {
    terminalDeckRef.current?.style.removeProperty('--terminal-primary-track')
    const updated = {
      ...readTerminalSplitLayout(workspaceRoot),
      primaryWidth: undefined,
    }
    restoredSplitLayout.current = updated
    writeTerminalSplitLayout(workspaceRoot, updated)
    send({ type: 'primary-width-changed', width: undefined })
  }
  const launchMenuEntries = profiles.map((profile) => {
    const probe = profileProbe(probes, profile)
    const needsCheck =
      !profile.builtIn && (!probe?.expiresAt || probe.expiresAt <= Date.now())
    return {
      profile,
      provider: providerDescriptor(providers, profile.providerId),
      state: harnessLaunchMenuState(
        profile,
        probe,
        terminalProbeMemory.get(workspaceRoot, profile),
        pendingProbeIds.has(profile.id) || (menuOpen && needsCheck),
      ),
    }
  })
  const checkingHiddenProfiles = launchMenuEntries.some(
    ({ state }) => !state.visible && state.checking,
  )

  return (
    <>
      <TerminalDeck
        deckRef={terminalDeckRef}
        label={label}
        visible={visible}
        available={available}
        ready={recoveryReady}
        sessions={sessions}
        providers={providers}
        activeId={activeId}
        primaryActiveId={primaryActiveId}
        secondaryActiveId={secondaryActiveId}
        split={terminalSplit}
        primaryWidth={model.primaryWidth}
        terminalTheme={terminalTheme}
        workspaceRoot={workspaceRoot}
        connectionState={connectionState}
        onCreateDefault={defaultProfile ? () => addSession(defaultProfile.id) : undefined}
        onUpdateSession={updateSession}
        onInput={recordInput}
        onOutput={recordOutput}
        onBell={(id) => raiseAttention(id, 'bell')}
        onFocus={focusSession}
        onLink={(session, activation) => {
          if (activation.kind === 'file') {
            const resolved = resolveTerminalFileTarget(activation.target, workspaceRoot)
            if (resolved) onOpenPath(resolved)
            return
          }
          const url = normalizeTerminalWebTarget(activation.target)
          if (url) onOpenWebLink({ terminalId: session.id, workspaceRoot, url })
        }}
        onSetPrimaryWidth={setTerminalPrimaryWidth}
        onResetPrimaryWidth={resetTerminalPrimaryWidth}
      />
      <TerminalRail
        label={label}
        visible={visible}
        terminalTheme={effectiveTerminalTheme}
        recoveryReady={recoveryReady}
        available={available}
        menuOpen={menuOpen}
        launchMenuEntries={launchMenuEntries}
        checkingHiddenProfiles={checkingHiddenProfiles}
        split={terminalSplit}
        sessions={sessions}
        activeId={activeId}
        providers={providers}
        profiles={profiles}
        onSplit={splitTerminal}
        onOpenSettings={onOpenSettings}
        onToggleMenu={() => setMenuOpen((open) => !open)}
        onAddSession={(profile) => addSession(profile.id)}
        onAddHarness={() => {
          setMenuOpen(false)
          onAddHarness()
        }}
        onRefreshProbes={() => refreshProbes(true)}
        onOpenHarnessSettings={() => {
          setMenuOpen(false)
          onOpenHarnessSettings()
        }}
        onFocusSession={focusSession}
        onMoveSession={moveSessionToOtherPane}
        onCloseSession={closeSession}
      />
      {visible && pendingRiskProfile ? (
        <HarnessRiskDialog
          profile={pendingRiskProfile}
          provider={providerDescriptor(providers, pendingRiskProfile.providerId)}
          onCancel={() => setPendingRiskProfile(undefined)}
          onLaunch={async () => {
            const acknowledged = await window.hvir.invoke('harness:acknowledge-risk', {
              root: workspaceRoot,
              id: pendingRiskProfile.id,
              launchRevision: pendingRiskProfile.launchRevision,
            })
            acceptProfiles((current) =>
              current.map((profile) =>
                profile.id === acknowledged.id ? acknowledged : profile,
              ),
            )
            const provider = providerDescriptor(providers, acknowledged.providerId)
            if (provider) launchSession(acknowledged, provider, true)
            setPendingRiskProfile(undefined)
          }}
        />
      ) : null}
      {visible &&
      recoveryCandidates.length > 0 &&
      recoveryProbesReady &&
      defaultProvider &&
      defaultProfile ? (
        <TerminalRecoveryDialog
          sessions={recoveryCandidates}
          providers={providers}
          profiles={profiles}
          probes={probes}
          onRebind={rebindRecovery}
          onCancel={discardRecovery}
          onResume={resumeRecovery}
        />
      ) : null}
    </>
  )
}

function providerDescriptor(
  providers: readonly HarnessProviderDescriptor[],
  id: HarnessProviderId,
): HarnessProviderDescriptor | undefined {
  return providers.find((provider) => provider.id === id)
}
