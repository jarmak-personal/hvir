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
  asHarnessProfileId,
  asHarnessProviderId,
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
      { secondaryIds: [] },
      true,
    )
    expect(result.sessions.map(({ id }) => id)).toEqual(['first', 'second'])
    expect(result.activeId).toBe('second')
    expect(result.sessions.map(({ id, dormant }) => ({ id, dormant }))).toEqual([
      { id: 'first', dormant: true },
      { id: 'second', dormant: false },
    ])
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
      {
        sessions: [existing],
        activeId: existing.id,
        activeByPane: { primary: existing.id, secondary: undefined },
      },
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
      dormant: false,
      status: 'Resuming…',
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
    ).toEqual({ kind: 'discard' })
  })

  it('admits at most the persisted visible row per split across provider kinds', () => {
    const exactCapabilities = {
      sessionIdentity: 'preassigned' as const,
      exactResume: true,
      contextPresentation: 'count' as const,
    }
    const launchCapabilities = {
      sessionIdentity: 'none' as const,
      exactResume: false,
      contextPresentation: 'none' as const,
    }
    const descriptors = [
      providerFor('claude-code', exactCapabilities),
      providerFor('codex', {
        ...exactCapabilities,
        sessionIdentity: 'discovered',
      }),
      providerFor('github-copilot-cli', launchCapabilities),
      providerFor('custom', launchCapabilities),
    ]
    const recoveryProfiles = descriptors.map((descriptor) => ({
      ...profile,
      id: asHarnessProfileId(`${descriptor.id}-profile`),
      providerId: descriptor.id,
      displayName: descriptor.displayName,
      builtIn: false,
    }))
    const records = descriptors.map((descriptor, position) => ({
      ...record,
      id: `terminal-${position}`,
      providerId: descriptor.id,
      profileId: recoveryProfiles[position]!.id,
      title: descriptor.displayName,
      harnessSessionId: position < 2 ? `exact-${position}` : undefined,
      position,
      active: position === 0,
      attention: position === 3 ? ('bell' as const) : undefined,
    }))

    const restored = restoreTerminalSessions(
      records,
      descriptors,
      recoveryProfiles,
      [],
      {
        secondaryIds: ['terminal-1'],
        activeByPane: { primary: 'terminal-0', secondary: 'terminal-1' },
      },
      true,
    )

    expect(restored.activeByPane).toEqual({
      primary: 'terminal-0',
      secondary: 'terminal-1',
    })
    expect(
      restored.sessions.map(({ id, dormant, status, attention }) => ({
        id,
        dormant,
        status,
        attention,
      })),
    ).toEqual([
      {
        id: 'terminal-0',
        dormant: false,
        status: 'Resuming…',
        attention: undefined,
      },
      {
        id: 'terminal-1',
        dormant: false,
        status: 'Resuming…',
        attention: undefined,
      },
      {
        id: 'terminal-2',
        dormant: true,
        status: 'Ready to start',
        attention: undefined,
      },
      {
        id: 'terminal-3',
        dormant: true,
        status: 'Ready to start',
        attention: 'bell',
      },
    ])
  })
})

function providerFor(
  id: string,
  capabilities: HarnessProviderDescriptor['capabilities'],
): HarnessProviderDescriptor {
  return {
    id: asHarnessProviderId(id),
    displayName: id,
    default: false,
    capabilities,
    terminalInput: {
      modifiedKeyProtocol: 'none',
      metaEnterAliasesControl: false,
    },
    profileGuidance: { reservedArguments: [], riskClassification: 'best-effort' },
  }
}
