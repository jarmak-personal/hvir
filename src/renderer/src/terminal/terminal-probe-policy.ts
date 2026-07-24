import type {
  HarnessProfile,
  HarnessProfileProbe,
  TerminalRecoverySession,
} from '../../../shared'

export function profileProbe(
  probes: readonly HarnessProfileProbe[],
  profile: Pick<HarnessProfile, 'id' | 'launchRevision'>,
): HarnessProfileProbe | undefined {
  return probes.find(
    (probe) =>
      probe.profileId === profile.id && probe.launchRevision === profile.launchRevision,
  )
}

export function recoveryProbe(
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

export function probeLaunchUnavailable(probe: HarnessProfileProbe | undefined): boolean {
  return (
    probe?.status === 'executable-missing' ||
    probe?.status === 'version-unsupported' ||
    probe?.status === 'disconnected'
  )
}

export function mergeTerminalProbe(
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

export function terminalProbeRefreshCandidates(
  profiles: readonly HarnessProfile[],
  probes: readonly HarnessProfileProbe[],
  now: number,
  force: boolean,
): readonly HarnessProfile[] {
  return profiles.filter((profile) => {
    if (profile.builtIn) return false
    const current = profileProbe(probes, profile)
    return force || !current?.expiresAt || current.expiresAt <= now
  })
}
