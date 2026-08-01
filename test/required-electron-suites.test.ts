import { readFileSync } from 'node:fs'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  REQUIRED_ELECTRON_SUITE_DEFINITIONS,
  requiredElectronSelectionEvidence,
  requiredElectronSuites,
} from '../scripts/required-electron-suites.mts'
import { runRequiredElectronSuites } from '../scripts/run-required-electron-suite.mts'

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { scripts: Record<string, string> }

afterEach(() => vi.restoreAllMocks())

describe('required Electron suite selection', () => {
  it('owns the exact Linux CI commands and scenario accounting', () => {
    const definition = REQUIRED_ELECTRON_SUITE_DEFINITIONS['linux-x64']
    expect(definition.suites.map((suite) => suite.command.join(' '))).toEqual([
      'npm run smoke',
      'npm run smoke:development-performance',
      'npm run smoke:isolation',
      'npm run smoke:capacity',
    ])
    expect(requiredElectronSelectionEvidence('linux-x64')).toMatchObject({
      suiteCount: 4,
      scenarioCount: 21,
      exclusions: [],
    })
    expect(requiredElectronSuites('linux-x64', 'core')).toHaveLength(3)
    expect(requiredElectronSuites('linux-x64', 'capacity')).toHaveLength(1)
  })

  it('records the exact hosted macOS gate and each documented exclusion', () => {
    const definition = REQUIRED_ELECTRON_SUITE_DEFINITIONS['macos-arm64']
    expect(definition.suites.map((suite) => suite.command.join(' '))).toEqual([
      'npm run smoke:macos:ci',
    ])
    expect(requiredElectronSelectionEvidence('macos-arm64')).toMatchObject({
      suiteCount: 1,
      scenarioCount: 9,
      exclusions: [
        { scenario: 'terminal-presentation' },
        { scenario: 'terminal-lifecycle' },
        { scenario: 'capacity' },
      ],
    })
    expect(
      definition.exclusions.every((item) =>
        item.acceptanceBoundary.startsWith('docs/phase8-performance-gauntlet.md#'),
      ),
    ).toBe(true)
  })

  it('runs every selected suite once and does not turn a failure into a retry', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const invoked: string[] = []
    const artifactDirectories: Array<string | undefined> = []
    const result = await runRequiredElectronSuites('linux-x64', {
      group: 'core',
      artifactDirectory: '/artifacts',
      invoke: (_platform, suite, options) => {
        invoked.push(suite.id)
        artifactDirectories.push(options.artifactDirectory)
        const failed = suite.id === 'development-performance'
        return Promise.resolve({
          id: suite.id,
          scenarios: suite.scenarios,
          status: failed ? 'failed' : 'passed',
          durationMs: 1,
          exitCode: failed ? 1 : 0,
          signal: null,
          failure: failed ? 'nonzero-exit' : null,
        })
      },
    })
    expect(invoked).toEqual([
      'production',
      'development-performance',
      'failure-interruption-isolation',
    ])
    expect(result.status).toBe('failed')
    expect(result.suites).toHaveLength(3)
    expect(artifactDirectories).toEqual([
      '/artifacts/production',
      '/artifacts/development-performance',
      '/artifacts/failure-interruption-isolation',
    ])
  })

  it('exposes one repository runner for normal CI and qualification', () => {
    expect(packageJson.scripts['smoke:required']).toBe(
      'node scripts/run-required-electron-suite.mts',
    )
  })
})
