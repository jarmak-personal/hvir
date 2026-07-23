import { readFileSync } from 'node:fs'

import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_SMOKE_SCENARIOS,
  formatSmokeScenarioResults,
  parseSmokeRepetitionCount,
  runSmokeScenarioGroups,
  selectedSmokeScenarios,
  smokeScenarioEnvironment,
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
        'pty-native, viewer-position, platform-contracts, terminal-presentation, legacy-workflow, capacity',
    )
    expect(() => selectedSmokeScenarios('unknown')).toThrow(
      "Unknown Electron smoke scenario 'unknown'. Expected one of: " +
        'pty-native, viewer-position, platform-contracts, terminal-presentation, legacy-workflow, capacity',
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

  it('schedules the focused native and viewer groups with the legacy workflow', () => {
    expect(selectedSmokeScenarios(undefined)).toEqual(DEFAULT_SMOKE_SCENARIOS)
    expect(DEFAULT_SMOKE_SCENARIOS).toEqual([
      'pty-native',
      'viewer-position',
      'legacy-workflow',
    ])
  })
})

describe('Electron smoke result aggregation', () => {
  it('runs every group for every iteration and continues after failures', async () => {
    const invoked: Array<readonly [SmokeScenarioName, number, number]> = []
    const invoke = vi.fn(
      (scenario: SmokeScenarioName, iteration: number, repetitionCount: number) => {
        invoked.push([scenario, iteration, repetitionCount])
        if (scenario === 'pty-native' && iteration === 1) {
          throw new Error('native load failed')
        }
        if (scenario === 'viewer-position' && iteration === 2) {
          return Promise.resolve({ status: 'failed' as const, exitCode: 2 })
        }
        return Promise.resolve({ status: 'passed' as const, exitCode: 0 })
      },
    )

    const results = await runSmokeScenarioGroups(DEFAULT_SMOKE_SCENARIOS, 2, invoke)

    expect(invoked).toEqual([
      ['pty-native', 1, 2],
      ['viewer-position', 1, 2],
      ['legacy-workflow', 1, 2],
      ['pty-native', 2, 2],
      ['viewer-position', 2, 2],
      ['legacy-workflow', 2, 2],
    ])
    expect(results).toEqual([
      {
        scenario: 'pty-native',
        iteration: 1,
        repetitionCount: 2,
        status: 'failed',
        error: 'native load failed',
      },
      {
        scenario: 'viewer-position',
        iteration: 1,
        repetitionCount: 2,
        status: 'passed',
        exitCode: 0,
      },
      {
        scenario: 'legacy-workflow',
        iteration: 1,
        repetitionCount: 2,
        status: 'passed',
        exitCode: 0,
      },
      {
        scenario: 'pty-native',
        iteration: 2,
        repetitionCount: 2,
        status: 'passed',
        exitCode: 0,
      },
      {
        scenario: 'viewer-position',
        iteration: 2,
        repetitionCount: 2,
        status: 'failed',
        exitCode: 2,
      },
      {
        scenario: 'legacy-workflow',
        iteration: 2,
        repetitionCount: 2,
        status: 'passed',
        exitCode: 0,
      },
    ])
    expect(formatSmokeScenarioResults(results)).toBe(
      '[smoke:summary] attempts=6 iterations=2\n' +
        '- pty-native iteration 1/2: failed (native load failed)\n' +
        '- viewer-position iteration 1/2: passed (exit 0)\n' +
        '- legacy-workflow iteration 1/2: passed (exit 0)\n' +
        '- pty-native iteration 2/2: passed (exit 0)\n' +
        '- viewer-position iteration 2/2: failed (exit 2)\n' +
        '- legacy-workflow iteration 2/2: passed (exit 0)',
    )
  })

  it('defaults to one iteration and accepts bounded ASCII decimal counts', () => {
    expect(parseSmokeRepetitionCount(undefined)).toBe(1)
    expect(parseSmokeRepetitionCount('1')).toBe(1)
    expect(parseSmokeRepetitionCount('20')).toBe(20)
    expect(parseSmokeRepetitionCount('100')).toBe(100)
    expect(parseSmokeRepetitionCount('01')).toBe(1)
  })

  it.each(['', ' ', ' 1', '1 ', '+1', '-1', '1.0', '1e1', '0', '101', '١'])(
    'rejects invalid repetition count %j',
    (value) => {
      expect(() => parseSmokeRepetitionCount(value)).toThrow(
        'HVIR_SMOKE_REPEAT must be an ASCII decimal integer from 1 through 100',
      )
    },
  )

  it('does not pass runner repetition control into an Electron attempt', () => {
    expect(
      smokeScenarioEnvironment(
        {
          HVIR_SMOKE_REPEAT: '20',
          HVIR_SMOKE_SCENARIO: 'legacy-workflow',
          KEEP_ME: 'yes',
        },
        'pty-native',
      ),
    ).toEqual({
      HVIR_SMOKE_SCENARIO: 'pty-native',
      KEEP_ME: 'yes',
    })
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
  const gauntletScript = readFileSync(
    new URL('../scripts/phase8-gauntlet.sh', import.meta.url),
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
  const capacityPerformancePolicy = readFileSync(
    new URL('../src/main/smoke/capacity-performance.ts', import.meta.url),
    'utf8',
  )
  const capacityTerminalScenario = readFileSync(
    new URL('../src/main/smoke/capacity-terminals.ts', import.meta.url),
    'utf8',
  )
  const viewerPositionScenario = readFileSync(
    new URL('../src/main/smoke/viewer-position.ts', import.meta.url),
    'utf8',
  )
  const terminalPresentationScenario = readFileSync(
    new URL('../src/main/smoke/terminal-presentation.ts', import.meta.url),
    'utf8',
  )

  it('separates correctness, hosted evidence, and controlled performance commands', () => {
    expect(packageJson.scripts.smoke).toContain('node scripts/run-smoke-scenarios.mts')
    expect(packageJson.scripts['smoke:macos']).toContain(
      'node scripts/run-smoke-scenarios.mts pty-native viewer-position platform-contracts terminal-presentation',
    )
    expect(packageJson.scripts['smoke:macos']).not.toMatch(
      /terminal-presentation capacity/,
    )
    expect(packageJson.scripts['smoke:capacity']).toContain(
      'HVIR_SMOKE_SCENARIO=capacity node scripts/run-smoke-scenarios.mts',
    )
    expect(packageJson.scripts['smoke:capacity']).not.toContain(
      'HVIR_CAPACITY_PERFORMANCE_GATE',
    )
    expect(packageJson.scripts['performance:capacity']).toContain(
      'HVIR_SMOKE_SCENARIO=capacity HVIR_CAPACITY_PERFORMANCE_GATE=controlled',
    )
    expect(gauntletScript).toContain('npm run performance:capacity')
    expect(contributing).toContain('machine-dependent capacity evidence')
    expect(contributing).toContain('controlled-machine release gate')
  })

  it('passes one selected name into each hermetic unpackaged invocation', () => {
    expect(invocationScript).toContain(
      'HVIR_SMOKE_SCENARIO="${HVIR_SMOKE_SCENARIO:-legacy-workflow}"',
    )
    expect(invocationScript).toContain('HVIR_SMOKE_SOURCE_COMMIT="$source_commit"')
    expect(invocationScript).toContain('HVIR_SMOKE_SOURCE_DIRTY="$source_dirty"')
    expect(invocationScript).toContain('create-smoke-repository.sh')
  })

  it('installs exact-version tarballs and exercises script-free first-use preparation', () => {
    expect(packagedScript).toContain(
      'tarball="dist/npm/${package_name}-${package_version}.tgz"',
    )
    expect(packagedScript).toContain(
      'launcher_tarball="dist/npm/hvir-workbench-${package_version}.tgz"',
    )
    expect(packagedScript).toContain('--ignore-scripts')
    expect(packagedScript).toContain("grep -Eiq 'allow-scripts|install scripts not'")
    expect(packagedScript).toContain('chmod -R a-w "$installation_root"')
    expect(packagedScript).toContain('HVIR_SMOKE=1 \\')
    expect(packagedScript).toContain('HVIR_SMOKE_SCENARIO=platform-contracts \\')
    expect(packagedScript).toContain('grep -Fq "Preparing hvir $package_version"')
    expect(packagedScript).toContain('run_launcher >"$second_launch_log"')
    expect(packagedScript).not.toContain('HVIR_SMOKE_SCENARIO=legacy-workflow')
    expect(packagedScript).not.toContain('find dist/npm')
  })

  it('enters capacity before unrelated legacy profile and viewer assertions', () => {
    const branch = smokeWorkflow.indexOf("if (mode === 'capacity')")
    expect(branch).toBeGreaterThan(-1)
    expect(branch).toBeLessThan(smokeWorkflow.indexOf('const profileSmoke'))
    expect(branch).toBeLessThan(smokeWorkflow.indexOf('const viewerStatus'))
    expect(smokeWorkflow.indexOf("if (mode === 'capacity')", branch + 1)).toBe(-1)
    expect(capacityScenario).toContain('const CPU_SAMPLE_COUNT = 3')
    expect(capacityScenario).toContain('const TERMINAL_READINESS_SAMPLE_COUNT = 10')
    expect(capacityScenario).toContain('[smoke:capacity:contracts]')
    expect(capacityScenario).toContain('[smoke:performance:evidence]')
    expect(capacityScenario).toContain(
      'controlled capacity performance gate requires a clean checkout',
    )
    expect(capacityScenario).not.toContain('idleCpu.ratio > 1.5')
    expect(capacityPerformancePolicy).toContain('idleRendererPlusGpuRatio: 1.5')
    expect(capacityPerformancePolicy).toContain('terminalReadinessP95Ratio: 2')
    expect(capacityScenario).toContain('cpu.aggregateChildren.toFixed(3)')
    expect(capacityTerminalScenario).toContain('JSON.stringify(current)')
    expect(capacityTerminalScenario).toContain('current.surfaces === expected')
    expect(capacityTerminalScenario).toContain('actionStartedAtMs.push(Date.now())')
    expect(capacityTerminalScenario).toContain('ready-input:%s')
    expect(capacityTerminalScenario).toContain('countOccurrences(output, marker) !== 1')
  })

  it('treats large-file frame latency as evidence beside a semantic preview contract', () => {
    expect(smokeWorkflow).toContain('first-frame evidence')
    expect(smokeWorkflow).toContain("meta.includes('preview')")
    expect(smokeWorkflow).not.toContain('large-file activation stalled paint')
  })

  it('waits for exact terminal focus instead of assuming a frame count', () => {
    const layoutFocusScenario = terminalPresentationScenario.slice(
      terminalPresentationScenario.indexOf(
        'async function verifyTerminalLayoutFocus',
      ),
      terminalPresentationScenario.indexOf(
        'async function verifyTerminalLaunchMenuOverflow',
      ),
    )
    expect(layoutFocusScenario).toContain("input.addEventListener('focus', finish)")
    expect(layoutFocusScenario).toContain('document.activeElement === input')
    expect(layoutFocusScenario).not.toContain(
      'requestAnimationFrame(() => requestAnimationFrame(resolve))',
    )
  })

  it('enters the viewer group before legacy work with semantic diagnostics', () => {
    const branch = smokeWorkflow.indexOf("if (mode === 'viewer-position')")
    const focusedScenario = viewerPositionScenario.slice(
      viewerPositionScenario.indexOf('export function verifySourceDiffPosition'),
    )
    expect(branch).toBeGreaterThan(-1)
    expect(branch).toBeLessThan(smokeWorkflow.indexOf('const profileSmoke'))
    expect(focusedScenario).toContain('JSON.stringify(snapshot())')
    expect(focusedScenario).toContain('requestAnimationFrame(painted)')
    expect(focusedScenario).toContain('root.isConnected')
    expect(focusedScenario).not.toContain('setTimeout(')
  })

  it('enters platform contracts before legacy work with bounded semantic snapshots', () => {
    const branch = smokeWorkflow.indexOf("mode === 'platform-contracts'")
    const platformScenario = readFileSync(
      new URL('../src/main/smoke/platform-contracts.ts', import.meta.url),
      'utf8',
    )
    expect(branch).toBeGreaterThan(-1)
    expect(branch).toBeLessThan(smokeWorkflow.indexOf('const profileSmoke'))
    expect(platformScenario).toContain('JSON.stringify(lastSnapshot)')
    expect(platformScenario).toContain('protocol.isProtocolHandled')
    expect(platformScenario).toContain('net.fetch(preview.url)')
    expect(platformScenario).toContain('supervisor.list()')
    expect(platformScenario).not.toContain('requestAnimationFrame')
  })

  it('documents every selectable group and the aggregate result behavior', () => {
    for (const scenario of ELECTRON_SMOKE_SCENARIOS) {
      expect(contributing).toContain(`\`${scenario}\``)
    }
    expect(contributing).toMatch(/reports a result for\s+every scheduled group/)
  })
})
