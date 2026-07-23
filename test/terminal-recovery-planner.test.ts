import { describe, expect, it } from 'vitest'

import { builtInProfiles } from '../src/main/harness/harness-profile-store'
import {
  mergeTerminalRestorations,
  planAutomaticTerminalRecovery,
  planManualTerminalRecovery,
  restoreTerminalSessions,
  terminalRecoveryCandidateDecision,
} from '../src/renderer/src/terminal/terminal-recovery-planner'
import {
  asHostId,
  hostPath,
  type HarnessProviderDescriptor,
  type TerminalRecoverySession,
} from '../src/shared'

describe('terminal recovery planner', () => {
  const profile = builtInProfiles()[0]!
  const provider: HarnessProviderDescriptor = {
    id: profile.providerId,
    displayName: 'Shell',
    default: true,
    capabilities: {
      sessionIdentity: 'none',
      exactResume: false,
      contextPresentation: 'none',
    },
    terminalInput: {
      modifiedKeyProtocol: 'none',
      metaEnterAliasesControl: false,
    },
    profileGuidance: { reservedArguments: [], riskClassification: 'best-effort' },
  }
  const root = hostPath(asHostId('recovery-plan'), '/repo')
  const record: TerminalRecoverySession = {
    id: 'second',
    providerId: provider.id,
    profileId: profile.id,
    launchRevision: profile.launchRevision,
    recoverySkipCount: 0,
    hostId: root.hostId,
    cwd: root,
    title: 'Shell 2',
    position: 1,
    active: true,
    updatedAt: 2,
  }

  it('waits for probes, requires manual review, or restores as explicit plans', () => {
    expect(
      planAutomaticTerminalRecovery({
        records: [record],
        providers: [provider],
        profiles: [profile],
        probes: [],
        splitLayout: { secondaryIds: ['second'] },
        mode: 'prompt',
        probesReady: true,
      }).kind,
    ).toBe('manual')
    const automatic = planAutomaticTerminalRecovery({
      records: [record],
      providers: [provider],
      profiles: [profile],
      probes: [],
      splitLayout: { secondaryIds: ['second'] },
      mode: 'auto',
      probesReady: true,
    })
    expect(automatic.kind).toBe('restore')
    if (automatic.kind === 'restore') {
      expect(automatic.result).toMatchObject({ activeId: 'second' })
      expect(automatic.result.sessions[0]).toMatchObject({
        id: 'second',
        pane: 'secondary',
        resumeOnStart: false,
      })
    }
  })

  it('preserves persisted order and falls back to the first viable active session', () => {
    const first = { ...record, id: 'first', position: 0, active: false, updatedAt: 1 }
    const result = restoreTerminalSessions(
      [record, first],
      [provider],
      [profile],
      [],
      { secondaryIds: ['second'] },
      true,
    )
    expect(result.sessions.map(({ id }) => id)).toEqual(['first', 'second'])
    expect(result.activeId).toBe('second')
  })

  it('partitions automatic recovery per record and leaves only blockers for review', () => {
    const unavailable = {
      ...record,
      id: 'unavailable',
      profileId: 'missing-profile' as typeof record.profileId,
      position: 0,
    }
    const automatic = planAutomaticTerminalRecovery({
      records: [unavailable, record],
      providers: [provider],
      profiles: [profile],
      probes: [],
      splitLayout: { secondaryIds: ['second'] },
      mode: 'auto',
      probesReady: true,
    })
    expect(automatic.kind).toBe('restore')
    if (automatic.kind === 'restore') {
      expect(automatic.result.sessions.map(({ id }) => id)).toEqual(['second'])
      expect(automatic.result.sessions[0]?.pane).toBe('secondary')
      expect(automatic.residual).toEqual([unavailable])
      expect(
        terminalRecoveryCandidateDecision(unavailable, [provider], [profile], []),
      ).toEqual({
        action: 'unavailable',
        reason: "Profile 'missing-profile' is missing",
      })
    }
  })

  it('merges reviewed residuals without replacing live automatic sessions', () => {
    const firstRecord = {
      ...record,
      id: 'first',
      position: 0,
      active: false,
      updatedAt: 1,
    }
    const secondRecord = { ...record, position: 1, active: true, updatedAt: 2 }
    const automatic = restoreTerminalSessions(
      [firstRecord],
      [provider],
      [profile],
      [],
      { secondaryIds: [] },
      false,
    )
    const existing = {
      ...automatic.sessions[0]!,
      status: 'pid 138',
      resumeOnStart: false,
    }
    const reviewed = restoreTerminalSessions(
      [secondRecord],
      [provider],
      [profile],
      [],
      { secondaryIds: ['second'] },
      true,
    )
    const merged = mergeTerminalRestorations(
      { sessions: [existing], activeId: existing.id },
      reviewed,
      [secondRecord, firstRecord],
    )

    expect(merged.sessions.map(({ id }) => id)).toEqual(['first', 'second'])
    expect(merged.sessions[0]).toBe(existing)
    expect(merged.sessions[1]?.pane).toBe('secondary')
    expect(merged.activeId).toBe('second')
  })

  it('makes resume, restart, new-shell, and unavailable decisions explicit', () => {
    expect(terminalRecoveryCandidateDecision(record, [provider], [profile], [])).toEqual({
      action: 'new-shell',
    })
    expect(terminalRecoveryCandidateDecision(record, [], [profile], [])).toMatchObject({
      action: 'unavailable',
    })
    const integrated = {
      ...provider,
      capabilities: {
        sessionIdentity: 'preassigned' as const,
        exactResume: true,
        contextPresentation: 'count' as const,
      },
    }
    const configured = { ...profile, builtIn: false }
    expect(
      terminalRecoveryCandidateDecision(
        { ...record, harnessSessionId: 'exact-id' },
        [integrated],
        [configured],
        [],
      ),
    ).toEqual({ action: 'resume' })
    expect(
      terminalRecoveryCandidateDecision(record, [integrated], [configured], []),
    ).toEqual({ action: 'restart' })
  })

  it('reconstructs an exact retained identity for retry after a renderer restart', () => {
    const integrated = {
      ...provider,
      capabilities: {
        sessionIdentity: 'preassigned' as const,
        exactResume: true,
        contextPresentation: 'count' as const,
      },
    }
    const configured = { ...profile, builtIn: false }
    const exact = { ...record, harnessSessionId: 'exact-retained-id' }

    expect(
      restoreTerminalSessions(
        [exact],
        [integrated],
        [configured],
        [],
        { secondaryIds: [] },
        true,
      ).sessions[0],
    ).toMatchObject({
      harnessSessionId: 'exact-retained-id',
      identityStatus: 'identified',
      resumeOnStart: true,
      status: 'Ready to resume',
    })
  })

  it('plans an empty manual selection as discard without inventing a launch', () => {
    expect(
      planManualTerminalRecovery({
        selectedIds: new Set(),
        records: [record],
        providers: [provider],
        profiles: [profile],
        probes: [],
        splitLayout: { secondaryIds: [] },
      }),
    ).toEqual({
      kind: 'discard',
      decision: { restoredIds: [], skippedIds: ['second'] },
    })
  })

  it('partitions restored and skipped records without deciding unavailable entries', () => {
    const skipped = { ...record, id: 'skipped', active: false }
    const missing = {
      ...record,
      id: 'missing',
      profileId: 'missing-profile' as typeof record.profileId,
      active: false,
    }
    const disconnectedProfile = {
      ...profile,
      id: 'disconnected-profile' as typeof profile.id,
    }
    const disconnected = {
      ...record,
      id: 'disconnected',
      profileId: disconnectedProfile.id,
      active: false,
    }

    expect(
      planManualTerminalRecovery({
        selectedIds: new Set(['second']),
        records: [record, skipped, missing, disconnected],
        providers: [provider],
        profiles: [profile, disconnectedProfile],
        probes: [
          {
            providerId: disconnected.providerId,
            profileId: disconnected.profileId,
            launchRevision: disconnected.launchRevision,
            hostId: root.hostId,
            status: 'disconnected',
            checkedAt: 1,
            expiresAt: 2,
            capabilities: provider.capabilities,
          },
        ],
        splitLayout: { secondaryIds: [] },
      }),
    ).toMatchObject({
      kind: 'restore',
      decision: {
        restoredIds: ['second'],
        skippedIds: ['skipped'],
      },
    })
  })
})
