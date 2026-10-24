import {
  asHarnessProfileId,
  asHarnessProviderId,
  contextHarnessSnapshot,
} from '../../shared'
import type { HarnessProvider } from '../harness/harness-provider-contract'

/** Deterministic trusted-provider fixture exercised only by production Electron smoke. */
export const sessionsPresentationSmokeProvider: HarnessProvider = {
  manifest: {
    id: asHarnessProviderId('smoke-presentation'),
    displayName: 'Smoke presentation',
    sessionKind: 'agent',
    contextPresentation: 'pressure',
  },
  profile: {
    version: 1,
    defaultProfile: {
      id: asHarnessProfileId('smoke-presentation-default'),
      displayName: 'Smoke presentation',
      description: 'Production-composed deterministic context smoke fixture.',
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
        providerId: sessionsPresentationSmokeProvider.manifest.id,
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
  launch: (context) => ({ file: context.defaultShell, args: ['-l'] }),
  resume: (context) => ({ file: context.defaultShell, args: ['-l'] }),
}
