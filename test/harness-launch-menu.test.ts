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
    capabilities: {
      sessionIdentity: 'preassigned',
      exactResume: true,
      contextPresentation: 'count',
    },
  }

  it('keeps bare Shell visible without a probe or capability label', () => {
    expect(harnessLaunchMenuState(shell, undefined, undefined, false)).toEqual({
      visible: true,
      checking: false,
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

  it('suppresses never-probed and negative profiles but keeps last-known-good while checking', () => {
    expect(harnessLaunchMenuState(claude, undefined, undefined, true)).toMatchObject({
      visible: false,
      checking: true,
    })
    expect(harnessLaunchMenuState(claude, undefined, available, true)).toMatchObject({
      visible: true,
      checking: true,
      probe: available,
    })
    expect(
      harnessLaunchMenuState(
        claude,
        { ...available, status: 'executable-missing' },
        available,
        false,
      ),
    ).toMatchObject({ visible: false, checking: false })
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
