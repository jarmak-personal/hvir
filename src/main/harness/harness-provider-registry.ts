import {
  asHarnessProviderId,
  type HarnessProviderDescriptor,
  type HarnessProviderId,
} from '../../shared'
import type { HarnessProvider } from './harness-provider-contract'
import { harnessProviderCapabilities } from './harness-provider-capabilities'

export class HarnessProviderRegistry {
  private readonly providers = new Map<HarnessProviderId, HarnessProvider>()

  constructor(providers: readonly HarnessProvider[]) {
    for (const provider of providers) this.register(provider)
    const defaults = [...this.providers.values()].filter(
      ({ manifest }) => manifest.default,
    )
    if (defaults.length !== 1) {
      throw new Error('Harness provider registry requires exactly one default provider')
    }
  }

  get(id: string): HarnessProvider {
    const provider = this.providers.get(asHarnessProviderId(id))
    if (!provider) throw new Error(`Unknown harness provider '${id}'`)
    return provider
  }

  catalog(): readonly HarnessProviderDescriptor[] {
    return [...this.providers.values()].map((provider) => ({
      id: provider.manifest.id,
      displayName: provider.manifest.displayName,
      default: provider.manifest.default === true,
      ...(provider.fork ? { exactForkLaunch: true as const } : {}),
      capabilities: harnessProviderCapabilities(provider),
      terminalInput: {
        modifiedKeyProtocol: provider.manifest.modifiedKeyProtocol ?? 'none',
        metaEnterAliasesControl: provider.manifest.metaEnterAliasesControl === true,
      },
      profileTemplate: provider.profile.defaultProfile
        ? {
            displayName: provider.profile.defaultProfile.displayName,
            description: provider.profile.defaultProfile.description,
          }
        : undefined,
      profileGuidance: {
        reservedArguments: provider.profile.reservedArguments,
      },
    }))
  }

  all(): readonly HarnessProvider[] {
    return [...this.providers.values()]
  }

  private register(provider: HarnessProvider): void {
    const { id, displayName } = provider.manifest
    if (this.providers.has(id)) {
      throw new Error(`Duplicate harness provider '${id}'`)
    }
    if (displayName.trim().length === 0 || displayName.length > 80) {
      throw new Error(`Invalid display name for harness provider '${id}'`)
    }
    if (
      provider.sessionIdentity === 'discovered' &&
      provider.sessionDiscovery === undefined
    ) {
      throw new Error(`Harness provider '${id}' is missing session discovery`)
    }
    if (
      provider.sessionIdentity !== 'discovered' &&
      provider.sessionDiscovery !== undefined
    ) {
      throw new Error(`Harness provider '${id}' has unexpected session discovery`)
    }
    if (provider.resumeValidation && !provider.supportsResume) {
      throw new Error(`Harness provider '${id}' validates resume without supporting it`)
    }
    if (
      (provider.sessionDiscovery || provider.telemetry || provider.usageTelemetry) &&
      provider.profile.reservedEnvironmentKeys.some(
        (key) => !provider.profile.artifactEnvironmentKeys.includes(key),
      )
    ) {
      throw new Error(
        `Harness provider '${id}' has a reserved environment key without artifact semantics`,
      )
    }
    this.providers.set(id, provider)
  }
}
