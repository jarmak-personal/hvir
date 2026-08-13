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

export function defaultRecoveryRebindProfile(
  profiles: readonly HarnessProfile[],
  record: TerminalRecoverySession,
): HarnessProfile | undefined {
  return profiles.find(
    (profile) =>
      profile.id === record.profileId && profile.providerId === record.providerId,
  )
}

export function autoRecoverableProfile(
  profiles: readonly HarnessProfile[],
  record: TerminalRecoverySession,
): HarnessProfile | undefined {
  return recoverableProfile(profiles, record)
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
