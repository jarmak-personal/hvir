import {
  asHarnessProfileId,
  asHarnessProviderId,
  contextHarnessSnapshot,
} from '../../shared'
import type { HarnessProvider } from '../harness/harness-provider-contract'
import { usageObservationHarnessTelemetry } from '../harness/harness-usage'

export const SESSIONS_USAGE_SMOKE_TOTAL = 123_456

/** Deterministic trusted-provider fixture exercised only by production Electron smoke. */
export const sessionsUsageSmokeProvider: HarnessProvider = {
  manifest: {
    id: asHarnessProviderId('smoke-usage'),
    displayName: 'Smoke usage',
    sessionKind: 'agent',
    contextPresentation: 'pressure',
  },
  profile: {
    version: 1,
    defaultProfile: {
      id: asHarnessProfileId('smoke-usage-default'),
      displayName: 'Smoke usage',
      description: 'Production-composed deterministic Usage smoke fixture.',
    },
    reservedArguments: [],
    reservedEnvironmentKeys: [],
    artifactEnvironmentKeys: [],
    artifactExecutable: false,
    artifactPathBindings: [],
    applyArgs: (_mode, providerArgs, profileArgs) => [...providerArgs, ...profileArgs],
  },
  supportsResume: false,
  sessionIdentity: 'preassigned',
  probe: {
    parseVersion: () => undefined,
    effectiveCapabilities: () => ({
      sessionIdentity: 'preassigned',
      exactResume: false,
      contextPresentation: 'pressure',
    }),
  },
  telemetry: {
    observe: (_host, context) => {
      const telemetry = contextHarnessSnapshot({
        providerId: sessionsUsageSmokeProvider.manifest.id,
        sessionId: context.sessionId,
        provenance: 'Deterministic Sessions presentation fixture',
        context: { usedTokens: 69_000, windowTokens: 100_000, usedPercent: 69 },
        modelId: 'Fixture model',
      })
      context.emit({
        ...telemetry,
        facets: {
          ...telemetry.facets,
          turn: { status: 'available', value: { state: 'waiting-for-user' } },
        },
      })
      return () => undefined
    },
  },
  usageTelemetry: {
    observe: (_host, context) => {
      const telemetry = usageObservationHarnessTelemetry({
        providerId: sessionsUsageSmokeProvider.manifest.id,
        sessionId: context.sessionId,
        provenance: 'deterministic Electron Usage fixture',
        counters: {
          freshInputTokens: 100_000,
          cacheReadInputTokens: 20_000,
          cacheWriteInputTokens: 456,
          outputTokens: 3_000,
          reasoningTokens: 1_000,
        },
      })
      if (telemetry) context.emit(telemetry)
      return () => undefined
    },
  },
  launch: (context) => ({ file: context.defaultShell, args: ['-l'] }),
  resume: (context) => ({ file: context.defaultShell, args: ['-l'] }),
}
