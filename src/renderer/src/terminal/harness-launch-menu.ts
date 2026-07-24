import type {
  HarnessProfile,
  HarnessProfileProbe,
  HarnessProviderCapabilities,
  HarnessProviderDescriptor,
} from '../../../shared'

export interface HarnessLaunchMenuState {
  readonly availability: 'unchecked' | 'checking' | 'available' | 'stale' | 'failed'
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

export function harnessLaunchMenuState(
  profile: HarnessProfile,
  current: HarnessProfileProbe | undefined,
  checking: boolean,
  now = Date.now(),
): HarnessLaunchMenuState {
  if (profile.builtIn) return { availability: 'available' }
  if (checking) return { availability: 'checking', probe: current }
  if (!current || current.status === 'unchecked') {
    return { availability: 'unchecked', probe: current }
  }
  if (current.expiresAt !== undefined && current.expiresAt <= now) {
    return { availability: 'stale', probe: current }
  }
  return {
    availability: current.status === 'available' ? 'available' : 'failed',
    probe: current,
  }
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
