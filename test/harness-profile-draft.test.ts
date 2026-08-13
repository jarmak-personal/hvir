import { describe, expect, it } from 'vitest'

import {
  asHarnessProfileId,
  asHarnessProviderId,
  localPath,
  type HarnessProfile,
  type HarnessProviderDescriptor,
} from '../src/shared'
import {
  harnessProfileDraft,
  harnessProfileSaveRevision,
  isHarnessProfileDraftDirty,
  newHarnessProfileDraft,
} from '../src/renderer/src/settings/harness-profile-draft'

const profile: HarnessProfile = {
  id: asHarnessProfileId('test-profile'),
  launchRevision: 1,
  metadataRevision: 1,
  providerContractVersion: 1,
  builtIn: false,
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

  it('preserves optimistic revisions and rejects missing or immutable revisions', () => {
    const draft = harnessProfileDraft(profile)
    expect(harnessProfileSaveRevision(draft)).toMatchObject({
      kind: 'update',
      id: profile.id,
      expectedLaunchRevision: 1,
      expectedMetadataRevision: 1,
    })
    expect(() =>
      harnessProfileSaveRevision({ ...draft, metadataRevision: undefined }),
    ).toThrow('revision is unavailable')
    expect(() => harnessProfileSaveRevision({ ...draft, builtIn: true })).toThrow(
      'immutable',
    )
  })

  it('creates provider-opaque drafts with bounded ordering and exact argv serialization', () => {
    const providers: readonly HarnessProviderDescriptor[] = [
      {
        id: asHarnessProviderId('opaque-provider'),
        displayName: 'Opaque provider',
        default: false,
        capabilities: {
          exactResume: false,
          sessionIdentity: 'none',
          contextPresentation: 'none',
        },
        terminalInput: {
          modifiedKeyProtocol: 'none',
          metaEnterAliasesControl: false,
        },
        profileTemplate: {
          displayName: 'Opaque',
          description: 'Opaque template',
        },
        profileGuidance: {
          reservedArguments: [],
        },
      },
    ]
    const created = newHarnessProfileDraft(providers, [
      {
        ...profile,
        order: 199,
        scope: { kind: 'project', projectRoot: localPath('/repo') },
      },
    ])
    expect(created?.input.providerId).toBe(asHarnessProviderId('opaque-provider'))
    expect(created?.input.order).toBe(199)
    expect(created?.input.executable).toEqual({ kind: 'provider-default' })
    expect(harnessProfileSaveRevision(created!)).toMatchObject({ kind: 'create' })
  })

  it('reuses one structured draft path for additional shells, custom commands, and bundled providers', () => {
    const descriptor = (
      id: string,
      displayName: string,
      options: Pick<HarnessProviderDescriptor, 'default' | 'profileTemplate'>,
    ): HarnessProviderDescriptor => ({
      id: asHarnessProviderId(id),
      displayName,
      ...options,
      capabilities: {
        exactResume: false,
        sessionIdentity: 'none',
        contextPresentation: 'none',
      },
      terminalInput: {
        modifiedKeyProtocol: 'none',
        metaEnterAliasesControl: false,
      },
      profileGuidance: { reservedArguments: [] },
    })
    const providers = [
      descriptor('plain-shell', 'Shell', {
        default: true,
        profileTemplate: {
          displayName: 'Shell',
          description: 'Interactive shell',
        },
      }),
      descriptor('custom', 'Custom', {
        default: false,
        profileTemplate: undefined,
      }),
      descriptor('bundled', 'Bundled agent', {
        default: false,
        profileTemplate: {
          displayName: 'Bundled agent',
          description: 'Bundled provider',
        },
      }),
    ] as const

    const shell = newHarnessProfileDraft(
      providers,
      [profile],
      asHarnessProviderId('plain-shell'),
    )
    const custom = newHarnessProfileDraft(
      providers,
      [profile],
      asHarnessProviderId('custom'),
    )
    const bundled = newHarnessProfileDraft(
      providers,
      [profile],
      asHarnessProviderId('bundled'),
    )

    expect(shell?.input).toMatchObject({
      displayName: 'Additional shell',
      providerId: 'plain-shell',
      executable: { kind: 'provider-default' },
      scope: { kind: 'global' },
      environment: [],
      pathBindings: [],
    })
    expect(custom?.input).toMatchObject({
      displayName: 'Custom command',
      providerId: 'custom',
      executable: { kind: 'command', command: '' },
    })
    expect(bundled?.input).toMatchObject({
      displayName: 'Bundled agent profile',
      providerId: 'bundled',
      executable: { kind: 'provider-default' },
    })
    expect([shell?.input.order, custom?.input.order, bundled?.input.order]).toEqual([
      2, 2, 2,
    ])
  })
})
