import { describe, expect, it } from 'vitest'

import {
  builtInProfiles,
  providerTemplateProfiles,
} from '../src/main/harness/harness-profile-store'
import {
  autoRecoverableProfile,
  defaultRecoveryRebindProfile,
  probeAllowsAutoRestore,
  recoverableProfile,
} from '../src/renderer/src/terminal/terminal-profile-recovery'
import {
  asHarnessProfileId,
  asHostId,
  hostPath,
  type HarnessProfile,
  type TerminalRecoverySession,
} from '../src/shared'

describe('profile-bound terminal recovery', () => {
  const root = hostPath(asHostId('recovery-host'), '/project')
  const profile = providerTemplateProfiles().find(
    (candidate) => candidate.id === 'claude-code-default',
  )!
  const record: TerminalRecoverySession = {
    id: 'terminal-1',
    providerId: profile.providerId,
    profileId: profile.id,
    launchRevision: profile.launchRevision,
    recoverySkipCount: 0,
    harnessSessionId: '00000000-0000-4000-8000-000000000001',
    hostId: root.hostId,
    cwd: root,
    title: 'Claude',
    position: 0,
    active: true,
    updatedAt: 1,
  }

  it('restores computed bare Shell without requiring a probe', () => {
    const shell = builtInProfiles()[0]!
    expect(
      probeAllowsAutoRestore(
        [],
        {
          ...record,
          providerId: shell.providerId,
          profileId: shell.id,
          launchRevision: shell.launchRevision,
          harnessSessionId: undefined,
        },
        shell,
      ),
    ).toBe(true)
  })

  it('ignores cosmetic metadata but rejects launch revision drift', () => {
    expect(
      recoverableProfile(
        [{ ...profile, displayName: 'Renamed', metadataRevision: 8 }],
        record,
      ),
    ).toBeDefined()
    expect(
      recoverableProfile(
        [{ ...profile, launchRevision: profile.launchRevision + 1 }],
        record,
      ),
    ).toBeUndefined()
  })

  it('defaults review to the retained profile identity without choosing by array order', () => {
    const alternative = {
      ...profile,
      id: asHarnessProfileId('claude-code-alternative'),
      displayName: 'Alternative Claude',
    }
    const current = {
      ...profile,
      displayName: 'Retained Claude',
      launchRevision: record.launchRevision + 1,
    }

    expect(defaultRecoveryRebindProfile([alternative, current], record)).toBe(current)
    expect(
      defaultRecoveryRebindProfile([alternative], {
        ...record,
        profileId: asHarnessProfileId('removed-profile'),
      }),
    ).toBeUndefined()
  })

  it('ignores obsolete risk metadata when evaluating exact automatic recovery', () => {
    const legacyProfile = {
      ...profile,
      builtIn: false,
      risk: 'elevated',
      riskAcknowledgedRevision: undefined,
    } as unknown as HarnessProfile
    const legacyRecord = {
      ...record,
      riskAcknowledgedRevision: undefined,
    } as unknown as TerminalRecoverySession

    expect(autoRecoverableProfile([legacyProfile], legacyRecord)).toBe(legacyProfile)
  })

  it('requires a successful probe for unattended restore', () => {
    expect(probeAllowsAutoRestore([], record)).toBe(false)
    expect(
      probeAllowsAutoRestore(
        [
          {
            providerId: record.providerId,
            profileId: record.profileId,
            launchRevision: record.launchRevision,
            hostId: root.hostId,
            status: 'available',
            capabilities: {
              sessionIdentity: 'preassigned',
              exactResume: true,
              contextPresentation: 'count',
            },
          },
        ],
        record,
      ),
    ).toBe(true)
  })

  it('does not turn an exact recovery record into a fresh launch after downgrade', () => {
    const exactRecord = {
      ...record,
      harnessSessionId: '0198f0e0-b5d5-7f57-99f1-2ed5e4c785cc',
    }
    const availableProbe = {
      providerId: record.providerId,
      profileId: record.profileId,
      launchRevision: record.launchRevision,
      hostId: root.hostId,
      status: 'available' as const,
      checkedAt: 1,
      capabilities: {
        sessionIdentity: 'none' as const,
        exactResume: false,
        contextPresentation: 'none' as const,
      },
    }
    expect(probeAllowsAutoRestore([availableProbe], exactRecord)).toBe(false)
    expect(
      probeAllowsAutoRestore(
        [
          {
            ...availableProbe,
            capabilities: {
              ...availableProbe.capabilities,
              sessionIdentity: 'preassigned',
              exactResume: true,
            },
          },
        ],
        exactRecord,
      ),
    ).toBe(true)
  })

  it('keeps identity-capable records without an exact identity manual-only', () => {
    const missingIdentity = { ...record, harnessSessionId: undefined }
    expect(
      probeAllowsAutoRestore(
        [
          {
            providerId: record.providerId,
            profileId: record.profileId,
            launchRevision: record.launchRevision,
            hostId: root.hostId,
            status: 'available',
            checkedAt: 1,
            capabilities: {
              sessionIdentity: 'discovered',
              exactResume: true,
              contextPresentation: 'pressure',
            },
          },
        ],
        missingIdentity,
      ),
    ).toBe(false)
  })
})
