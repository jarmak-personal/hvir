import { describe, expect, it } from 'vitest'

import {
  asHarnessProfileId,
  asHarnessProviderId,
  type HarnessProfile,
} from '../src/shared'
import { isHarnessProfileDraftDirty } from '../src/renderer/src/settings/harness-profile-draft'

const profile: HarnessProfile = {
  id: asHarnessProfileId('test-profile'),
  launchRevision: 1,
  metadataRevision: 1,
  providerContractVersion: 1,
  builtIn: false,
  risk: 'standard',
  displayName: 'Test profile',
  providerId: asHarnessProviderId('custom'),
  scope: { kind: 'global' },
  executable: { kind: 'command', command: 'agent' },
  args: [
    { parts: [{ kind: 'literal', value: '--add-dir' }] },
    { parts: [{ kind: 'literal', value: '/tmp/skills' }] },
  ],
  environment: [],
  pathBindings: [],
  order: 1,
}

describe('harness profile draft state', () => {
  it('compares parsed argv meaning instead of editor whitespace', () => {
    expect(isHarnessProfileDraftDirty(profile, profile, '--add-dir /tmp/skills')).toBe(
      false,
    )
    expect(isHarnessProfileDraftDirty(profile, profile, '--add-dir\n/tmp/skills')).toBe(
      false,
    )
  })

  it('detects profile fields, argument changes, invalid input, and new profiles', () => {
    expect(
      isHarnessProfileDraftDirty(
        profile,
        { ...profile, displayName: 'Renamed profile' },
        '--add-dir /tmp/skills',
      ),
    ).toBe(true)
    expect(isHarnessProfileDraftDirty(profile, profile, '--add-dir /tmp/other')).toBe(
      true,
    )
    expect(isHarnessProfileDraftDirty(profile, profile, "'unfinished")).toBe(true)
    expect(isHarnessProfileDraftDirty(undefined, profile, '--add-dir /tmp/skills')).toBe(
      true,
    )
  })
})
