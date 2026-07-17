import {
  asHarnessProfileId,
  asHarnessProviderId,
  type HarnessLaunchRisk,
} from '../../../shared'
import type { HarnessProvider, HarnessRiskInput } from '../harness-provider'

export const githubCopilotProvider: HarnessProvider = {
  manifest: {
    id: asHarnessProviderId('github-copilot-cli'),
    displayName: 'GitHub Copilot CLI',
    contextPresentation: 'none',
  },
  profile: {
    version: 2,
    defaultProfile: {
      id: asHarnessProfileId('github-copilot-cli-default'),
      displayName: 'GitHub Copilot CLI',
      description:
        'Copilot CLI. Launch-only across versions without verified --session-id.',
    },
    reservedArguments: ['--session-id', '--resume', '-r', '--continue', '--connect'],
    reservedEnvironmentKeys: [],
    artifactEnvironmentKeys: [],
    artifactExecutable: false,
    artifactPathBindings: [],
    applyArgs: (_mode, providerArgs, profileArgs) => [...providerArgs, ...profileArgs],
    classifyRisk: classifyCopilotRisk,
  },
  supportsResume: false,
  sessionIdentity: 'none',
  probe: versionProbe(),
  launch: () => ({
    file: 'copilot',
    args: [],
    shellEnvironment: true,
  }),
  resume(ctx) {
    return this.launch(ctx)
  },
}

function classifyCopilotRisk(input: HarnessRiskInput): HarnessLaunchRisk {
  if (input.executableOverridden || input.environment.length > 0) return 'unclassified'
  const elevated = new Set([
    '--allow-all',
    '--allow-all-tools',
    '--allow-all-paths',
    '--allow-all-urls',
    '--yolo',
  ])
  return input.args.some(
    (token) => elevated.has(token) || token.startsWith('--allow-all='),
  )
    ? 'elevated'
    : input.args.length > 0
      ? 'unclassified'
      : 'standard'
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
