import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  HarnessProfile,
  HarnessProfileId,
  HarnessProfileProbe,
  HarnessProviderDescriptor,
  HostConnectionState,
  HostPath,
} from '../../../shared'
import {
  mergeTerminalProbe,
  terminalProbeRefreshCandidates,
} from './terminal-probe-policy'
import { EffectGeneration } from './effect-generation'

export function useTerminalProfiles({
  root,
  connectionState,
  menuOpen,
}: {
  readonly root: HostPath
  readonly connectionState: HostConnectionState
  readonly menuOpen: boolean
}) {
  const [providers, setProviders] = useState<readonly HarnessProviderDescriptor[]>([])
  const [profiles, setProfiles] = useState<readonly HarnessProfile[]>([])
  const [probes, setProbes] = useState<readonly HarnessProfileProbe[]>([])
  const [pendingProbeIds, setPendingProbeIds] = useState<ReadonlySet<HarnessProfileId>>(
    new Set(),
  )
  const profilesRef = useRef(profiles)
  const probesRef = useRef(probes)
  const pendingProbeIdsRef = useRef(pendingProbeIds)
  const connectionStateRef = useRef(connectionState)
  const generation = useRef(new EffectGeneration())
  const probeGeneration = useRef(new EffectGeneration())
  profilesRef.current = profiles
  probesRef.current = probes
  pendingProbeIdsRef.current = pendingProbeIds

  useEffect(() => {
    generation.current.begin()
    probeGeneration.current.begin()
    setProviders([])
    setProfiles([])
    setProbes([])
    setPendingProbeIds(new Set())
  }, [root])

  useEffect(() => {
    const refreshProfiles = (): void => {
      const requestedGeneration = generation.current.snapshot()
      void window.hvir
        .invoke('harness:profiles', { root })
        .then((next) => {
          if (generation.current.isCurrent(requestedGeneration)) setProfiles(next)
        })
        .catch(() => undefined)
    }
    window.addEventListener('hvir:harness-profiles-changed', refreshProfiles)
    return () =>
      window.removeEventListener('hvir:harness-profiles-changed', refreshProfiles)
  }, [root])

  const refreshProbes = useCallback(
    (force = false): void => {
      const candidates = terminalProbeRefreshCandidates(
        profilesRef.current,
        probesRef.current,
        Date.now(),
        force,
      )
      if (candidates.length === 0) return
      const requestedGeneration = probeGeneration.current.begin()
      setPendingProbeIds((current) => {
        const next = new Set(current)
        for (const profile of candidates) next.add(profile.id)
        return next
      })
      for (const profile of candidates) {
        void window.hvir
          .invoke('harness:probe-profiles', {
            root,
            profileIds: [profile.id],
            force,
          })
          .then(([probe]) => {
            if (!probe || !probeGeneration.current.isCurrent(requestedGeneration)) return
            setProbes((current) => mergeTerminalProbe(current, probe))
          })
          .catch(() => undefined)
          .finally(() => {
            if (!probeGeneration.current.isCurrent(requestedGeneration)) return
            setPendingProbeIds((current) => {
              const next = new Set(current)
              next.delete(profile.id)
              return next
            })
          })
      }
    },
    [root],
  )

  const refreshProbeSnapshot = useCallback((): void => {
    if (pendingProbeIdsRef.current.size > 0) return
    const requestedGeneration = probeGeneration.current.snapshot()
    void window.hvir
      .invoke('harness:probe-snapshot', { root })
      .then((snapshot) => {
        if (probeGeneration.current.isCurrent(requestedGeneration)) setProbes(snapshot)
      })
      .catch(() => undefined)
  }, [root])

  useEffect(() => {
    if (menuOpen) refreshProbeSnapshot()
  }, [menuOpen, refreshProbeSnapshot])
  useEffect(() => {
    if (connectionStateRef.current === connectionState) return
    connectionStateRef.current = connectionState
    probeGeneration.current.begin()
    setProbes([])
    setPendingProbeIds(new Set())
  }, [connectionState])

  const acceptCatalog = useCallback(
    (
      nextProviders: readonly HarnessProviderDescriptor[],
      nextProfiles: readonly HarnessProfile[],
    ): void => {
      setProviders(nextProviders)
      setProfiles(nextProfiles)
    },
    [],
  )
  const acceptProfiles = useCallback(
    (update: (current: readonly HarnessProfile[]) => readonly HarnessProfile[]): void =>
      setProfiles(update),
    [],
  )
  const acceptRecoveryProbes = useCallback(
    (values: readonly HarnessProfileProbe[]): void => setProbes(values),
    [],
  )

  return {
    providers,
    profiles,
    probes,
    pendingProbeIds,
    acceptCatalog,
    acceptProfiles,
    acceptRecoveryProbes,
    refreshProbes,
  }
}
