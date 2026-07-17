import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'

import {
  basenameHostPath,
  type HarnessProviderDescriptor,
  type HarnessProviderCapabilities,
  type HarnessProfile,
  type HarnessProfileId,
  type HarnessProfileProbe,
  type HarnessTelemetry,
  type HostConnectionState,
  type HostPath,
  type HarnessProviderId,
  type TerminalIdentityStatus,
  type TerminalRecoverySession,
} from '../../../shared'
import {
  nextTerminalAttention,
  terminalAttentionLabel,
  terminalAttentionRollup,
  terminalIdleAttentionAfterInput,
  terminalOutputAttentionDecision,
  type TerminalAttention,
  type TerminalIdleAttentionState,
} from './terminal-attention'
import { PaneResizer } from '../layout/PaneResizer'
import type { TerminalRecoveryMode, TerminalThemeOverride } from '../settings/settings'
import { useAppTheme } from '../theme'
import {
  resolveTerminalFileTarget,
  type ResolvedTerminalFileTarget,
} from './terminal-file-link'
import { TerminalView } from './TerminalView'
import {
  autoRecoverableProfile,
  profileRiskAcknowledged,
  probeAllowsAutoRestore,
  recoverableProfile,
} from './terminal-profile-recovery'
import {
  bareShellLaunchChoice,
  compactHarnessCapabilityLabel,
  harnessLaunchMenuState,
} from './harness-launch-menu'

const LAST_KNOWN_PROBE_LIMIT = 500
const lastKnownAvailableProbes = new Map<string, HarnessProfileProbe>()

interface TerminalSession {
  readonly id: string
  readonly providerId: HarnessProviderId
  readonly profileId: HarnessProfileId
  readonly launchRevision: number
  readonly riskAcknowledged: boolean
  readonly capabilities: HarnessProviderCapabilities
  readonly fallbackTitle: string
  readonly title: string
  readonly status: string
  readonly attention?: TerminalAttention
  readonly telemetry?: HarnessTelemetry
  readonly harnessSessionId?: string
  readonly identityStatus?: TerminalIdentityStatus
  readonly resumeOnStart: boolean
  readonly pane: TerminalSplitPane
}

type TerminalSplitPane = 'primary' | 'secondary'

interface TerminalWorkspaceProps {
  readonly cwd: HostPath
  readonly workspaceId: string
  readonly connectionState: HostConnectionState
  readonly available: boolean
  readonly visible: boolean
  readonly label: string
  readonly onRollup: (workspaceId: string, rollup: TerminalWorkspaceRollup) => void
  readonly onOpenPath: (target: ResolvedTerminalFileTarget) => void
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
  const [providers, setProviders] = useState<readonly HarnessProviderDescriptor[]>([])
  const [profiles, setProfiles] = useState<readonly HarnessProfile[]>([])
  const [probes, setProbes] = useState<readonly HarnessProfileProbe[]>([])
  const [pendingProbeIds, setPendingProbeIds] = useState<ReadonlySet<HarnessProfileId>>(
    new Set(),
  )
  const [sessions, setSessions] = useState<readonly TerminalSession[]>([])
  const [activeId, setActiveId] = useState<string>()
  const [menuOpen, setMenuOpen] = useState(false)
  const [pendingRiskProfile, setPendingRiskProfile] = useState<HarnessProfile>()
  const [recoveryReady, setRecoveryReady] = useState(false)
  const [recoveryProbesReady, setRecoveryProbesReady] = useState(false)
  const [recoveryCandidates, setRecoveryCandidates] = useState<
    readonly TerminalRecoverySession[]
  >([])
  const recoveryModeRef = useRef(recoveryMode)
  const activeIdRef = useRef(activeId)
  const activePaneRef = useRef<TerminalSplitPane>('primary')
  const activeByPaneRef = useRef<Record<TerminalSplitPane, string | undefined>>({
    primary: undefined,
    secondary: undefined,
  })
  const sessionsRef = useRef(sessions)
  const appFocusedRef = useRef(document.hasFocus())
  const focusedTerminalRef = useRef<string | undefined>(undefined)
  const idleTimers = useRef(new Map<string, number>())
  const idleAttentionStates = useRef(new Map<string, TerminalIdleAttentionState>())
  const visibleRef = useRef(visible)
  const availableRef = useRef(available)
  const shouldCreateDefault = useRef(false)
  activeIdRef.current = activeId
  sessionsRef.current = sessions
  visibleRef.current = visible
  availableRef.current = available
  recoveryModeRef.current = recoveryMode
  const bareShell = bareShellLaunchChoice(providers, profiles)
  const defaultProvider = bareShell?.provider
  const defaultProfile = bareShell?.profile

  useEffect(() => {
    const timers = idleTimers.current
    const focused = (): void => {
      appFocusedRef.current = true
      focusedTerminalRef.current =
        document.activeElement instanceof Element
          ? document.activeElement.closest<HTMLElement>('[data-terminal-session]')
              ?.dataset['terminalSession']
          : undefined
    }
    const blurred = (): void => {
      appFocusedRef.current = false
      focusedTerminalRef.current = undefined
    }
    const trackFocus = (event: FocusEvent): void => {
      const terminal =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>('[data-terminal-session]')
          : null
      focusedTerminalRef.current = terminal?.dataset['terminalSession']
    }
    const trackPointer = (event: PointerEvent): void => {
      if (
        event.target instanceof Element &&
        !event.target.closest('[data-terminal-session]')
      ) {
        focusedTerminalRef.current = undefined
      }
    }
    window.addEventListener('focus', focused)
    window.addEventListener('blur', blurred)
    window.addEventListener('focusin', trackFocus)
    window.addEventListener('pointerdown', trackPointer, true)
    return () => {
      window.removeEventListener('focus', focused)
      window.removeEventListener('blur', blurred)
      window.removeEventListener('focusin', trackFocus)
      window.removeEventListener('pointerdown', trackPointer, true)
      for (const timer of timers.values()) window.clearTimeout(timer)
      timers.clear()
    }
  }, [])

  useEffect(() => {
    if (!menuOpen) return
    const close = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setMenuOpen(false)
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [menuOpen])

  useEffect(() => {
    const refreshProfiles = (): void => {
      void window.hvir
        .invoke('harness:profiles', { root: workspaceRoot })
        .then(setProfiles)
        .catch(() => undefined)
    }
    window.addEventListener('hvir:harness-profiles-changed', refreshProfiles)
    return () =>
      window.removeEventListener('hvir:harness-profiles-changed', refreshProfiles)
  }, [workspaceRoot])

  const refreshProbes = (force = false): void => {
    const now = Date.now()
    const candidates = profiles.filter((profile) => {
      if (profile.builtIn) return false
      const current = profileProbe(probes, profile)
      return force || !current?.expiresAt || current.expiresAt <= now
    })
    if (candidates.length === 0) return
    setPendingProbeIds((current) => {
      const next = new Set(current)
      for (const profile of candidates) next.add(profile.id)
      return next
    })
    for (const profile of candidates) {
      void window.hvir
        .invoke('harness:probe-profiles', {
          root: workspaceRoot,
          profileIds: [profile.id],
          force,
        })
        .then(([probe]) => {
          if (!probe) return
          setProbes((current) => mergeProbe(current, probe))
          if (probe.status === 'available') rememberAvailableProbe(workspaceRoot, probe)
        })
        .catch(() => undefined)
        .finally(() =>
          setPendingProbeIds((current) => {
            const next = new Set(current)
            next.delete(profile.id)
            return next
          }),
        )
    }
  }

  useEffect(() => {
    if (menuOpen) refreshProbes(false)
    // Probe refresh is intentionally menu-driven and never part of first paint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuOpen])

  useEffect(() => {
    if (menuOpen) refreshProbes(true)
    // Reconnect changes the main-owned cache generation. Keep last-known-good
    // rows visible while the fresh host result resolves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionState])

  useEffect(() => {
    let cancelled = false
    for (const timer of idleTimers.current.values()) window.clearTimeout(timer)
    idleTimers.current.clear()
    idleAttentionStates.current.clear()
    focusedTerminalRef.current = undefined
    setRecoveryReady(false)
    setRecoveryProbesReady(false)
    setRecoveryCandidates([])
    setProfiles([])
    setProbes([])
    setPendingProbeIds(new Set())
    setSessions([])
    setActiveId(undefined)
    activePaneRef.current = 'primary'
    activeByPaneRef.current = { primary: undefined, secondary: undefined }
    void Promise.all([
      window.hvir.invoke('harness:catalog', undefined),
      window.hvir.invoke('harness:profiles', { root: workspaceRoot }),
      window.hvir
        .invoke('terminal:recovery', { root: workspaceRoot })
        .catch(() => [] as readonly TerminalRecoverySession[]),
    ]).then(
      ([catalog, launchProfiles, candidates]) => {
        if (cancelled) return
        setProviders(catalog)
        setProfiles(launchProfiles)
        const defaultLaunch = bareShellLaunchChoice(catalog, launchProfiles)
        if (!defaultLaunch) {
          setRecoveryReady(true)
          return
        }
        if (candidates.length === 0) {
          shouldCreateDefault.current = availableRef.current
          if (visibleRef.current && availableRef.current) {
            const session = createSession(
              defaultLaunch.profile,
              defaultLaunch.provider,
              workspaceRoot,
              'primary',
            )
            shouldCreateDefault.current = false
            setSessions([session])
            setActiveId(session.id)
          }
          setRecoveryReady(true)
          return
        }
        setRecoveryCandidates(candidates)
        setRecoveryReady(true)
      },
      () => {
        if (cancelled) return
        setRecoveryReady(true)
      },
    )
    return () => {
      cancelled = true
    }
  }, [workspaceRoot])

  useEffect(() => {
    if (
      recoveryCandidates.length === 0 ||
      recoveryProbesReady ||
      !visible ||
      !available
    ) {
      return
    }
    let cancelled = false
    const profileIds = recoveryCandidates.flatMap((candidate) => {
      const profile = recoverableProfile(profiles, candidate)
      return profile?.builtIn ? [] : [candidate.profileId]
    })
    if (profileIds.length === 0) {
      setRecoveryProbesReady(true)
      return
    }
    void window.hvir
      .invoke('harness:probe-profiles', {
        root: workspaceRoot,
        profileIds,
      })
      .then(
        (values) => {
          if (cancelled) return
          setProbes(values)
          for (const probe of values) {
            if (probe.status === 'available') rememberAvailableProbe(workspaceRoot, probe)
          }
          setRecoveryProbesReady(true)
        },
        () => {
          if (!cancelled) setRecoveryProbesReady(true)
        },
      )
    return () => {
      cancelled = true
    }
  }, [
    available,
    profiles,
    recoveryCandidates,
    recoveryProbesReady,
    visible,
    workspaceRoot,
  ])

  useEffect(() => {
    if (
      !available ||
      !visible ||
      sessions.length > 0 ||
      !defaultProvider ||
      !defaultProfile
    )
      return
    if (recoveryCandidates.length > 0 && recoveryMode === 'auto' && recoveryProbesReady) {
      if (
        recoveryCandidates.some((candidate) => {
          const profile = autoRecoverableProfile(profiles, candidate)
          return (
            !providerDescriptor(providers, candidate.providerId) ||
            !profile ||
            !probeAllowsAutoRestore(probes, candidate, profile)
          )
        })
      ) {
        return
      }
      restoreSessions(
        recoveryCandidates,
        providers,
        profiles,
        probes,
        restoredSplitLayout.current,
        setSessions,
        setActiveId,
        false,
      )
      setRecoveryCandidates([])
      setRecoveryReady(true)
      return
    }
    if (!recoveryReady) return
    if (!shouldCreateDefault.current || recoveryCandidates.length > 0) return
    shouldCreateDefault.current = false
    const session = createSession(
      defaultProfile,
      defaultProvider,
      workspaceRoot,
      'primary',
    )
    setSessions([session])
    setActiveId(session.id)
  }, [
    recoveryCandidates,
    recoveryMode,
    recoveryReady,
    available,
    defaultProvider,
    defaultProfile,
    providers,
    profiles,
    probes,
    recoveryProbesReady,
    sessions.length,
    visible,
    workspaceRoot,
  ])

  const layoutKey = JSON.stringify(
    sessions.map((session, position) => ({
      id: session.id,
      title: session.title,
      position,
      active: session.id === activeId,
      pane: session.pane,
    })),
  )
  useEffect(() => {
    if (!recoveryReady) return
    const layout = sessionsRef.current.map((session, position) => ({
      id: session.id,
      title: session.title,
      position,
      active: session.id === activeIdRef.current,
    }))
    void window.hvir
      .invoke('terminal:update-layout', { root: workspaceRoot, sessions: layout })
      .catch(() => undefined)
  }, [layoutKey, recoveryReady, workspaceRoot])

  useEffect(() => {
    if (!recoveryReady) return
    writeTerminalSplitLayout(workspaceRoot, {
      ...readTerminalSplitLayout(workspaceRoot),
      secondaryIds: sessions
        .filter((session) => session.pane === 'secondary')
        .map((session) => session.id),
    })
  }, [layoutKey, recoveryReady, sessions, workspaceRoot])

  useEffect(() => {
    const active = sessions.find((session) => session.id === activeId)
    if (!active) return
    activePaneRef.current = active.pane
    activeByPaneRef.current[active.pane] = active.id
  }, [activeId, sessions])

  const attentionRollup = terminalAttentionRollup(
    sessions.map((session) => session.attention),
  )
  useEffect(() => {
    onRollup(workspaceId, {
      unseen: attentionRollup.unseen,
      actionable: attentionRollup.actionable,
    })
  }, [attentionRollup.actionable, attentionRollup.unseen, onRollup, workspaceId])
  useEffect(
    () => () => onRollup(workspaceId, { unseen: 0, actionable: 0 }),
    [onRollup, workspaceId],
  )

  const updateSession = (
    id: string,
    update: (session: TerminalSession) => TerminalSession,
  ): void => {
    setSessions((current) => {
      let changed = false
      const next = current.map((session) => {
        if (session.id !== id) return session
        const updated = update(session)
        if (updated !== session) changed = true
        return updated
      })
      return changed ? next : current
    })
  }

  const focusSession = (id: string): void => {
    const timer = idleTimers.current.get(id)
    if (timer !== undefined) window.clearTimeout(timer)
    idleTimers.current.delete(id)
    focusedTerminalRef.current = id
    const pane = sessionsRef.current.find((session) => session.id === id)?.pane
    if (pane) {
      activePaneRef.current = pane
      activeByPaneRef.current[pane] = id
    }
    setActiveId(id)
    updateSession(id, (session) =>
      session.attention ? { ...session, attention: undefined } : session,
    )
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
    const split = sessionsRef.current.some((session) => session.pane === 'secondary')
    const pane = split ? activePaneRef.current : 'primary'
    const session = createSession(
      profile,
      provider,
      workspaceRoot,
      pane,
      riskAcknowledged,
      profileProbe(probes, profile)?.capabilities,
    )
    setSessions((current) => [...current, session])
    activeByPaneRef.current[pane] = session.id
    setActiveId(session.id)
    setMenuOpen(false)
  }

  const splitTerminal = (): void => {
    if (!available || !defaultProvider || !defaultProfile) return
    const split = sessionsRef.current.some((session) => session.pane === 'secondary')
    const pane: TerminalSplitPane = split
      ? activePaneRef.current === 'primary'
        ? 'secondary'
        : 'primary'
      : 'secondary'
    const session = createSession(defaultProfile, defaultProvider, workspaceRoot, pane)
    activePaneRef.current = pane
    activeByPaneRef.current[pane] = session.id
    setSessions((current) => [...current, session])
    setActiveId(session.id)
  }

  const moveSessionToOtherPane = (id: string): void => {
    const session = sessionsRef.current.find((candidate) => candidate.id === id)
    if (!session) return
    const pane: TerminalSplitPane = session.pane === 'primary' ? 'secondary' : 'primary'
    if (activeByPaneRef.current[session.pane] === id) {
      activeByPaneRef.current[session.pane] = sessionsRef.current.find(
        (candidate) => candidate.pane === session.pane && candidate.id !== id,
      )?.id
    }
    activeByPaneRef.current[pane] = id
    activePaneRef.current = pane
    setSessions((current) =>
      current.map((candidate) =>
        candidate.id === id ? { ...candidate, pane } : candidate,
      ),
    )
    setActiveId(id)
  }

  const closeSession = (id: string): void => {
    const timer = idleTimers.current.get(id)
    if (timer !== undefined) window.clearTimeout(timer)
    idleTimers.current.delete(id)
    idleAttentionStates.current.delete(id)
    void window.hvir
      .invoke('terminal:forget', { root: workspaceRoot, id })
      .catch(() => undefined)
    setSessions((current) => {
      const index = current.findIndex((session) => session.id === id)
      const pane = current[index]?.pane ?? 'primary'
      const next = current.filter((session) => session.id !== id)
      const nextInPane =
        next.slice(index).find((session) => session.pane === pane) ??
        [...next].reverse().find((session) => session.pane === pane)
      if (activeByPaneRef.current[pane] === id) {
        activeByPaneRef.current[pane] = nextInPane?.id
      }
      if (activeIdRef.current === id) {
        const nextActive = nextInPane ?? next[Math.min(index, next.length - 1)]
        if (nextActive) {
          activePaneRef.current = nextActive.pane
          activeByPaneRef.current[nextActive.pane] = nextActive.id
        }
        setActiveId(nextActive?.id)
      }
      return next
    })
  }

  const raiseAttention = (id: string, attention: TerminalAttention): void => {
    const focused = focusedTerminalRef.current === id && appFocusedRef.current
    updateSession(id, (session) => {
      const nextAttention = nextTerminalAttention(session.attention, attention, focused)
      return nextAttention === session.attention
        ? session
        : { ...session, attention: nextAttention }
    })
  }

  const recordInput = (id: string, data: string): void => {
    const current = idleAttentionStates.current.get(id) ?? 'initial'
    idleAttentionStates.current.set(id, terminalIdleAttentionAfterInput(current, data))
  }

  const recordOutput = (id: string): void => {
    const focused = focusedTerminalRef.current === id && appFocusedRef.current
    const existing = idleTimers.current.get(id)
    if (existing !== undefined) window.clearTimeout(existing)
    idleTimers.current.delete(id)
    const decision = terminalOutputAttentionDecision(
      idleAttentionStates.current.get(id) ?? 'initial',
    )
    if (!decision.notify) return
    if (focused) {
      return
    }
    raiseAttention(id, 'output')
    if (!decision.scheduleIdle) return
    idleTimers.current.set(
      id,
      window.setTimeout(() => {
        idleTimers.current.delete(id)
        idleAttentionStates.current.set(id, 'settled')
        if (focusedTerminalRef.current !== id || !appFocusedRef.current) {
          raiseAttention(id, 'idle')
        }
      }, idleThresholdMs),
    )
  }

  const terminalSplit = sessions.some((session) => session.pane === 'secondary')
  const primaryActiveId =
    sessions.find(
      (session) =>
        session.pane === 'primary' && session.id === activeByPaneRef.current.primary,
    )?.id ?? sessions.find((session) => session.pane === 'primary')?.id
  const secondaryActiveId =
    sessions.find(
      (session) =>
        session.pane === 'secondary' && session.id === activeByPaneRef.current.secondary,
    )?.id ?? sessions.find((session) => session.pane === 'secondary')?.id
  activeByPaneRef.current.primary = primaryActiveId
  activeByPaneRef.current.secondary = secondaryActiveId

  const setTerminalPrimaryWidth = (width: number): void => {
    const deck = terminalDeckRef.current
    if (!deck) return
    const next = Math.min(Math.max(220, width), Math.max(220, deck.clientWidth - 225))
    deck.style.setProperty('--terminal-primary-track', `${next}px`)
    const layout = readTerminalSplitLayout(workspaceRoot)
    const updated = { ...layout, primaryWidth: next }
    restoredSplitLayout.current = updated
    writeTerminalSplitLayout(workspaceRoot, updated)
  }

  const initialDeckStyle = restoredSplitLayout.current.primaryWidth
    ? ({
        '--terminal-primary-track': `${restoredSplitLayout.current.primaryWidth}px`,
      } as CSSProperties)
    : undefined
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
        lastKnownAvailableProbe(workspaceRoot, profile),
        pendingProbeIds.has(profile.id) || (menuOpen && needsCheck),
      ),
    }
  })
  const checkingHiddenProfiles = launchMenuEntries.some(
    ({ state }) => !state.visible && state.checking,
  )

  return (
    <>
      <div
        className={`terminal-deck${terminalSplit ? ' split' : ''}`}
        ref={terminalDeckRef}
        style={initialDeckStyle}
        aria-label={`${label} terminal workspace`}
        hidden={!visible}
      >
        {recoveryReady && sessions.length === 0 ? (
          <div className="terminal-empty">
            {available && defaultProfile ? (
              <button type="button" onClick={() => addSession(defaultProfile.id)}>
                New terminal
              </button>
            ) : (
              <span>No retained terminals</span>
            )}
          </div>
        ) : null}
        {sessions.map((session, position) => {
          const provider = providerDescriptor(providers, session.providerId)
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
              themeOverride={terminalTheme}
              cwd={workspaceRoot}
              connectionState={connectionState}
              onTitle={(title) =>
                updateSession(session.id, (current) => ({ ...current, title }))
              }
              onStatus={(status) =>
                updateSession(session.id, (current) => ({ ...current, status }))
              }
              onTelemetry={(telemetry) =>
                updateSession(session.id, (current) =>
                  current.telemetry === telemetry ? current : { ...current, telemetry },
                )
              }
              onIdentity={(harnessSessionId, identityStatus) =>
                updateSession(session.id, (current) => ({
                  ...current,
                  harnessSessionId: harnessSessionId ?? current.harnessSessionId,
                  identityStatus,
                }))
              }
              onStarted={() =>
                updateSession(session.id, (current) =>
                  current.resumeOnStart ? { ...current, resumeOnStart: false } : current,
                )
              }
              onCapabilities={(capabilities) =>
                updateSession(session.id, (current) =>
                  current.capabilities === capabilities
                    ? current
                    : { ...current, capabilities },
                )
              }
              onInput={(data) => recordInput(session.id, data)}
              onOutput={() => recordOutput(session.id)}
              onBell={() => raiseAttention(session.id, 'bell')}
              onFocus={() => focusSession(session.id)}
              onLink={(target) => {
                const resolved = resolveTerminalFileTarget(target, workspaceRoot)
                if (resolved) onOpenPath(resolved)
              }}
            />
          )
        })}
        {terminalSplit ? (
          <PaneResizer
            orientation="vertical"
            className="terminal-split-resizer"
            label="Resize split terminals"
            onDrag={(clientX) => {
              const left = terminalDeckRef.current?.getBoundingClientRect().left ?? 0
              setTerminalPrimaryWidth(clientX - left)
            }}
            onNudge={(delta) => {
              const primary = terminalDeckRef.current?.querySelector<HTMLElement>(
                '[data-terminal-slot="primary"].visible',
              )
              if (primary) {
                setTerminalPrimaryWidth(primary.getBoundingClientRect().width + delta)
              }
            }}
            onReset={() => {
              terminalDeckRef.current?.style.removeProperty('--terminal-primary-track')
              const layout = readTerminalSplitLayout(workspaceRoot)
              const updated = {
                ...layout,
                primaryWidth: undefined,
              }
              restoredSplitLayout.current = updated
              writeTerminalSplitLayout(workspaceRoot, updated)
            }}
          />
        ) : null}
      </div>
      <aside
        className="terminal-rail"
        aria-label={`Open terminals in ${label}`}
        data-terminal-theme={effectiveTerminalTheme}
        hidden={!visible}
      >
        <header className="terminal-rail-header">
          <span>Terminals</span>
          <div className="terminal-header-actions">
            <button
              type="button"
              className="terminal-icon-button terminal-split-button"
              aria-label="Split terminal"
              title="Open a shell in the other terminal split"
              disabled={!recoveryReady || !available}
              onClick={splitTerminal}
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
                onClick={() => {
                  setMenuOpen((open) => !open)
                }}
              >
                +
              </button>
              {menuOpen ? (
                <div className="terminal-new-menu" role="menu">
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
                        onClick={() => addSession(profile.id)}
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
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false)
                        onAddHarness()
                      }}
                    >
                      Add a harness…
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => refreshProbes(true)}
                    >
                      Refresh availability
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false)
                        onOpenHarnessSettings()
                      }}
                    >
                      Configure harnesses…
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </header>
        <div className="terminal-list" role="list">
          {sessions.map((session) => (
            <div
              key={session.id}
              className={`terminal-list-row${session.id === activeId ? ' active' : ''}`}
              role="listitem"
            >
              <button
                type="button"
                className="terminal-list-main"
                data-terminal-session={session.id}
                onClick={() => focusSession(session.id)}
              >
                <span className="terminal-list-copy">
                  <span className="terminal-list-title">{session.title}</span>
                  <span className="terminal-list-meta">
                    {profileDisplayName(profiles, session.profileId)} ·{' '}
                    {providerDescriptor(providers, session.providerId)?.displayName ??
                      session.providerId}
                    {profileRiskMarker(profiles, session.profileId)} · {session.status}
                    {identityLabel(session.identityStatus)}
                  </span>
                  {providerDescriptor(providers, session.providerId)?.capabilities
                    .contextPresentation === 'count' ||
                  providerDescriptor(providers, session.providerId)?.capabilities
                    .contextPresentation === 'pressure' ? (
                    <ContextMeter
                      telemetry={session.telemetry}
                      countOnly={
                        providerDescriptor(providers, session.providerId)?.capabilities
                          .contextPresentation === 'count'
                      }
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
              {terminalSplit ? (
                <button
                  type="button"
                  className="terminal-move-button"
                  aria-label={`Move ${session.title} to ${session.pane === 'primary' ? 'right' : 'left'} split`}
                  title={`Move to ${session.pane === 'primary' ? 'right' : 'left'} split`}
                  onClick={() => moveSessionToOtherPane(session.id)}
                >
                  {session.pane === 'primary' ? '→' : '←'}
                </button>
              ) : null}
              <button
                type="button"
                className="terminal-close-button"
                aria-label={`Close ${session.title}`}
                title="Close terminal"
                onClick={() => closeSession(session.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </aside>
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
            setProfiles((current) =>
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
          onRebind={async (record, profile) => {
            const rebound = await window.hvir.invoke('terminal:rebind-profile', {
              root: workspaceRoot,
              id: record.id,
              profileId: profile.id,
              launchRevision: profile.launchRevision,
              acknowledgeRisk: profile.risk !== 'standard',
            })
            setRecoveryCandidates((current) =>
              current.map((candidate) =>
                candidate.id === rebound.id ? rebound : candidate,
              ),
            )
          }}
          onCancel={() => {
            const session = createSession(
              defaultProfile,
              defaultProvider,
              workspaceRoot,
              'primary',
            )
            setSessions([session])
            setActiveId(session.id)
            setRecoveryCandidates([])
            setRecoveryReady(true)
          }}
          onResume={(ids) => {
            const selected = recoveryCandidates.filter(
              (session) =>
                ids.has(session.id) &&
                providerDescriptor(providers, session.providerId) !== undefined &&
                recoverableProfile(profiles, session) !== undefined,
            )
            if (selected.length > 0) {
              restoreSessions(
                selected,
                providers,
                profiles,
                probes,
                restoredSplitLayout.current,
                setSessions,
                setActiveId,
                true,
              )
            } else {
              const session = createSession(
                defaultProfile,
                defaultProvider,
                workspaceRoot,
                'primary',
              )
              setSessions([session])
              setActiveId(session.id)
            }
            setRecoveryCandidates([])
            setRecoveryReady(true)
          }}
        />
      ) : null}
    </>
  )
}

function HarnessRiskDialog({
  profile,
  provider,
  onCancel,
  onLaunch,
}: {
  readonly profile: HarnessProfile
  readonly provider?: HarnessProviderDescriptor
  readonly onCancel: () => void
  readonly onLaunch: () => Promise<void>
}): ReactElement {
  const dialogRef = useRef<HTMLElement>(null)
  const onCancelRef = useRef(onCancel)
  const busyRef = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  onCancelRef.current = onCancel

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => dialogRef.current?.focus())
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (busyRef.current) return
        onCancelRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled)',
      )
      if (!focusable || focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === dialogRef.current)
      ) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    window.addEventListener('keydown', keydown)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', keydown)
    }
  }, [])

  return (
    <div className="modal-backdrop">
      <section
        className="project-dialog harness-risk-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="harness-risk-title"
        tabIndex={-1}
      >
        <h2 id="harness-risk-title">
          {profile.risk === 'elevated'
            ? 'Elevated harness profile'
            : 'Unclassified harness profile'}
        </h2>
        <p>
          <strong>
            {provider?.displayName ?? profile.providerId} · {profile.displayName}
          </strong>
        </p>
        <p>
          {profile.risk === 'elevated'
            ? 'This profile includes a provider-known permission or sandbox bypass.'
            : 'hvir cannot confidently classify every executable, argument, or environment setting in this profile.'}
        </p>
        <small>
          Acknowledgment applies only to launch revision {profile.launchRevision}. Risk
          classification is best-effort, not a security boundary.
        </small>
        {error ? <p className="dialog-error">{error}</p> : null}
        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              busyRef.current = true
              setBusy(true)
              setError(undefined)
              void onLaunch()
                .catch((reason: unknown) => setError(message(reason)))
                .finally(() => {
                  busyRef.current = false
                  setBusy(false)
                })
            }}
          >
            Acknowledge and launch
          </button>
        </div>
      </section>
    </div>
  )
}

function TerminalRecoveryDialog({
  sessions,
  providers,
  profiles,
  probes,
  onCancel,
  onResume,
  onRebind,
}: {
  readonly sessions: readonly TerminalRecoverySession[]
  readonly providers: readonly HarnessProviderDescriptor[]
  readonly profiles: readonly HarnessProfile[]
  readonly probes: readonly HarnessProfileProbe[]
  readonly onCancel: () => void
  readonly onResume: (ids: ReadonlySet<string>) => void
  readonly onRebind: (
    record: TerminalRecoverySession,
    profile: HarnessProfile,
  ) => Promise<void>
}): ReactElement {
  const dialogRef = useRef<HTMLElement>(null)
  const onCancelRef = useRef(onCancel)
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        sessions
          .filter(
            (session) =>
              providerDescriptor(providers, session.providerId) !== undefined &&
              recoverableProfile(profiles, session) !== undefined &&
              !probeLaunchUnavailable(recoveryProbe(probes, session)),
          )
          .map((session) => session.id),
      ),
  )
  const [rebind, setRebind] = useState<Readonly<Record<string, HarnessProfileId>>>({})
  const [error, setError] = useState<string>()
  onCancelRef.current = onCancel

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => dialogRef.current?.focus())
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancelRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled)',
      )
      if (!focusable || focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === dialogRef.current)
      ) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    window.addEventListener('keydown', keydown)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', keydown)
    }
  }, [])

  return (
    <div className="modal-backdrop">
      <section
        className="project-dialog terminal-recovery-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="terminal-recovery-title"
        tabIndex={-1}
      >
        <h2 id="terminal-recovery-title">Restore terminals</h2>
        <div className="terminal-recovery-list">
          {sessions.map((session) => {
            const provider = providerDescriptor(providers, session.providerId)
            const profile = recoverableProfile(profiles, session)
            const probe = recoveryProbe(probes, session)
            const sameProviderProfiles = profiles.filter(
              (candidate) => candidate.providerId === session.providerId,
            )
            const selectedRebindProfile = sameProviderProfiles.find(
              (candidate) =>
                candidate.id === (rebind[session.id] ?? sameProviderProfiles[0]?.id),
            )
            return (
              <div key={session.id} className="terminal-recovery-option">
                <input
                  type="checkbox"
                  aria-label={`Restore ${session.title}`}
                  disabled={!provider || !profile || probeLaunchUnavailable(probe)}
                  checked={selected.has(session.id)}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked
                    setSelected((current) => {
                      const next = new Set(current)
                      if (checked) next.add(session.id)
                      else next.delete(session.id)
                      return next
                    })
                  }}
                />
                <span>
                  <strong>{session.title}</strong>
                  <small>
                    {profile?.displayName ??
                      provider?.displayName ??
                      `Unavailable provider (${session.providerId})`}{' '}
                    · {basenameHostPath(session.cwd)} ·{' '}
                    {provider && profile
                      ? `${profile.builtIn ? 'New shell' : `${restoreActionLabel(session, probe?.capabilities ?? provider.capabilities)} · ${probeLabel(probe)}`}${profile.risk === 'standard' ? '' : ` · acknowledge ${riskLabel(profile.risk)}`}`
                      : recoveryIssue(session, provider, profiles)}
                  </small>
                  {provider && !profile && sameProviderProfiles.length > 0 ? (
                    <span className="terminal-recovery-rebind">
                      <select
                        aria-label={`Rebind ${session.title} profile`}
                        value={rebind[session.id] ?? sameProviderProfiles[0]?.id}
                        onChange={(event) =>
                          setRebind((current) => ({
                            ...current,
                            [session.id]: event.currentTarget.value as HarnessProfileId,
                          }))
                        }
                      >
                        {sameProviderProfiles.map((candidate) => (
                          <option key={candidate.id} value={candidate.id}>
                            {candidate.displayName}
                            {candidate.risk === 'standard'
                              ? ''
                              : ` · ${riskLabel(candidate.risk)}`}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => {
                          if (!selectedRebindProfile) return
                          void onRebind(session, selectedRebindProfile).catch(
                            (reason: unknown) => setError(message(reason)),
                          )
                        }}
                      >
                        {selectedRebindProfile?.risk === 'standard' ||
                        !selectedRebindProfile
                          ? 'Review and rebind'
                          : `Rebind and acknowledge ${riskLabel(selectedRebindProfile.risk)}`}
                      </button>
                    </span>
                  ) : null}
                </span>
              </div>
            )
          })}
        </div>
        {error ? <p className="dialog-error">{error}</p> : null}
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            Not now
          </button>
          <button
            type="button"
            disabled={selected.size === 0}
            onClick={() => onResume(selected)}
          >
            Restore selected
          </button>
        </div>
      </section>
    </div>
  )
}

function ContextMeter({
  telemetry,
  countOnly = false,
}: {
  readonly telemetry?: HarnessTelemetry
  readonly countOnly?: boolean
}): ReactElement {
  const contextFacet = telemetry?.facets.context
  const context =
    contextFacet?.status === 'available' || contextFacet?.status === 'stale'
      ? contextFacet.value
      : undefined
  const reportedPercent = countOnly ? undefined : context?.usedPercent
  const percent =
    typeof reportedPercent === 'number' && Number.isFinite(reportedPercent)
      ? Math.min(100, Math.max(0, reportedPercent))
      : undefined
  const displayPercent = percent === undefined ? undefined : Math.floor(percent)
  const hasCountOnly = context !== undefined && displayPercent === undefined
  const pressure = hasCountOnly
    ? 'count-only'
    : displayPercent === undefined
      ? 'unknown'
      : displayPercent >= 70
        ? 'critical'
        : displayPercent >= 40
          ? 'warning'
          : 'normal'
  const label =
    context && context.windowTokens !== undefined
      ? `${formatTokenCount(context.usedTokens)} / ${formatTokenCount(context.windowTokens)} context used`
      : context
        ? `${formatTokenCount(context.usedTokens)} current context tokens; limit unavailable`
        : 'Context usage unavailable'

  return (
    <span
      className={`terminal-context ${pressure}${countOnly ? ' count-display' : ''}`}
      title={label}
    >
      {!countOnly ? (
        displayPercent === undefined ? (
          <span className="terminal-context-track" aria-hidden="true" />
        ) : (
          <span
            className="terminal-context-track"
            role="progressbar"
            aria-label="Context used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={displayPercent}
            aria-valuetext={label}
          >
            <span className="terminal-context-fill" style={{ width: `${percent}%` }} />
          </span>
        )
      ) : null}
      <span className="terminal-context-value">
        {hasCountOnly
          ? formatTokenCount(context.usedTokens)
          : displayPercent === undefined
            ? '--'
            : `${displayPercent}%`}
      </span>
    </span>
  )
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${trimFraction(value / 1_000_000)}m`
  if (value >= 1_000) return `${trimFraction(value / 1_000)}k`
  return String(Math.round(value))
}

function trimFraction(value: number): string {
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '')
}

function identityLabel(status: TerminalIdentityStatus | undefined): string {
  if (status === 'discovering') return ' · resume pending'
  if (status === 'ambiguous' || status === 'unavailable') {
    return ' · resume unavailable'
  }
  return ''
}

function restoreActionLabel(
  session: TerminalRecoverySession,
  capabilities: HarnessProviderCapabilities,
): string {
  return capabilities.exactResume && session.harnessSessionId ? 'Resume' : 'New session'
}

function createSession(
  profile: HarnessProfile,
  provider: HarnessProviderDescriptor,
  cwd: HostPath,
  pane: TerminalSplitPane,
  riskAcknowledged = false,
  capabilities: HarnessProviderCapabilities = provider.capabilities,
): TerminalSession {
  const fallbackTitle = `${provider.displayName} · ${basenameHostPath(cwd)}`
  return {
    id: crypto.randomUUID(),
    providerId: provider.id,
    profileId: profile.id,
    launchRevision: profile.launchRevision,
    riskAcknowledged: profileRiskAcknowledged(profile) || riskAcknowledged,
    capabilities,
    fallbackTitle,
    title: fallbackTitle,
    status: 'Starting…',
    resumeOnStart: false,
    pane,
  }
}

function restoreSessions(
  records: readonly TerminalRecoverySession[],
  providers: readonly HarnessProviderDescriptor[],
  profiles: readonly HarnessProfile[],
  probes: readonly HarnessProfileProbe[],
  splitLayout: StoredTerminalSplitLayout,
  setSessions: (sessions: readonly TerminalSession[]) => void,
  setActiveId: (id: string | undefined) => void,
  manualRiskAcknowledgment: boolean,
): void {
  const ordered = [...records].sort(
    (left, right) => left.position - right.position || left.updatedAt - right.updatedAt,
  )
  const sessions = ordered.flatMap<TerminalSession>((record) => {
    const provider = providerDescriptor(providers, record.providerId)
    const profile = recoverableProfile(profiles, record)
    if (!provider || !profile) return []
    const capabilities =
      profileProbe(probes, profile)?.capabilities ?? provider.capabilities
    const resumable = capabilities.exactResume && Boolean(record.harnessSessionId)
    const hasHarnessIdentity = capabilities.sessionIdentity !== 'none'
    return {
      id: record.id,
      providerId: record.providerId,
      profileId: record.profileId,
      launchRevision: record.launchRevision,
      riskAcknowledged:
        profile.risk === 'standard' ||
        record.riskAcknowledgedRevision === record.launchRevision ||
        manualRiskAcknowledgment,
      capabilities,
      fallbackTitle: record.title,
      title: record.title,
      status: !hasHarnessIdentity
        ? 'Ready to restore'
        : resumable
          ? 'Ready to resume'
          : 'Ready to restart',
      harnessSessionId: record.harnessSessionId,
      identityStatus: !hasHarnessIdentity
        ? 'none'
        : resumable
          ? 'identified'
          : 'unavailable',
      resumeOnStart: resumable,
      pane: splitLayout.secondaryIds.includes(record.id) ? 'secondary' : 'primary',
    }
  })
  setSessions(sessions)
  setActiveId(
    ordered.find((record) => record.active && sessions.some(({ id }) => id === record.id))
      ?.id ?? sessions[0]?.id,
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
  id: HarnessProfileId,
): string {
  return profiles.find((profile) => profile.id === id)?.displayName ?? `Missing (${id})`
}

function profileRiskMarker(
  profiles: readonly HarnessProfile[],
  id: HarnessProfileId,
): string {
  const risk = profiles.find((profile) => profile.id === id)?.risk
  return risk && risk !== 'standard' ? ` · ${riskLabel(risk)}` : ''
}

function riskLabel(risk: HarnessProfile['risk']): string {
  return risk === 'elevated'
    ? 'Elevated'
    : risk === 'unclassified'
      ? 'Unclassified'
      : 'Standard'
}

function profileProbe(
  probes: readonly HarnessProfileProbe[],
  profile: HarnessProfile,
): HarnessProfileProbe | undefined {
  return probes.find(
    (probe) =>
      probe.profileId === profile.id && probe.launchRevision === profile.launchRevision,
  )
}

function recoveryProbe(
  probes: readonly HarnessProfileProbe[],
  session: TerminalRecoverySession,
): HarnessProfileProbe | undefined {
  return probes.find(
    (probe) =>
      probe.providerId === session.providerId &&
      probe.profileId === session.profileId &&
      probe.launchRevision === session.launchRevision,
  )
}

function probeLaunchUnavailable(probe: HarnessProfileProbe | undefined): boolean {
  return (
    probe?.status === 'executable-missing' ||
    probe?.status === 'version-unsupported' ||
    probe?.status === 'disconnected'
  )
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

function recoveryIssue(
  session: TerminalRecoverySession,
  provider: HarnessProviderDescriptor | undefined,
  profiles: readonly HarnessProfile[],
): string {
  if (!provider) return `Provider '${session.providerId}' is missing`
  const current = profiles.find((profile) => profile.id === session.profileId)
  if (!current) return `Profile '${session.profileId}' is missing`
  if (current.providerId !== session.providerId) return 'Profile provider changed'
  if (current.launchRevision !== session.launchRevision) {
    return `Launch revision changed (${session.launchRevision} → ${current.launchRevision})`
  }
  return 'Cannot restore'
}

function mergeProbe(
  probes: readonly HarnessProfileProbe[],
  next: HarnessProfileProbe,
): readonly HarnessProfileProbe[] {
  return [
    ...probes.filter(
      (probe) =>
        probe.profileId !== next.profileId ||
        probe.launchRevision !== next.launchRevision ||
        probe.hostId !== next.hostId,
    ),
    next,
  ]
}

function probeMemoryKey(
  root: HostPath,
  profile: Pick<HarnessProfile, 'id' | 'launchRevision'>,
): string {
  return JSON.stringify([root.hostId, root.path, profile.id, profile.launchRevision])
}

function rememberAvailableProbe(root: HostPath, probe: HarnessProfileProbe): void {
  const key = probeMemoryKey(root, {
    id: probe.profileId,
    launchRevision: probe.launchRevision,
  })
  lastKnownAvailableProbes.delete(key)
  lastKnownAvailableProbes.set(key, probe)
  while (lastKnownAvailableProbes.size > LAST_KNOWN_PROBE_LIMIT) {
    const oldest = lastKnownAvailableProbes.keys().next().value
    if (oldest === undefined) break
    lastKnownAvailableProbes.delete(oldest)
  }
}

function lastKnownAvailableProbe(
  root: HostPath,
  profile: HarnessProfile,
): HarnessProfileProbe | undefined {
  return lastKnownAvailableProbes.get(probeMemoryKey(root, profile))
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

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

interface StoredTerminalSplitLayout {
  readonly secondaryIds: readonly string[]
  readonly primaryWidth?: number
}

function readTerminalSplitLayout(root: HostPath): StoredTerminalSplitLayout {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(terminalSplitStorageKey(root)) ?? 'null',
    )
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { secondaryIds: [] }
    }
    const record = value as Record<string, unknown>
    const ids = record['secondaryIds']
    const primaryWidth = record['primaryWidth']
    return {
      secondaryIds: Array.isArray(ids)
        ? ids
            .filter((id): id is string => typeof id === 'string' && id.length <= 80)
            .slice(0, 500)
        : [],
      primaryWidth:
        typeof primaryWidth === 'number' && Number.isFinite(primaryWidth)
          ? primaryWidth
          : undefined,
    }
  } catch {
    return { secondaryIds: [] }
  }
}

function writeTerminalSplitLayout(
  root: HostPath,
  layout: StoredTerminalSplitLayout,
): void {
  try {
    localStorage.setItem(terminalSplitStorageKey(root), JSON.stringify(layout))
  } catch {
    // Split recovery is best effort and never changes the live PTY layout.
  }
}

function terminalSplitStorageKey(root: HostPath): string {
  return `hvir:terminal-split:${root.hostId}:${root.path}`
}
