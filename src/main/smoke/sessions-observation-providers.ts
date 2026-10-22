import type { HarnessProvider } from '../harness/harness-provider-contract'
import type { SessionsObservationProvider } from '../sessions/sessions-observation-port'

/** Synthetic Sessions fixtures deliberately have no context-pressure observations. */
export function smokeSessionsObservationProviders(
  providers: readonly HarnessProvider[],
): readonly SessionsObservationProvider[] {
  return providers.map((provider) => ({
    id: provider.manifest.id,
    displayName: provider.manifest.displayName,
    telemetrySupported: Boolean(provider.telemetry),
    usageSupported: Boolean(provider.usageTelemetry),
    sessionKind: provider.manifest.sessionKind,
  }))
}
