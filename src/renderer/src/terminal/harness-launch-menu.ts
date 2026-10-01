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

function probeLabel(probe: HarnessProfileProbe | undefined): string {
  if (!probe) return 'Unchecked'
  switch (probe.status) {
    case 'available':
      return probe.version ?? 'Available'
    case 'executable-missing':
      return 'Executable missing'
    case 'version-unsupported':
      return 'Version incompatible'
    case 'capability-absent':
      return 'Capability unavailable'
    case 'authentication-required':
      return 'Authentication needed'
    case 'disconnected':
      return 'Host disconnected'
    case 'timeout':
      return 'Probe timed out'
    case 'malformed-output':
      return 'Version unknown'
    case 'probe-failed':
      return 'Probe failed'
    case 'unchecked':
      return 'Unchecked'
  }
}

export function launchAvailabilityLabel(state: HarnessLaunchMenuState): string {
  switch (state.availability) {
    case 'unchecked':
      return 'Unchecked'
    case 'checking':
      return 'Checking…'
    case 'available':
      return state.probe?.version ? `Available · ${state.probe.version}` : 'Available'
    case 'stale':
      return `Stale · ${probeLabel(state.probe)}`
    case 'failed':
      return `Failed · ${probeLabel(state.probe)}`
  }
}
