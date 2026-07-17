import {
  asHarnessProfileId,
  asHarnessProviderId,
  type HarnessLaunchRisk,
} from '../../../shared'
import type { HarnessProvider, HarnessRiskInput } from '../harness-provider'

export const geminiProvider: HarnessProvider = {
  manifest: {
    id: asHarnessProviderId('gemini-cli'),
    displayName: 'Gemini CLI',
    contextPresentation: 'none',
  },
  profile: {
    version: 1,
    defaultProfile: {
      id: asHarnessProfileId('gemini-cli-default'),
      displayName: 'Gemini CLI',
      description:
        'Gemini CLI. Launch-only; hvir never substitutes latest-session resume.',
    },
    reservedArguments: ['--resume', '-r'],
    reservedEnvironmentKeys: [],
    artifactEnvironmentKeys: [],
    artifactExecutable: false,
    artifactPathBindings: [],
    applyArgs: (_mode, providerArgs, profileArgs) => [...providerArgs, ...profileArgs],
    classifyRisk: classifyGeminiRisk,
  },
  supportsResume: false,
  sessionIdentity: 'none',
  probe: versionProbe(),
  launch: () => ({ file: 'gemini', args: [], shellEnvironment: true }),
  resume(ctx) {
    return this.launch(ctx)
  },
}

function classifyGeminiRisk(input: HarnessRiskInput): HarnessLaunchRisk {
  if (input.executableOverridden || input.environment.length > 0) return 'unclassified'
  let unclassified = false
  for (let index = 0; index < input.args.length; index++) {
    const token = input.args[index] ?? ''
    if (token === '--yolo' || token === '-y') return 'elevated'
    if (token === '--approval-mode' && input.args[index + 1] === 'yolo') return 'elevated'
    if (token === '--approval-mode') index++
    else if (token.startsWith('--approval-mode=') && token.endsWith('=yolo')) {
      return 'elevated'
    } else unclassified = true
  }
  return unclassified ? 'unclassified' : 'standard'
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
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) => line && !line.startsWith('(node:') && !line.startsWith('(Use `node'),
    )
  const line = lines.at(-1)
  return line && line.length <= 160 ? line : undefined
}
