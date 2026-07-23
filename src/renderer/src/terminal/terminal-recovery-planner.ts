import type {
  HarnessProfile,
  HarnessProfileProbe,
  HarnessProviderCapabilities,
  HarnessProviderDescriptor,
  TerminalRecoverySession,
} from '../../../shared'
import type { TerminalRecoveryMode } from '../settings/settings'
import {
  autoRecoverableProfile,
  probeAllowsAutoRestore,
  recoverableProfile,
} from './terminal-profile-recovery'
import {
  probeLaunchUnavailable,
  profileProbe,
  recoveryProbe,
} from './terminal-probe-policy'
import type { StoredTerminalSplitLayout } from './terminal-split-persistence'
import type { TerminalSession } from './terminal-workspace-model'

export type TerminalAutomaticRecoveryPlan =
  | { readonly kind: 'none' }
  | { readonly kind: 'wait-for-probes' }
  | { readonly kind: 'manual' }
  | {
      readonly kind: 'restore'
      readonly result: TerminalRestorationResult
      readonly residual: readonly TerminalRecoverySession[]
    }

export interface TerminalRestorationResult {
  readonly sessions: readonly TerminalSession[]
  readonly activeId?: string
}

export type TerminalManualRecoveryPlan =
  | {
      readonly kind: 'discard'
      readonly decision: TerminalManualRecoveryDecision
    }
  | {
      readonly kind: 'restore'
      readonly decision: TerminalManualRecoveryDecision
      readonly result: TerminalRestorationResult
    }

export interface TerminalManualRecoveryDecision {
  readonly restoredIds: readonly string[]
  readonly skippedIds: readonly string[]
}

export function planManualTerminalRecovery({
  selectedIds,
  records,
  providers,
  profiles,
  probes,
  splitLayout,
}: {
  readonly selectedIds: ReadonlySet<string>
  readonly records: readonly TerminalRecoverySession[]
  readonly providers: readonly HarnessProviderDescriptor[]
  readonly profiles: readonly HarnessProfile[]
  readonly probes: readonly HarnessProfileProbe[]
  readonly splitLayout: StoredTerminalSplitLayout
}): TerminalManualRecoveryPlan {
  const eligible = records.filter(
    (record) =>
      terminalRecoveryCandidateDecision(record, providers, profiles, probes).action !==
        'unavailable' && !probeLaunchUnavailable(recoveryProbe(probes, record)),
  )
  const selected = eligible.filter((record) => selectedIds.has(record.id))
  const decision = {
    restoredIds: selected.map(({ id }) => id),
    skippedIds: eligible
      .filter((record) => !selectedIds.has(record.id))
      .map(({ id }) => id),
  }
  return selected.length === 0
    ? { kind: 'discard', decision }
    : {
        kind: 'restore',
        decision,
        result: restoreTerminalSessions(
          selected,
          providers,
          profiles,
          probes,
          splitLayout,
          true,
        ),
      }
}

export function planAutomaticTerminalRecovery({
  records,
  providers,
  profiles,
  probes,
  splitLayout,
  mode,
  probesReady,
}: {
  readonly records: readonly TerminalRecoverySession[]
  readonly providers: readonly HarnessProviderDescriptor[]
  readonly profiles: readonly HarnessProfile[]
  readonly probes: readonly HarnessProfileProbe[]
  readonly splitLayout: StoredTerminalSplitLayout
  readonly mode: TerminalRecoveryMode
  readonly probesReady: boolean
}): TerminalAutomaticRecoveryPlan {
  if (records.length === 0) return { kind: 'none' }
  if (mode !== 'auto') return { kind: 'manual' }
  if (!probesReady) return { kind: 'wait-for-probes' }
  const automatic = records.filter((record) => {
    const profile = autoRecoverableProfile(profiles, record)
    return Boolean(
      providerDescriptor(providers, record.providerId) &&
      profile &&
      probeAllowsAutoRestore(probes, record, profile),
    )
  })
  if (automatic.length === 0) return { kind: 'manual' }
  const automaticIds = new Set(automatic.map(({ id }) => id))
  return {
    kind: 'restore',
    result: restoreTerminalSessions(
      automatic,
      providers,
      profiles,
      probes,
      splitLayout,
      false,
    ),
    residual: records.filter(({ id }) => !automaticIds.has(id)),
  }
}

export function mergeTerminalRestorations(
  existing: TerminalRestorationResult,
  restored: TerminalRestorationResult,
  records: readonly TerminalRecoverySession[],
): TerminalRestorationResult {
  const sessionsById = new Map(
    restored.sessions.map((session) => [session.id, session] as const),
  )
  for (const session of existing.sessions) sessionsById.set(session.id, session)

  const orderedRecords = [...records].sort(
    (left, right) => left.position - right.position || left.updatedAt - right.updatedAt,
  )
  const sessions = orderedRecords.flatMap<TerminalSession>(({ id }) => {
    const session = sessionsById.get(id)
    if (!session) return []
    sessionsById.delete(id)
    return [session]
  })
  for (const session of [...existing.sessions, ...restored.sessions]) {
    if (!sessionsById.delete(session.id)) continue
    sessions.push(session)
  }

  const intendedActiveId = orderedRecords.find(
    ({ id, active }) => active && sessions.some((session) => session.id === id),
  )?.id
  const availableActiveId = [
    intendedActiveId,
    existing.activeId,
    restored.activeId,
    sessions[0]?.id,
  ].find(
    (id): id is string =>
      id !== undefined && sessions.some((session) => session.id === id),
  )
  return { sessions, activeId: availableActiveId }
}

export function restoreTerminalSessions(
  records: readonly TerminalRecoverySession[],
  providers: readonly HarnessProviderDescriptor[],
  profiles: readonly HarnessProfile[],
  probes: readonly HarnessProfileProbe[],
  splitLayout: StoredTerminalSplitLayout,
  manualRiskAcknowledgment: boolean,
): TerminalRestorationResult {
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
      cwd: record.cwd,
    }
  })
  return {
    sessions,
    activeId:
      ordered.find(
        (record) => record.active && sessions.some(({ id }) => id === record.id),
      )?.id ?? sessions[0]?.id,
  }
}

export type TerminalRecoveryCandidateDecision =
  | { readonly action: 'new-shell' }
  | { readonly action: 'resume' }
  | { readonly action: 'restart' }
  | { readonly action: 'unavailable'; readonly reason: string }

export function terminalRecoveryCandidateDecision(
  record: TerminalRecoverySession,
  providers: readonly HarnessProviderDescriptor[],
  profiles: readonly HarnessProfile[],
  probes: readonly HarnessProfileProbe[],
): TerminalRecoveryCandidateDecision {
  const provider = providerDescriptor(providers, record.providerId)
  if (!provider) {
    return {
      action: 'unavailable',
      reason: `Provider '${record.providerId}' is missing`,
    }
  }
  const profile = recoverableProfile(profiles, record)
  if (!profile) {
    const current = profiles.find((candidate) => candidate.id === record.profileId)
    if (!current) {
      return {
        action: 'unavailable',
        reason: `Profile '${record.profileId}' is missing`,
      }
    }
    if (current.providerId !== record.providerId) {
      return { action: 'unavailable', reason: 'Profile provider changed' }
    }
    return {
      action: 'unavailable',
      reason: `Launch revision changed (${record.launchRevision} → ${current.launchRevision})`,
    }
  }
  if (profile.builtIn) return { action: 'new-shell' }
  const capabilities =
    recoveryProbe(probes, record)?.capabilities ?? provider.capabilities
  return restoreAction(record, capabilities)
}

function restoreAction(
  record: TerminalRecoverySession,
  capabilities: HarnessProviderCapabilities,
): TerminalRecoveryCandidateDecision {
  return capabilities.exactResume && record.harnessSessionId
    ? { action: 'resume' }
    : { action: 'restart' }
}

function providerDescriptor(
  providers: readonly HarnessProviderDescriptor[],
  id: TerminalRecoverySession['providerId'],
): HarnessProviderDescriptor | undefined {
  return providers.find((provider) => provider.id === id)
}
