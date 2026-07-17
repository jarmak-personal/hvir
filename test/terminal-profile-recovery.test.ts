import { describe, expect, it } from 'vitest'

import { builtInProfiles } from '../src/main/harness/harness-profile-store'
import {
  autoRecoverableProfile,
  probeAllowsAutoRestore,
  recoverableProfile,
} from '../src/renderer/src/terminal/terminal-profile-recovery'
import { asHostId, hostPath, type TerminalRecoverySession } from '../src/shared'

describe('profile-bound terminal recovery', () => {
  const root = hostPath(asHostId('recovery-host'), '/project')
  const profile = builtInProfiles().find(
    (candidate) => candidate.id === 'claude-code-default',
  )!
  const record: TerminalRecoverySession = {
    id: 'terminal-1',
    providerId: profile.providerId,
    profileId: profile.id,
    launchRevision: profile.launchRevision,
    harnessSessionId: '00000000-0000-4000-8000-000000000001',
    hostId: root.hostId,
    cwd: root,
    title: 'Claude',
    position: 0,
    active: true,
    updatedAt: 1,
  }

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

  it('requires a current acknowledgment for elevated and unclassified restore', () => {
    const risky = { ...profile, builtIn: false, risk: 'elevated' as const }
    expect(autoRecoverableProfile([risky], record)).toBeUndefined()
    expect(
      autoRecoverableProfile([risky], {
        ...record,
        riskAcknowledgedRevision: record.launchRevision,
      }),
    ).toBeDefined()
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
