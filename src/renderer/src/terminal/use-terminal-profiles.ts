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
  terminalProbeMemory,
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
  const menuOpenRef = useRef(menuOpen)
  const generation = useRef(new EffectGeneration())
  profilesRef.current = profiles
  probesRef.current = probes
  menuOpenRef.current = menuOpen

  useEffect(() => {
    generation.current.begin()
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
      const requestedGeneration = generation.current.snapshot()
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
            if (!probe || !generation.current.isCurrent(requestedGeneration)) return
            terminalProbeMemory.remember(root, probe)
            setProbes((current) => mergeTerminalProbe(current, probe))
          })
          .catch(() => undefined)
          .finally(() => {
            if (!generation.current.isCurrent(requestedGeneration)) return
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

  useEffect(() => {
    if (menuOpen) refreshProbes(false)
  }, [menuOpen, refreshProbes])
  useEffect(() => {
    if (menuOpenRef.current) refreshProbes(true)
  }, [connectionState, refreshProbes])

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
    (values: readonly HarnessProfileProbe[]): void => {
      for (const probe of values) terminalProbeMemory.remember(root, probe)
      setProbes(values)
    },
    [root],
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
