import {
  asHarnessProfileId,
  asHarnessProviderId,
  type HarnessLaunchRisk,
} from '../../../shared'
import type { HarnessProvider, HarnessRiskInput } from '../harness-provider'

export const cursorProvider: HarnessProvider = {
  manifest: {
    id: asHarnessProviderId('cursor-cli'),
    displayName: 'Cursor CLI',
    contextPresentation: 'none',
  },
  profile: {
    version: 1,
    defaultProfile: {
      id: asHarnessProfileId('cursor-cli-default'),
      displayName: 'Cursor CLI',
      description:
        'Cursor Agent CLI. Launch-only while its beta session listing evolves.',
    },
    reservedArguments: ['--resume', 'resume', 'ls'],
    reservedEnvironmentKeys: [],
    artifactEnvironmentKeys: [],
    artifactExecutable: false,
    artifactPathBindings: [],
    applyArgs: (_mode, providerArgs, profileArgs) => [...providerArgs, ...profileArgs],
    classifyRisk: classifyCursorRisk,
  },
  supportsResume: false,
  sessionIdentity: 'none',
  probe: versionProbe(),
  launch: () => ({ file: 'cursor-agent', args: [], shellEnvironment: true }),
  resume(ctx) {
    return this.launch(ctx)
  },
}

function classifyCursorRisk(input: HarnessRiskInput): HarnessLaunchRisk {
  if (input.executableOverridden || input.environment.length > 0) return 'unclassified'
  if (input.args.some((token) => token === '--force' || token === '-f')) {
    return 'elevated'
  }
  return input.args.length > 0 ? 'unclassified' : 'standard'
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
