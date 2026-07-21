import { describe, expect, it } from 'vitest'

import { builtInProfiles } from '../src/main/harness/harness-profile-store'
import {
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
    ).toEqual({ kind: 'discard' })
  })
})
