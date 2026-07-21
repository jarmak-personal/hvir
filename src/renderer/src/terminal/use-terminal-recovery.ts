import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  HarnessProfile,
  HarnessProfileProbe,
  HarnessProviderDescriptor,
  HostPath,
  TerminalRecoverySession,
} from '../../../shared'
import type { TerminalRecoveryMode } from '../settings/settings'
import { EffectGeneration } from './effect-generation'
import { bareShellLaunchChoice } from './harness-launch-menu'
import { recoverableProfile } from './terminal-profile-recovery'
import {
  mergeTerminalRestorations,
  planAutomaticTerminalRecovery,
  planManualTerminalRecovery,
} from './terminal-recovery-planner'
import type { StoredTerminalSplitLayout } from './terminal-split-persistence'
import {
  createTerminalSession,
  type TerminalWorkspaceAction,
  type TerminalWorkspaceModel,
} from './terminal-workspace-model'

interface TerminalRecoveryPorts {
  readonly acceptCatalog: (
    providers: readonly HarnessProviderDescriptor[],
    profiles: readonly HarnessProfile[],
  ) => void
  readonly acceptProbes: (probes: readonly HarnessProfileProbe[]) => void
  readonly resetAttention: () => void
  readonly send: (action: TerminalWorkspaceAction) => void
}

export function useTerminalRecovery({
  root,
  available,
  visible,
  mode,
  model,
  providers,
  profiles,
  probes,
  splitLayout,
  ports,
}: {
  readonly root: HostPath
  readonly available: boolean
  readonly visible: boolean
  readonly mode: TerminalRecoveryMode
  readonly model: TerminalWorkspaceModel
  readonly providers: readonly HarnessProviderDescriptor[]
  readonly profiles: readonly HarnessProfile[]
  readonly probes: readonly HarnessProfileProbe[]
  readonly splitLayout: StoredTerminalSplitLayout
  readonly ports: TerminalRecoveryPorts
}) {
  const [ready, setReady] = useState(false)
  const [probesReady, setProbesReady] = useState(false)
  const [candidates, setCandidates] = useState<readonly TerminalRecoverySession[]>([])
  const portsRef = useRef(ports)
  const stateRef = useRef({
    root,
    available,
    visible,
    mode,
    model,
    providers,
    profiles,
    probes,
    splitLayout,
  })
  const generation = useRef(new EffectGeneration())
  const shouldCreateDefault = useRef(false)
  const recoveryRecords = useRef<readonly TerminalRecoverySession[]>([])
  portsRef.current = ports
  stateRef.current = {
    root,
    available,
    visible,
    mode,
    model,
    providers,
    profiles,
    probes,
    splitLayout,
  }

  const defaultLaunch = useMemo(
    () => bareShellLaunchChoice(providers, profiles),
    [profiles, providers],
  )

  useEffect(() => {
    const generationOwner = generation.current
    const currentGeneration = generationOwner.begin()
    shouldCreateDefault.current = false
    recoveryRecords.current = []
    portsRef.current.resetAttention()
    setReady(false)
    setProbesReady(false)
    setCandidates([])
    portsRef.current.send({
      type: 'reset',
      primaryWidth: stateRef.current.splitLayout.primaryWidth,
    })
    void Promise.all([
      window.hvir.invoke('harness:catalog', undefined),
      window.hvir.invoke('harness:profiles', { root }),
      window.hvir
        .invoke('terminal:recovery', { root })
        .catch(() => [] as readonly TerminalRecoverySession[]),
    ]).then(
      ([catalog, launchProfiles, records]) => {
        if (!generationOwner.isCurrent(currentGeneration)) return
        portsRef.current.acceptCatalog(catalog, launchProfiles)
        const launch = bareShellLaunchChoice(catalog, launchProfiles)
        if (!launch) {
          setReady(true)
          return
        }
        if (records.length === 0) {
          shouldCreateDefault.current = stateRef.current.available
          if (stateRef.current.visible && stateRef.current.available) {
            const session = createTerminalSession(
              crypto.randomUUID(),
              launch.profile,
              launch.provider,
              root,
              'primary',
            )
            shouldCreateDefault.current = false
            portsRef.current.send({
              type: 'sessions-replaced',
              sessions: [session],
              activeId: session.id,
            })
          }
          setReady(true)
          return
        }
        recoveryRecords.current = records
        setCandidates(records)
        setReady(true)
      },
      () => {
        if (generationOwner.isCurrent(currentGeneration)) setReady(true)
      },
    )
    return () => {
      // Invalidates every completion owned by this workspace generation.
      generationOwner.invalidate(currentGeneration)
    }
  }, [root])

  useEffect(() => {
    if (candidates.length === 0 || probesReady || !visible || !available) return
    const currentGeneration = generation.current.snapshot()
    const profileIds = candidates.flatMap((candidate) => {
      const profile = recoverableProfile(profiles, candidate)
      return profile?.builtIn ? [] : [candidate.profileId]
    })
    if (profileIds.length === 0) {
      setProbesReady(true)
      return
    }
    let active = true
    void window.hvir.invoke('harness:probe-profiles', { root, profileIds }).then(
      (values) => {
        if (!active || !generation.current.isCurrent(currentGeneration)) return
        portsRef.current.acceptProbes(values)
        setProbesReady(true)
      },
      () => {
        if (active && generation.current.isCurrent(currentGeneration)) {
          setProbesReady(true)
        }
      },
    )
    return () => {
      active = false
    }
  }, [available, candidates, probesReady, profiles, root, visible])

  useEffect(() => {
    if (!available || !visible || model.sessions.length > 0 || !defaultLaunch) {
      return
    }
    const plan = planAutomaticTerminalRecovery({
      records: candidates,
      providers,
      profiles,
      probes,
      splitLayout,
      mode,
      probesReady,
    })
    if (plan.kind === 'restore') {
      portsRef.current.send({
        type: 'sessions-replaced',
        sessions: plan.result.sessions,
        activeId: plan.result.activeId,
      })
      setCandidates(plan.residual)
      if (plan.residual.length === 0) recoveryRecords.current = []
      setReady(true)
      return
    }
    if (!ready || !shouldCreateDefault.current || candidates.length > 0) return
    shouldCreateDefault.current = false
    const session = createTerminalSession(
      crypto.randomUUID(),
      defaultLaunch.profile,
      defaultLaunch.provider,
      root,
      'primary',
    )
    portsRef.current.send({
      type: 'sessions-replaced',
      sessions: [session],
      activeId: session.id,
    })
  }, [
    available,
    candidates,
    defaultLaunch,
    mode,
    model.sessions.length,
    probes,
    probesReady,
    profiles,
    providers,
    ready,
    root,
    splitLayout,
    visible,
  ])

  const discard = useCallback((): void => {
    const current = stateRef.current
    if (current.model.sessions.length === 0) {
      const launch = bareShellLaunchChoice(current.providers, current.profiles)
      if (!launch) return
      const session = createTerminalSession(
        crypto.randomUUID(),
        launch.profile,
        launch.provider,
        current.root,
        'primary',
      )
      portsRef.current.send({
        type: 'sessions-replaced',
        sessions: [session],
        activeId: session.id,
      })
    }
    recoveryRecords.current = []
    setCandidates([])
    setReady(true)
  }, [])

  const resume = useCallback((ids: ReadonlySet<string>): void => {
    const current = stateRef.current
    const plan = planManualTerminalRecovery({
      selectedIds: ids,
      records: candidatesRef.current,
      providers: current.providers,
      profiles: current.profiles,
      probes: current.probes,
      splitLayout: current.splitLayout,
    })
    if (plan.kind === 'discard') {
      discardRef.current()
      return
    }
    const merged = mergeTerminalRestorations(
      {
        sessions: current.model.sessions,
        activeId: current.model.activeId,
      },
      plan.result,
      recoveryRecords.current,
    )
    portsRef.current.send({
      type: 'sessions-replaced',
      sessions: merged.sessions,
      activeId: merged.activeId,
    })
    recoveryRecords.current = []
    setCandidates([])
    setReady(true)
  }, [])

  const rebind = useCallback(
    async (record: TerminalRecoverySession, profile: HarnessProfile): Promise<void> => {
      const current = stateRef.current
      const generationOwner = generation.current
      const currentGeneration = generationOwner.snapshot()
      const rebound = await window.hvir.invoke('terminal:rebind-profile', {
        root: current.root,
        id: record.id,
        profileId: profile.id,
        launchRevision: profile.launchRevision,
        acknowledgeRisk: profile.risk !== 'standard',
      })
      if (!generationOwner.isCurrent(currentGeneration)) return
      recoveryRecords.current = recoveryRecords.current.map((candidate) =>
        candidate.id === rebound.id ? rebound : candidate,
      )
      setCandidates((values) =>
        values.map((candidate) => (candidate.id === rebound.id ? rebound : candidate)),
      )
    },
    [],
  )

  const candidatesRef = useRef(candidates)
  const discardRef = useRef(discard)
  candidatesRef.current = candidates
  discardRef.current = discard

  return {
    ready,
    probesReady,
    candidates,
    defaultProvider: defaultLaunch?.provider,
    defaultProfile: defaultLaunch?.profile,
    discard,
    resume,
    rebind,
  }
}
