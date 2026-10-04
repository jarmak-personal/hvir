import type { HarnessProvider } from '../harness/harness-provider-contract'
import type { SessionsObservationProvider } from './sessions-observation-port'

/** Registry facts for Sessions; synthetic fixtures can retain their absent-pressure contract. */
export function sessionsObservationProviders(
  providers: readonly HarnessProvider[],
  includeContextPressure = true,
): readonly SessionsObservationProvider[] {
  return providers.map((provider) => ({
    id: provider.manifest.id,
    displayName: provider.manifest.displayName,
    telemetrySupported: Boolean(provider.telemetry),
    usageSupported: Boolean(provider.usageTelemetry),
    sessionKind: provider.manifest.sessionKind,
    ...(includeContextPressure
      ? { contextPressure: provider.manifest.contextPressure }
      : {}),
  }))
}
