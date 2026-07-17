import {
  asHarnessProfileId,
  asHarnessProviderId,
  type HarnessLaunchRisk,
} from '../../../shared'
import type { HarnessProvider, HarnessRiskInput } from '../harness-provider'

export const piProvider: HarnessProvider = {
  manifest: {
    id: asHarnessProviderId('pi'),
    displayName: 'Pi',
    contextPresentation: 'none',
  },
  profile: {
    version: 1,
    defaultProfile: {
      id: asHarnessProfileId('pi-default'),
      displayName: 'Pi',
      description:
        'Pi coding agent. Launch-only until exact new-session identity is proven.',
    },
    reservedArguments: ['--session', '--fork', '--continue', '-c', '--resume', '-r'],
    // Pi remains launch-only, so do not claim artifact relocation semantics for
    // undocumented environment variables. Add these only alongside a verified
    // discovery or telemetry observer.
    reservedEnvironmentKeys: [],
    artifactEnvironmentKeys: [],
    artifactExecutable: false,
    artifactPathBindings: [],
    applyArgs: (_mode, providerArgs, profileArgs) => [...providerArgs, ...profileArgs],
    classifyRisk: classifyPiRisk,
  },
  supportsResume: false,
  sessionIdentity: 'none',
  probe: versionProbe(),
  launch: () => ({ file: 'pi', args: [], shellEnvironment: true }),
  resume(ctx) {
    return this.launch(ctx)
  },
}

function classifyPiRisk(input: HarnessRiskInput): HarnessLaunchRisk {
  return input.args.length === 0 &&
    input.environment.length === 0 &&
    !input.executableOverridden
    ? 'standard'
    : 'unclassified'
}

function versionProbe(): HarnessProvider['probe'] {
  return {
    versionArgs: ['--version'],
    parseVersion: firstLine,
    effectiveCapabilities: () => ({
      sessionIdentity: 'none',
      exactResume: false,
      contextPresentation: 'none',
    }),
  }
}

function firstLine(output: string): string | undefined {
  const line = output.trim().split(/\r?\n/, 1)[0]?.trim()
  return line && line.length <= 160 ? line : undefined
}
