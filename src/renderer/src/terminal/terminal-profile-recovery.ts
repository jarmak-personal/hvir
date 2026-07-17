import type {
  HarnessProfile,
  HarnessProfileProbe,
  TerminalRecoverySession,
} from '../../../shared'

export function recoverableProfile(
  profiles: readonly HarnessProfile[],
  record: TerminalRecoverySession,
): HarnessProfile | undefined {
  return profiles.find(
    (profile) =>
      profile.id === record.profileId &&
      profile.providerId === record.providerId &&
      profile.launchRevision === record.launchRevision,
  )
}

export function autoRecoverableProfile(
  profiles: readonly HarnessProfile[],
  record: TerminalRecoverySession,
): HarnessProfile | undefined {
  const profile = recoverableProfile(profiles, record)
  if (!profile) return undefined
  return profile.risk === 'standard' ||
    profile.riskAcknowledgedRevision === profile.launchRevision ||
    record.riskAcknowledgedRevision === record.launchRevision
    ? profile
    : undefined
}

export function profileRiskAcknowledged(profile: HarnessProfile): boolean {
  return (
    profile.risk === 'standard' ||
    profile.riskAcknowledgedRevision === profile.launchRevision
  )
}

export function probeAllowsAutoRestore(
  probes: readonly HarnessProfileProbe[],
  record: TerminalRecoverySession,
  profile?: HarnessProfile,
): boolean {
  if (profile?.builtIn) return record.harnessSessionId === undefined
  const probe = probes.find(
    (candidate) =>
      candidate.providerId === record.providerId &&
      candidate.profileId === record.profileId &&
      candidate.launchRevision === record.launchRevision,
  )
  if (!probe || probe.status !== 'available') return false
  if (record.harnessSessionId !== undefined) return probe.capabilities.exactResume
  return probe.capabilities.sessionIdentity === 'none'
}
