import { readFileSync } from 'node:fs'

import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_SMOKE_SCENARIOS,
  formatSmokeScenarioResults,
  runSmokeScenarioGroups,
  selectedSmokeScenarios,
  type SmokeScenarioName,
} from '../scripts/run-smoke-scenarios.mts'
import {
  ELECTRON_SMOKE_SCENARIOS,
  parseElectronSmokeScenario,
} from '../src/main/smoke/scenario-selection.mts'

describe('Electron smoke scenario selection', () => {
  it('keeps bare direct Electron smoke compatible with the legacy workflow', () => {
    expect(parseElectronSmokeScenario(undefined)).toBe('legacy-workflow')
    expect(parseElectronSmokeScenario('')).toBe('legacy-workflow')
  })

  it.each(ELECTRON_SMOKE_SCENARIOS)('selects the named %s group', (scenario) => {
    expect(parseElectronSmokeScenario(scenario)).toBe(scenario)
    expect(selectedSmokeScenarios(scenario)).toEqual([scenario])
  })

  it('rejects unknown groups with the complete reproducible name set', () => {
    expect(() => parseElectronSmokeScenario('unknown')).toThrow(
      "Unknown Electron smoke scenario 'unknown'. Expected one of: " +
        'pty-native, legacy-workflow, capacity',
    )
    expect(() => selectedSmokeScenarios('unknown')).toThrow(
      "Unknown Electron smoke scenario 'unknown'. Expected one of: " +
        'pty-native, legacy-workflow, capacity',
    )
  })

  it('schedules only the small native and legacy groups by default', () => {
    expect(selectedSmokeScenarios(undefined)).toEqual(DEFAULT_SMOKE_SCENARIOS)
    expect(DEFAULT_SMOKE_SCENARIOS).toEqual(['pty-native', 'legacy-workflow'])
  })
})

describe('Electron smoke result aggregation', () => {
  it('continues after a sibling failure and returns every group result', async () => {
    const invoked: SmokeScenarioName[] = []
    const invoke = vi.fn((scenario: SmokeScenarioName) => {
      invoked.push(scenario)
      if (scenario === 'pty-native') throw new Error('native load failed')
      return Promise.resolve({ status: 'passed' as const, exitCode: 0 })
    })

    const results = await runSmokeScenarioGroups(DEFAULT_SMOKE_SCENARIOS, invoke)

    expect(invoked).toEqual(['pty-native', 'legacy-workflow'])
    expect(results).toEqual([
      {
        scenario: 'pty-native',
        status: 'failed',
        error: 'native load failed',
      },
      { scenario: 'legacy-workflow', status: 'passed', exitCode: 0 },
    ])
    expect(formatSmokeScenarioResults(results)).toBe(
      '[smoke:summary]\n' +
        '- pty-native: failed (native load failed)\n' +
        '- legacy-workflow: passed (exit 0)',
    )
  })
})

describe('Electron smoke command contracts', () => {
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { scripts: Record<string, string> }
  const invocationScript = readFileSync(
    new URL('../scripts/run-smoke.sh', import.meta.url),
    'utf8',
  )
  const packagedScript = readFileSync(
    new URL('../scripts/run-packaged-smoke.sh', import.meta.url),
    'utf8',
  )
  const contributing = readFileSync(
    new URL('../CONTRIBUTING.md', import.meta.url),
    'utf8',
  )
  const smokeWorkflow = readFileSync(
    new URL('../src/main/smoke/index.ts', import.meta.url),
    'utf8',
  )
  const capacityScenario = readFileSync(
    new URL('../src/main/smoke/capacity.ts', import.meta.url),
    'utf8',
  )

  it('routes default and capacity commands through the named process launcher', () => {
    expect(packageJson.scripts.smoke).toContain('node scripts/run-smoke-scenarios.mts')
    expect(packageJson.scripts['smoke:capacity']).toContain(
      'HVIR_SMOKE_SCENARIO=capacity node scripts/run-smoke-scenarios.mts',
    )
    expect(packageJson.scripts['smoke:capacity']).not.toContain('HVIR_CAPACITY_SMOKE')
  })

  it('passes one selected name into each hermetic unpackaged invocation', () => {
    expect(invocationScript).toContain(
      'HVIR_SMOKE_SCENARIO="${HVIR_SMOKE_SCENARIO:-legacy-workflow}"',
    )
    expect(invocationScript).toContain('create-smoke-repository.sh')
  })

  it('keeps packaged smoke on the explicit transitional workflow until #119', () => {
    expect(packagedScript).toContain('HVIR_SMOKE=1 HVIR_SMOKE_SCENARIO=legacy-workflow')
  })

  it('enters capacity before unrelated legacy profile and viewer assertions', () => {
    const branch = smokeWorkflow.indexOf("if (mode === 'capacity')")
    expect(branch).toBeGreaterThan(-1)
    expect(branch).toBeLessThan(smokeWorkflow.indexOf('const profileSmoke'))
    expect(branch).toBeLessThan(smokeWorkflow.indexOf('const viewerStatus'))
    expect(smokeWorkflow.indexOf("if (mode === 'capacity')", branch + 1)).toBe(-1)
    expect(capacityScenario).toContain('JSON.stringify(snapshot())')
  })

  it('documents every selectable group and the aggregate result behavior', () => {
    for (const scenario of ELECTRON_SMOKE_SCENARIOS) {
      expect(contributing).toContain(`\`${scenario}\``)
    }
    expect(contributing).toMatch(/reports a result for\s+every scheduled group/)
  })
})
