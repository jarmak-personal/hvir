import { asHarnessProfileId, asHarnessProviderId } from '../../../shared'
import type { HarnessProvider } from '../harness-provider'

export const geminiProvider: HarnessProvider = {
  manifest: {
    id: asHarnessProviderId('gemini-cli'),
    displayName: 'Gemini CLI',
    sessionKind: 'agent',
    contextPresentation: 'none',
  },
  profile: {
    version: 2,
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
  },
  supportsResume: false,
  sessionIdentity: 'none',
  probe: versionProbe(),
  launch: () => ({ file: 'gemini', args: [], shellEnvironment: true }),
  resume(ctx) {
    return this.launch(ctx)
  },
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
