export const REQUIRED_ELECTRON_PLATFORMS = ['linux-x64', 'macos-arm64'] as const

export type RequiredElectronPlatform = (typeof REQUIRED_ELECTRON_PLATFORMS)[number]
export type RequiredElectronSuiteGroup = 'core' | 'capacity'

export interface RequiredElectronSuite {
  readonly id: string
  readonly group: RequiredElectronSuiteGroup
  readonly command: readonly [string, ...string[]]
  readonly scenarios: readonly string[]
  readonly timeoutMs: number
}

export interface RequiredElectronExclusion {
  readonly scenario: string
  readonly acceptanceBoundary: string
}

export interface RequiredElectronPlatformDefinition {
  readonly id: RequiredElectronPlatform
  readonly name: string
  readonly runner: 'ubuntu-24.04' | 'macos-15'
  readonly suites: readonly RequiredElectronSuite[]
  readonly exclusions: readonly RequiredElectronExclusion[]
}

const MACOS_REDUCED_GATE_BOUNDARY = 'docs/phase8-performance-gauntlet.md#automated-runs'

export const REQUIRED_ELECTRON_SUITE_DEFINITIONS = {
  'linux-x64': {
    id: 'linux-x64',
    name: 'Linux x64',
    runner: 'ubuntu-24.04',
    suites: [
      {
        id: 'production',
        group: 'core',
        command: ['npm', 'run', 'smoke'],
        scenarios: [
          'pty-native',
          'viewer-position',
          'viewer-content',
          'git-workflow',
          'workspace-remote',
          'web-pane',
          'renderer-authority',
          'renderer-recovery',
          'terminal-presentation',
          'terminal-lifecycle',
          'legacy-workflow',
        ],
        timeoutMs: 8 * 60_000,
      },
      {
        id: 'development-performance',
        group: 'core',
        command: ['npm', 'run', 'smoke:development-performance'],
        scenarios: ['development-performance'],
        timeoutMs: 4 * 60_000,
      },
      {
        id: 'failure-interruption-isolation',
        group: 'core',
        command: ['npm', 'run', 'smoke:isolation'],
        scenarios: [
          'pty-controlled-failure',
          'pty-sighup',
          'pty-sigint',
          'git-sigterm',
          'web-pane-sigkill',
          'pty-clean-successor',
          'git-clean-successor',
          'web-pane-clean-successor',
        ],
        timeoutMs: 8 * 60_000,
      },
      {
        id: 'capacity',
        group: 'capacity',
        command: ['npm', 'run', 'smoke:capacity'],
        scenarios: ['capacity'],
        timeoutMs: 14 * 60_000,
      },
    ],
    exclusions: [],
  },
  'macos-arm64': {
    id: 'macos-arm64',
    name: 'macOS ARM64',
    runner: 'macos-15',
    suites: [
      {
        id: 'hosted-correctness',
        group: 'core',
        command: ['npm', 'run', 'smoke:macos:ci'],
        scenarios: [
          'pty-native',
          'viewer-position',
          'viewer-content',
          'git-workflow',
          'workspace-remote',
          'web-pane',
          'renderer-authority',
          'platform-contracts',
          'renderer-recovery',
        ],
        timeoutMs: 8 * 60_000,
      },
    ],
    exclusions: [
      {
        scenario: 'terminal-presentation',
        acceptanceBoundary: MACOS_REDUCED_GATE_BOUNDARY,
      },
      {
        scenario: 'terminal-lifecycle',
        acceptanceBoundary: MACOS_REDUCED_GATE_BOUNDARY,
      },
      {
        scenario: 'capacity',
        acceptanceBoundary: MACOS_REDUCED_GATE_BOUNDARY,
      },
    ],
  },
} as const satisfies Record<RequiredElectronPlatform, RequiredElectronPlatformDefinition>

export function parseRequiredElectronPlatform(value: string): RequiredElectronPlatform {
  if (REQUIRED_ELECTRON_PLATFORMS.includes(value as RequiredElectronPlatform)) {
    return value as RequiredElectronPlatform
  }
  throw new Error(
    `Unknown required Electron platform ${JSON.stringify(value)}; expected ${REQUIRED_ELECTRON_PLATFORMS.join(' or ')}`,
  )
}

export function requiredElectronSuites(
  platform: RequiredElectronPlatform,
  group?: RequiredElectronSuiteGroup,
): readonly RequiredElectronSuite[] {
  const suites = REQUIRED_ELECTRON_SUITE_DEFINITIONS[platform].suites
  return group === undefined ? suites : suites.filter((suite) => suite.group === group)
}

export function requiredElectronSelectionEvidence(platform: RequiredElectronPlatform): {
  readonly suiteCount: number
  readonly scenarioCount: number
  readonly suiteIds: readonly string[]
  readonly scenarios: readonly string[]
  readonly exclusions: readonly RequiredElectronExclusion[]
} {
  const definition = REQUIRED_ELECTRON_SUITE_DEFINITIONS[platform]
  return {
    suiteCount: definition.suites.length,
    scenarioCount: definition.suites.reduce(
      (count, suite) => count + suite.scenarios.length,
      0,
    ),
    suiteIds: definition.suites.map((suite) => suite.id),
    scenarios: definition.suites.flatMap((suite) => suite.scenarios),
    exclusions: definition.exclusions,
  }
}
