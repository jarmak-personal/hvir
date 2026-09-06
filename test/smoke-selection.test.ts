import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SMOKE_SCENARIOS,
  selectedSmokeScenarios,
} from '../scripts/run-smoke-scenarios.mts'
import {
  ELECTRON_SMOKE_SCENARIOS,
  parseElectronSmokeScenario,
} from '../src/main/smoke/scenario-selection.mts'

describe('Electron smoke scenario selection', () => {
  it.each([undefined, ''])('rejects a missing direct selection (%s)', (selection) => {
    expect(() => parseElectronSmokeScenario(selection)).toThrow(
      'Select one Electron smoke scenario',
    )
  })

  it.each(ELECTRON_SMOKE_SCENARIOS)('selects the named %s group', (scenario) => {
    expect(parseElectronSmokeScenario(scenario)).toBe(scenario)
    expect(selectedSmokeScenarios(scenario)).toEqual([scenario])
  })

  it('rejects unknown groups with the complete reproducible name set', () => {
    expect(() => parseElectronSmokeScenario('unknown')).toThrow(
      "Unknown Electron smoke scenario 'unknown'. Expected one of: " +
        'pty-native, viewer-position, viewer-content, git-workflow, workspace-remote, web-pane, renderer-authority, platform-contracts, diagnostic-report-restart, renderer-recovery, sessions-projection, document-review, development-performance, terminal-presentation, terminal-lifecycle, native-host-worker, workbench-health, terminal-theme, terminal-move, workbench-layout, terminal-split, harness-profiles, app-settings, capacity',
    )
    expect(() => selectedSmokeScenarios('unknown')).toThrow(
      "Unknown Electron smoke scenario 'unknown'. Expected one of: " +
        'pty-native, viewer-position, viewer-content, git-workflow, workspace-remote, web-pane, renderer-authority, platform-contracts, diagnostic-report-restart, renderer-recovery, sessions-projection, document-review, development-performance, terminal-presentation, terminal-lifecycle, native-host-worker, workbench-health, terminal-theme, terminal-move, workbench-layout, terminal-split, harness-profiles, app-settings, capacity',
    )
  })

  it('selects an explicit ordered scenario set without replacing the single-name API', () => {
    expect(
      selectedSmokeScenarios(undefined, [
        'pty-native',
        'viewer-position',
        'platform-contracts',
      ]),
    ).toEqual(['pty-native', 'viewer-position', 'platform-contracts'])
    expect(() => selectedSmokeScenarios('pty-native', ['viewer-position'])).toThrow(
      'positional names or HVIR_SMOKE_SCENARIO, not both',
    )
    expect(() => selectedSmokeScenarios(undefined, ['unknown'])).toThrow(
      "Unknown Electron smoke scenario 'unknown'",
    )
  })

  it('schedules each replacement required by the default aggregate', () => {
    expect(selectedSmokeScenarios(undefined)).toEqual(DEFAULT_SMOKE_SCENARIOS)
    expect(DEFAULT_SMOKE_SCENARIOS).toEqual([
      'pty-native',
      'viewer-position',
      'native-host-worker',
      'workbench-health',
      'platform-contracts',
      'terminal-theme',
      'terminal-move',
      'workbench-layout',
      'terminal-split',
      'app-settings',
      'harness-profiles',
    ])
  })
})

it.each(['legacy-workflow', 'workflow'])('rejects retired selection %s', (value) => {
  expect(() => parseElectronSmokeScenario(value)).toThrow(
    'Unknown Electron smoke scenario',
  )
})
