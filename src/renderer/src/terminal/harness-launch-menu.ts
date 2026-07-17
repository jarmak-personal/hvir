import type {
  HarnessProfile,
  HarnessProfileProbe,
  HarnessProviderCapabilities,
  HarnessProviderDescriptor,
} from '../../../shared'

export interface HarnessLaunchMenuState {
  readonly visible: boolean
  readonly checking: boolean
  readonly probe?: HarnessProfileProbe
}

export function bareShellLaunchChoice(
  providers: readonly HarnessProviderDescriptor[],
  profiles: readonly HarnessProfile[],
):
  | {
      readonly provider: HarnessProviderDescriptor
      readonly profile: HarnessProfile
    }
  | undefined {
  const provider = providers.find((candidate) => candidate.default)
  const profile = provider
    ? profiles.find(
        (candidate) => candidate.builtIn && candidate.providerId === provider.id,
      )
    : undefined
  return provider && profile ? { provider, profile } : undefined
}

/**
 * Launch-menu truth is deliberately stricter than Settings. Bare Shell is
 * unconditional; configured harnesses appear only after a positive probe or
 * from a same-context last-known-good result while a new check is pending.
 */
export function harnessLaunchMenuState(
  profile: HarnessProfile,
  current: HarnessProfileProbe | undefined,
  lastKnownGood: HarnessProfileProbe | undefined,
  checking: boolean,
): HarnessLaunchMenuState {
  if (profile.builtIn) return { visible: true, checking: false }
  if (current) {
    if (current.status !== 'available')
      return { visible: false, checking, probe: current }
    return { visible: true, checking, probe: current }
  }
  if (lastKnownGood?.status === 'available') {
    return { visible: true, checking, probe: lastKnownGood }
  }
  return { visible: false, checking }
}

export function compactHarnessCapabilityLabel(
  shellProvider: boolean,
  capabilities: HarnessProviderCapabilities | undefined,
): 'Integrated' | 'Launch only' | undefined {
  if (shellProvider) return undefined
  if (
    capabilities?.exactResume === true &&
    capabilities.sessionIdentity !== 'none' &&
    capabilities.contextPresentation !== 'none'
  ) {
    return 'Integrated'
  }
  return 'Launch only'
}

export function compactProfileProviderLabel(
  profileName: string,
  providerName: string,
): string {
  return profileName === providerName ? profileName : `${profileName} · ${providerName}`
}
