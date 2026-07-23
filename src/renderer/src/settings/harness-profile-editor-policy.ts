import {
  isHarnessBindingName,
  isHarnessEnvironmentName,
  type HarnessCommandPreview,
  type HarnessPathGrant,
  type HarnessProfile,
  type HarnessProfileExecutable,
  type HarnessProfileInput,
  type HarnessProfileProbe,
  type HarnessProviderDescriptor,
  type HostPath,
} from '../../../shared'

export function replaceHarnessValue<T>(
  values: readonly T[],
  index: number,
  value: T,
): readonly T[] {
  return values.map((candidate, candidateIndex) =>
    candidateIndex === index ? value : candidate,
  )
}

export function applyExecutableGrant(
  executable: HarnessProfileExecutable,
  grant: HarnessPathGrant,
): HarnessProfileExecutable {
  return executable.kind === 'path'
    ? { kind: 'path', path: grant.path, grantId: grant.id }
    : executable
}

export function applyPathBindingGrant(
  input: HarnessProfileInput,
  index: number,
  grant: HarnessPathGrant,
): HarnessProfileInput {
  return {
    ...input,
    pathBindings: input.pathBindings.map((binding, candidate) =>
      candidate === index
        ? { ...binding, path: grant.path, grantId: grant.id }
        : binding,
    ),
  }
}

export function harnessProfileBindingError(
  input: Pick<HarnessProfileInput, 'args' | 'environment' | 'pathBindings'>,
): string | undefined {
  const environmentNames = new Set<string>()
  for (const binding of input.environment) {
    if (!isHarnessEnvironmentName(binding.name)) return 'Invalid environment binding'
    if (
      binding.kind === 'reference' &&
      !isHarnessEnvironmentName(binding.sourceName)
    ) {
      return `Invalid environment binding for '${binding.name}'`
    }
    if (environmentNames.has(binding.name)) {
      return `Duplicate environment binding '${binding.name}'`
    }
    environmentNames.add(binding.name)
  }

  const pathNames = new Set<string>()
  for (const binding of input.pathBindings) {
    if (!isHarnessBindingName(binding.name)) return 'Invalid profile path binding'
    if (pathNames.has(binding.name)) {
      return `Duplicate path binding '${binding.name}'`
    }
    pathNames.add(binding.name)
  }

  for (const argument of input.args) {
    for (const part of argument.parts) {
      if (
        part.kind === 'path' &&
        part.source === 'binding' &&
        (!part.binding || !pathNames.has(part.binding))
      ) {
        return `Unknown path binding '${part.binding ?? ''}'`
      }
    }
  }
  return undefined
}

export function harnessRiskLabel(value: HarnessProfile['risk']): string {
  return value === 'standard'
    ? 'Standard'
    : value === 'elevated'
      ? 'Elevated'
      : 'Unclassified'
}

export function previewRiskLabel(
  previews: readonly HarnessCommandPreview[],
): string {
  return previews[0] ? harnessRiskLabel(previews[0].risk) : 'Pending validation'
}

export function findProfileProbe(
  probes: readonly HarnessProfileProbe[],
  profile: HarnessProfile,
  hostId?: HostPath['hostId'],
): HarnessProfileProbe | undefined {
  return probes.find(
    (probe) =>
      probe.profileId === profile.id &&
      probe.launchRevision === profile.launchRevision &&
      (hostId === undefined || probe.hostId === hostId),
  )
}

export function mergeProfileProbe(
  probes: readonly HarnessProfileProbe[],
  next: HarnessProfileProbe,
): readonly HarnessProfileProbe[] {
  return [
    ...probes.filter(
      (probe) =>
        probe.profileId !== next.profileId ||
        probe.launchRevision !== next.launchRevision ||
        probe.hostId !== next.hostId,
    ),
    next,
  ]
}

export function harnessProbeLabel(probe: HarnessProfileProbe | undefined): string {
  if (!probe) return 'Not checked'
  switch (probe.status) {
    case 'available':
      return probe.version ?? 'Available'
    case 'executable-missing':
      return 'Executable missing on this host'
    case 'version-unsupported':
      return 'Version incompatible on this host'
    case 'capability-absent':
      return 'Required capability unavailable'
    case 'authentication-required':
      return 'Authentication required'
    case 'disconnected':
      return 'Host disconnected'
    case 'timeout':
      return 'Availability check timed out'
    case 'malformed-output':
      return 'Version output not understood'
    case 'probe-failed':
      return probe.detail ?? 'Availability check failed'
    case 'unchecked':
      return 'Not checked'
  }
}

export function harnessCapabilityLabel(
  provider: HarnessProviderDescriptor | undefined,
  probe: HarnessProfileProbe | undefined,
): string {
  if (!provider) return 'Provider unavailable'
  if (provider.default) {
    return 'Plain terminal lifecycle; harness integration is inapplicable'
  }
  const capabilities = probe?.capabilities ?? provider.capabilities
  return [
    capabilities.exactResume ? 'Exact recovery' : 'No exact recovery',
    capabilities.contextPresentation === 'none'
      ? 'No structured telemetry'
      : capabilities.contextPresentation === 'pressure'
        ? 'Structured context pressure'
        : 'Structured context usage',
    harnessProbeLabel(probe),
  ].join(' · ')
}

export function editorErrorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
