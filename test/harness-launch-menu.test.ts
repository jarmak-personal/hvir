import { describe, expect, it } from 'vitest'

import {
  builtInProfiles,
  providerTemplateProfiles,
} from '../src/main/harness/harness-profile-store'
import {
  bareShellLaunchChoice,
  compactHarnessCapabilityLabel,
  harnessLaunchMenuState,
} from '../src/renderer/src/terminal/harness-launch-menu'
import {
  asHostId,
  asHarnessProviderId,
  type HarnessProfileProbe,
  type HarnessProviderDescriptor,
} from '../src/shared'

describe('harness launch-menu policy', () => {
  const shell = builtInProfiles()[0]!
  const claude = { ...providerTemplateProfiles()[0]!, builtIn: false }
  const available: HarnessProfileProbe = {
    providerId: claude.providerId,
    profileId: claude.id,
    launchRevision: claude.launchRevision,
    hostId: asHostId('menu-host'),
    status: 'available',
    checkedAt: 1,
    expiresAt: 20,
    capabilities: {
      sessionIdentity: 'preassigned',
      exactResume: true,
      contextPresentation: 'count',
    },
  }

  it('keeps bare Shell visible without a probe or capability label', () => {
    expect(harnessLaunchMenuState(shell, undefined, false)).toEqual({
      availability: 'available',
    })
    expect(compactHarnessCapabilityLabel(true, available.capabilities)).toBeUndefined()
  })

  it('selects computed Shell for implicit workspace and Split launches', () => {
    const providers: readonly HarnessProviderDescriptor[] = [
      {
        id: asHarnessProviderId('plain-shell'),
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
        profileGuidance: {
          reservedArguments: [],
          riskClassification: 'best-effort',
        },
      },
      {
        id: asHarnessProviderId('claude-code'),
        displayName: 'Claude Code',
        default: false,
        capabilities: available.capabilities,
        terminalInput: {
          modifiedKeyProtocol: 'modify-other-keys',
          metaEnterAliasesControl: false,
        },
        profileGuidance: {
          reservedArguments: [],
          riskClassification: 'best-effort',
        },
      },
    ]
    expect(bareShellLaunchChoice(providers, [{ ...claude, order: 0 }, shell])).toEqual({
      provider: providers[0],
      profile: shell,
    })
  })

  it('keeps configured profiles launchable across every advisory state', () => {
    expect(harnessLaunchMenuState(claude, undefined, false, 10)).toEqual({
      availability: 'unchecked',
    })
    expect(
      harnessLaunchMenuState(claude, { ...available, status: 'timeout' }, true, 10),
    ).toMatchObject({ availability: 'checking' })
    expect(harnessLaunchMenuState(claude, available, false, 10)).toMatchObject({
      availability: 'available',
    })
    expect(harnessLaunchMenuState(claude, available, false, 20)).toMatchObject({
      availability: 'stale',
    })
    for (const status of [
      'timeout',
      'disconnected',
      'executable-missing',
      'probe-failed',
    ] as const) {
      expect(
        harnessLaunchMenuState(
          claude,
          { ...available, status, expiresAt: 20 },
          false,
          10,
        ),
      ).toMatchObject({ availability: 'failed' })
    }
  })

  it('uses only the compact truthful capability vocabulary', () => {
    expect(compactHarnessCapabilityLabel(false, available.capabilities)).toBe(
      'Integrated',
    )
    expect(
      compactHarnessCapabilityLabel(false, {
        sessionIdentity: 'none',
        exactResume: false,
        contextPresentation: 'none',
      }),
    ).toBe('Launch only')
  })
})
